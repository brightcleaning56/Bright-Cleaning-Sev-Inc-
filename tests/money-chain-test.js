// One synthetic job through the money chain, checked to the cent:
// estimate -> proposal sent and approved -> contract countersigned -> project -> invoice with sales tax -> sent
// -> two payments -> refund -> ledger sync -> A/R tie-out, trial balance, job cost, and the customer-facing proposal total.
// Starts its own server on a temporary database. Run: node tests/money-chain-test.js
process.env.TZ = process.env.BUSINESS_TZ || 'America/Chicago';
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const bcrypt = require('bcryptjs');
const ROOT = path.join(__dirname, '..');
const PORT = 4700 + Math.floor(Math.random() * 50), B = `http://127.0.0.1:${PORT}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-money-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OWNER = 'owner@brightclean.test', PW = 'owner-password-1234';
const cents = n => Math.round(Number(n || 0) * 100);
const results = [];
const check = (what, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ' — ' + detail : ''}`); };

(async () => {
  const { SMTPServer } = require('smtp-server');
  const SMTP_PORT = 2900 + Math.floor(Math.random() * 50);
  const smtp = new SMTPServer({ authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], onAuth(a, s, cb) { cb(null, { user: a.username }); }, onData(stream, s, cb) { stream.resume(); stream.on('end', cb); } });
  await new Promise(r => smtp.listen(SMTP_PORT, '127.0.0.1', r));
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'staging', JWT_SECRET: crypto.randomBytes(40).toString('hex'), ADMIN_EMAIL: OWNER, ADMIN_PASSWORD_HASH: await bcrypt.hash(PW, 10), DATA_DIR: path.join(work, 'data'), UPLOAD_DIR: path.join(work, 'uploads'), SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT), SMTP_SECURE: 'false', SMTP_USER: 'walk', SMTP_PASS: 'walk', FROM_EMAIL: 'walk@brightclean.test', DISABLE_SCHEDULER: '1', DOTENV_CONFIG_PATH: '/nonexistent', PUBLIC_BASE_URL: 'https://brightclean.net', RATE_LIMIT_PUBLIC: '5000', INTAKE_RATE_LIMIT: '5000' };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  let fail = 0;
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/health')).ok) break; } catch { } await sleep(150); }
    const api = async (m, u, j, t) => { const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: j ? JSON.stringify(j) : undefined }); return { s: r.status, d: await r.json().catch(() => ({})) }; };
    const T = await require('./mfa-helper')((p, b, t) => api('POST', p, b, t).then(res => ({ data: res.d })))(OWNER, PW);
    await fetch(B + '/api/admin/company/w9', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T }, body: JSON.stringify({ file: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 test w-9').toString('base64') }) }); // the company W-9 goes with every invoice email
    await api('PUT', '/api/admin/approval-rules', { min_margin_pct: 0, max_total: 0, flag_pre_pricing: false, approve_all: false }, T);

    // 1. Estimate, sent and approved by the customer.
    const cu = await api('POST', '/api/admin/customers', { company: 'Money Co', name: 'MoNey', email: 'mo@money.test', phone: '515-555-0900' }, T);
    const e = (await api('POST', '/api/admin/estimates', { customer_name: 'Mo Money', company: 'Money Co', email: 'mo@money.test', scope: 'Office clean', labor_hours: 10, labor_rate: 20, margin_pct: 40, supplies_cost: 50 }, T)).d.estimate;
    const send = await api('POST', `/api/admin/estimates/${e.id}/send`, null, T);
    check('Estimate is sent to the customer', send.s === 200, send.s + ' ' + JSON.stringify(send.d).slice(0, 120));
    const approve = await api('POST', `/api/proposal/${e.public_token}/respond`, null);
    const ok1 = await api('POST', `/api/proposal/${e.public_token}/respond`, { decision: 'approve', signer_name: 'Mo Money', signer_title: 'Owner', agree: true });
    check('Customer approves the proposal', ok1.s === 200, ok1.s + ' ' + JSON.stringify(ok1.d).slice(0, 120));
    const proposal = (await api('GET', '/api/admin/estimates/' + e.id, null, T)).d.estimate;
    const priceCents = cents(proposal.proposal_total);

    // 2. Contract: created from the approved proposal at the same value; countersigned; project created.
    const contracts = (await api('GET', '/api/admin/contracts2', null, T)).d.contracts || [];
    const con = contracts.find(c => c.estimate_id === e.id && c.parent_id == null);
    check('Contract is created from the approved proposal', !!con, con ? con.number : 'none');
    check('Contract value equals the proposal total to the cent', con && cents(con.value) === priceCents, con ? `${cents(con.value)} vs ${priceCents}` : '');
    await api('PATCH', '/api/admin/contracts2/' + con.id, { start_date: '2027-01-04', end_date: '2027-12-31' }, T);
    const cs = await api('POST', `/api/admin/contracts2/${con.id}/countersign`, { name: 'Test Owner' }, T);
    check('Owner countersigns; contract is Active', cs.s === 200 && cs.d.contract && cs.d.contract.status === 'Active', cs.s + ' ' + (cs.d.contract && cs.d.contract.status));
    check('Executed contract keeps a SHA-256 of the signed content', cs.d.contract && /^[0-9a-f]{64}$/.test(cs.d.contract.executed_hash || ''));
    const projects = (await api('GET', '/api/admin/projects', null, T)).d.projects || [];
    const proj = projects.find(p => p.contract_id === con.id);
    check('One project is linked to the contract', !!proj, proj ? 'project ' + proj.id : 'none');

    // 3. Invoice: amount + sales tax; sent; the balance includes the tax.
    const amount = 400, tax = 24;
    const inv = await api('POST', '/api/admin/invoices', { invoice_number: 'MONEY-1', project_id: proj.id, customer_name: 'Mo Money', company: 'Money Co', email: 'mo@money.test', amount, tax_amount: tax, due_date: '2027-02-15', status: 'Draft' }, T);
    const invId = inv.d.id || (inv.d.invoice && inv.d.invoice.id);
    check('Invoice is created on the project', !!invId, JSON.stringify(inv.d).slice(0, 120));
    const taxSet = await api('POST', `/api/admin/invoices/${invId}/tax`, { tax_amount: tax, billing_kind: 'arrears' }, T);
    check('Sales tax is set on the invoice before it is sent', taxSet.s === 200, taxSet.s + ' ' + JSON.stringify(taxSet.d).slice(0, 100));
    const sent = await api('POST', `/api/admin/invoices/${invId}/send`, null, T);
    check('Invoice is sent', sent.s === 200, sent.s + ' ' + JSON.stringify(sent.d).slice(0, 120));
    const billed = cents(amount) + cents(tax);

    // 4. Two payments, then a refund. Overpayment is refused.
    const over = await api('POST', `/api/admin/invoices/${invId}/payment`, { amount: 500 }, T);
    check('Payment larger than the balance is refused', over.s === 400, over.s + ' ' + (over.d.error || '').slice(0, 80));
    const p1 = await api('POST', `/api/admin/invoices/${invId}/payment`, { amount: 200, note: 'check 101' }, T);
    const p2 = await api('POST', `/api/admin/invoices/${invId}/payment`, { amount: 224, note: 'check 102' }, T);
    check('Two payments record; invoice is Paid in full (tax included)', p1.s === 200 && p2.s === 200 && p2.d.status === 'Paid', p2.d.status + ' paid ' + p2.d.paid_amount);
    const rf = await api('POST', `/api/admin/invoices/${invId}/refund`, { amount: 100, note: 'Customer credit for a missed window' }, T);
    check('Refund of 100 is recorded', rf.s < 300, rf.s + ' ' + JSON.stringify(rf.d).slice(0, 120));
    const invNow = ((await api('GET', '/api/admin/invoices', null, T)).d.invoices || []).find(x => x.id === invId);
    const paidNow = cents(invNow.paid_amount);
    check('Invoice paid amount after refund is 324.00', paidNow === 32400, (paidNow / 100).toFixed(2));
    check('Invoice owes 100.00 after refund (424.00 billed)', billed - paidNow === 10000, ((billed - paidNow) / 100).toFixed(2));

    // 5. Ledger: sync everything, then tie-outs.
    const sync = await api('POST', '/api/admin/ledger/sync', null, T);
    check('Ledger sync runs without errors', sync.s === 200 && !(sync.d.errors || []).length, sync.s + ' ' + JSON.stringify(sync.d.errors || []).slice(0, 120));
    const tb = (await api('GET', '/api/admin/ledger/trial-balance', null, T)).d;
    check('Trial balance balances (debits equal credits)', tb.balanced === true, JSON.stringify({ dr: tb.total_debit, cr: tb.total_credit }));
    const acct = code => ((tb.accounts || []).find(a => a.code === code) || {}).balance;
    check('Ledger A/R (1100) equals billed minus collected', cents(acct('1100')) === billed - paidNow, `${cents(acct('1100'))} vs ${billed - paidNow}`);
    check('Ledger cash (1000) equals the 324.00 collected after refund', cents(acct('1000')) === paidNow, `${cents(acct('1000'))} vs ${paidNow}`);
    check('Sales tax liability (2100) equals the 24.00 tax', cents(acct('2100')) === cents(tax), `${cents(acct('2100'))}`);
    check('Revenue (4000) excludes the tax', cents(acct('4000')) === cents(amount), `${cents(acct('4000'))}`);
    const tie = (await api('GET', '/api/admin/receivables/tie-out', null, T)).d;
    check('A/R tie-out: customers owe what the ledger shows', tie.tied_out === true, JSON.stringify({ difference: tie.difference, unposted_invoices: tie.unposted_invoices, unposted_payments: tie.unposted_payments }));

    // 6. Job cost: invoiced, collected and contract-basis figures on the project.
    const jc = (await api('GET', `/api/admin/projects/${proj.id}/job-cost`, null, T)).d;
    check('Job cost shows invoiced as 424.00 (tax included)', cents(jc.actual && jc.actual.invoiced) === billed, JSON.stringify(jc.actual && jc.actual.invoiced));
    check('Job cost shows collected as 324.00 after the refund', cents(jc.actual && jc.actual.collected) === paidNow, JSON.stringify(jc.actual && jc.actual.collected));
    check('Job cost contract-basis value equals the proposal total', cents(jc.actual && jc.actual.contract_basis_value) === priceCents, JSON.stringify(jc.actual && jc.actual.contract_basis_value));
    check('Job cost does not present contract-basis profit as earned profit', jc.actual && jc.actual.earned_revenue === null);

    // 7. The customer's proposal page still shows the same total.
    const pv = (await api('GET', '/api/proposal/' + e.public_token, null)).d.proposal;
    check('Customer proposal total matches the contract value', pv && cents(pv.proposal_total) === priceCents, pv && pv.proposal_total);
  } catch (err) {
    fail++; console.log('ERROR ' + err.message);
  } finally {
    child.kill(); smtp.close();
    const failed = results.filter(x => !x).length + fail;
    console.log(`\n${results.length - failed}/${results.length} money-chain checks passed`);
    if (failed) process.exitCode = 1;
  }
})();
