// Invoice delivery (audit MF-04/MF-05): invoice PDF, "Send invoice" by email with the PDF attached, and a
// contract check — the total billed against a contract may not exceed its value unless an owner/manager
// records why (e.g. an approved change order). Sending never marks anything paid. Every attempt is logged,
// and a failed send is reported as failed (the invoice stays Draft).
const { Doc } = require('./pdf');
module.exports = function mountInvoices(app, ctx) {
  const { db, auth, logAction, clean, adminEmail, getMailer } = ctx;
  const cols = db.prepare('PRAGMA table_info(invoices)').all().map(c => c.name);
  for (const [c, t] of [['sent_at', 'TEXT'], ['sent_to', 'TEXT'], ['send_count', 'INTEGER DEFAULT 0'], ['over_contract_reason', 'TEXT'], ['terms', 'TEXT']])
    if (!cols.includes(c)) db.exec(`ALTER TABLE invoices ADD COLUMN ${c} ${t}`);
  const now = () => new Date().toISOString(), today = () => require('./bizdate').today();
  const who = req => (req.user && req.user.email) || null;
  const roleOf = req => { const e = String(who(req) || '').toLowerCase(); if (!adminEmail || e === adminEmail.toLowerCase()) return 'owner'; const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e); return (r && r.role) || 'staff'; };
  const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const get = id => db.prepare('SELECT * FROM invoices WHERE id=?').get(Number(id));
  // Contract behind an invoice (through its project).
  const contractFor = inv => { if (!inv.project_id) return null; const p = db.prepare('SELECT contract_id FROM projects WHERE id=?').get(inv.project_id); return p && p.contract_id ? db.prepare('SELECT id, title, value, signature_status FROM contracts WHERE id=?').get(p.contract_id) : null; };
  function contractCheck(inv) {
    const k = contractFor(inv); if (!k || !(k.value > 0)) return { contract: k, ok: true };
    const billed = db.prepare("SELECT COALESCE(SUM(i.amount),0) v FROM invoices i JOIN projects p ON p.id=i.project_id WHERE p.contract_id=? AND i.status<>'Void' AND i.id<>?").get(k.id, inv.id).v;
    const total = Math.round((billed + Number(inv.amount || 0)) * 100) / 100;
    return { contract: k, billed_other: billed, total, ok: total <= k.value + 0.005 };
  }
  function pdf(inv) {
    const d = new Doc(), paid = Number(inv.paid_amount || 0), bal = Math.max(0, Number(inv.amount || 0) - paid), k = contractFor(inv);
    d.box(0, 742, 612, 50, '0.06 0.15 0.26'); d.y = 768; d.text('BRIGHT CLEANING SEV INC.', { size: 15, bold: true, color: '1 1 1' }); d.text('INVOICE', { size: 15, bold: true, color: '1 1 1', align: 'right' }); d.y = 752;
    d.text('Office +1 (515) 303-3024  |  Eric Moore, Owner: 469-267-8472  |  info@brightclean.net  |  brightclean.net', { size: 8, color: '0.8 0.88 0.95' }); d.y = 718;
    d.text(`Invoice ${inv.invoice_number}`, { size: 12, bold: true }); d.text(`Issued ${String(inv.issue_date || inv.sent_at || inv.created_at).slice(0, 10)}${inv.due_date ? '   Due ' + inv.due_date : ''}`, { size: 9, align: 'right' }); d.y -= 22;
    d.heading('Bill to', 11); d.para([inv.company, inv.customer_name, inv.email].filter(Boolean).join('\n') || '-');
    if (k) { d.heading('For', 11); d.para(`${k.title || 'Contract #' + k.id}`); }
    d.heading('Amount', 11);
    d.table([{ label: 'Description', w: 70 }, { label: 'Amount', w: 30, align: 'right' }], [[inv.notes ? String(inv.notes).split('\n')[0].slice(0, 90) : 'Cleaning services', money(inv.amount)], ['Payments received', '-' + money(paid)]]);
    d.gap(4); d.text('Balance due', { size: 13, bold: true }); d.text(money(bal), { size: 13, bold: true, align: 'right' }); d.y -= 22;
    d.heading('Payment', 11); d.para(inv.terms || 'Payment is due by the due date shown. Please reference the invoice number with your payment. Questions: office +1 (515) 303-3024.');
    d.footer(`Bright Cleaning Sev Inc. - Invoice ${inv.invoice_number}`);
    return d.toBuffer();
  }
  app.get('/api/admin/invoices/:id/pdf', auth, (req, res) => {
    const inv = get(req.params.id); if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${inv.invoice_number || 'invoice-' + inv.id}.pdf"`); res.send(pdf(inv));
  });
  app.get('/api/admin/invoices/:id/check', auth, (req, res) => {
    const inv = get(req.params.id); if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    res.json(contractCheck(inv));
  });
  app.post('/api/admin/invoices/:id/send', auth, async (req, res) => {
    const inv = get(req.params.id); if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    const b = req.body || {};
    if (inv.status === 'Void') return res.status(409).json({ error: 'This invoice is void and cannot be sent.' });
    if (inv.status === 'Paid') return res.status(409).json({ error: 'This invoice is already paid.' });
    if (!(Number(inv.amount) > 0)) return res.status(400).json({ error: 'The invoice amount must be greater than $0.' });
    if (!inv.due_date) return res.status(400).json({ error: 'Set a due date before sending.' });
    const to = clean(b.to, 254) || inv.email || (inv.customer_id && (db.prepare('SELECT email FROM customers WHERE id=?').get(inv.customer_id) || {}).email) || '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'Add the customer’s billing email before sending.' });
    const chk = contractCheck(inv);
    if (!chk.ok) {
      const reason = clean(b.over_contract_reason, 500);
      if (!reason) return res.status(409).json({ error: `Total billed on this contract would be ${money(chk.total)}, above the contract value of ${money(chk.contract.value)}. Bill an approved change order, or (owner/manager) give the reason to send anyway.`, check: chk });
      if (!['owner', 'manager'].includes(roleOf(req))) return res.status(403).json({ error: 'Only an owner or manager can bill above the contract value.' });
      db.prepare('UPDATE invoices SET over_contract_reason=? WHERE id=?').run(reason, inv.id);
    }
    const m = getMailer && getMailer(); if (!m) return res.status(503).json({ error: 'Email is not set up, so the invoice was not sent.' });
    try {
      await m.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER || adminEmail, to, subject: `Invoice ${inv.invoice_number} from Bright Cleaning Sev Inc. — ${money(Math.max(0, inv.amount - (inv.paid_amount || 0)))} due ${inv.due_date}`,
        text: `Hello${inv.customer_name ? ' ' + inv.customer_name : ''},\n\nPlease find invoice ${inv.invoice_number} attached.\nAmount: ${money(inv.amount)}\nBalance due: ${money(Math.max(0, inv.amount - (inv.paid_amount || 0)))}\nDue date: ${inv.due_date}\n\nThank you for your business.\nBright Cleaning Sev Inc.\nOffice +1 (515) 303-3024 · Eric Moore (Owner) 469-267-8472`,
        attachments: [{ filename: `${inv.invoice_number || 'invoice'}.pdf`, content: pdf(inv), contentType: 'application/pdf' }] });
    } catch (e) {
      logAction(req, 'invoice send FAILED', 'invoice', inv.id, `${inv.invoice_number} to ${to}: ${e.message}`);
      return res.status(502).json({ error: `The invoice email could not be sent (${e.message}). The invoice was not marked as sent.` });
    }
    const t = now(), resend = !!inv.sent_at;
    db.prepare("UPDATE invoices SET status=CASE WHEN status IN ('Draft') THEN 'Sent' ELSE status END, sent_at=COALESCE(sent_at,?), sent_to=?, send_count=COALESCE(send_count,0)+1, email=COALESCE(NULLIF(email,''),?), issue_date=COALESCE(issue_date,?) WHERE id=?").run(t, to, to, today(), inv.id);
    logAction(req, resend ? 'resent invoice' : 'sent invoice', 'invoice', inv.id, `${inv.invoice_number} ${money(inv.amount)} to ${to}${chk.ok ? '' : ' (above contract value — reason recorded)'}`);
    res.json({ ok: true, to, resend, invoice: get(inv.id) });
  });
};
