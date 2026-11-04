// Bright Clean V5 operations: customer directory, automation settings and scheduler,
// database backups, health checks and quote templates.
const fs = require('fs');
const path = require('path');

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/;
const isEmail = v => EMAIL_RE.test(String(v || '').trim()) && String(v).trim().length <= 254;

const DEFAULT_SETTINGS = {
  auto_proposal_reminders: '0',   // opt-in
  auto_invoice_reminders: '0',    // opt-in
  auto_handoff: '1',              // approved proposal -> draft contract + planning project (owner signed off)
  auto_backup: '1'                // daily local database backup
};

const TEMPLATES = [
  ['commercial-janitorial', 'Commercial janitorial (recurring)', 'Recurring janitorial service for occupied commercial space.\n\nIncluded: trash and recycling removal, restroom cleaning and restocking, dusting of horizontal surfaces, kitchen/break room wipe-down, vacuuming carpeted areas, damp mopping hard floors, entry glass spot cleaning.\n\nFrequency: [days per week]\nAreas: [list areas / square footage]\nExcluded: high dusting above 8 ft, carpet extraction, floor refinishing, window washing (quoted separately).', 'Pricing assumes the frequency and areas listed. Supplies included unless noted. Changes in scope are quoted in writing. Payment net 30.'],
  ['post-construction-final', 'Post-construction final cleaning', 'Final clean after construction, ready for owner turnover.\n\nIncluded: removal of construction dust from all surfaces, interior glass and frames, cabinets inside and out, fixtures and appliances, floors swept/vacuumed and mopped, restrooms detailed, labels and stickers removed.\n\nPhasing: [rough / final / touch-up]\nAreas: [floors / units / square footage]\nExcluded: debris haul-off beyond bagged trash, exterior windows above ground floor, paint or adhesive removal requiring specialty work.', 'Site must be construction-complete for the area being cleaned, with power, water and lighting available. Return visits for trades damage are billed separately. Payment per contract / pay application schedule.'],
  ['rough-cleaning', 'Rough / interim construction cleaning', 'Rough clean during construction.\n\nIncluded: removal of loose debris to on-site dumpster, sweeping, dust removal from accessible surfaces.\n\nVisits: [number / frequency]\nAreas: [list]\nExcluded: final detail cleaning, dumpster supply and haul.', 'Dumpster and disposal by others unless listed. Work coordinated with the site superintendent.'],
  ['unit-turnover', 'Apartment unit turnover', 'Move-out / turnover cleaning for apartment units.\n\nIncluded: kitchen (appliances inside and out, cabinets, counters, sink), bathrooms (tub/shower, toilet, vanity, mirrors), floors, baseboards, interior windows and sills, closets, light fixtures and switch plates.\n\nUnits: [number / unit types]\nExcluded: carpet extraction, wall washing, painting, pest treatment.', 'Pricing per unit as listed. Units must be vacant with utilities on. Heavy-soil or damage conditions quoted separately.'],
  ['window-cleaning', 'Interior / exterior window cleaning', 'Window cleaning.\n\nIncluded: glass, frames and sills for the windows listed.\n\nScope: [interior / exterior / both]\nAccess: [ground / ladder / lift]\nExcluded: hard-water stain removal, screen repair, work requiring rope access unless listed.', 'Lift rental and access equipment included only if listed. Weather-dependent scheduling.'],
  ['power-washing', 'Power washing', 'Exterior pressure washing.\n\nIncluded: [sidewalks / building façade / dumpster pads / parking structures]\n\nArea: [square footage]\nExcluded: graffiti removal, sealing, oil-stain treatment unless listed.', 'Water source required on site. Surface suitability, drainage and environmental restrictions confirmed before work.']
];

module.exports = function mountOps(app, ctx) {
  const { db, auth, logAction, clean, getMailer, dataDir, version } = ctx;
  const now = () => new Date().toISOString();
  const baseUrl = () => (process.env.PUBLIC_BASE_URL || 'https://brightclean.net').replace(/\/+$/, '');

  // ---------------- Schema (idempotent) ----------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY AUTOINCREMENT, match_key TEXT UNIQUE NOT NULL, name TEXT, company TEXT, email TEXT, phone TEXT, address TEXT, source TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS automation_log(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref_id INTEGER, stage TEXT, sent_to TEXT, status TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS automation_log_ref ON automation_log(kind, ref_id, stage, status);
    CREATE TABLE IF NOT EXISTS quote_templates(key TEXT PRIMARY KEY, name TEXT NOT NULL, scope TEXT, terms TEXT, production_rate REAL, labor_rate REAL, updated_at TEXT);
  `);
  const invCols = db.prepare('PRAGMA table_info(invoices)').all().map(c => c.name);
  if (!invCols.includes('email')) db.exec('ALTER TABLE invoices ADD COLUMN email TEXT');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) db.prepare('INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES(?,?,?)').run(k, v, now());
  for (const [key, name, scope, terms] of TEMPLATES) db.prepare('INSERT OR IGNORE INTO quote_templates(key,name,scope,terms,updated_at) VALUES(?,?,?,?,?)').run(key, name, scope, terms, now());

  const getSetting = k => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : DEFAULT_SETTINGS[k]; };
  const isOn = k => getSetting(k) === '1';

  // Invoices: billing email must be valid when given (used for payment reminders).
  app.use('/api/admin/invoices', (req, res, next) => {
    if ((req.method === 'POST' || req.method === 'PATCH') && req.body && req.body.email && !isEmail(req.body.email)) return res.status(400).json({ error: 'Enter a valid billing email address.' });
    next();
  });

  // ---------------- Customer directory ----------------
  const matchKey = r => {
    const email = clean(r.email).toLowerCase();
    if (email) return 'e:' + email;
    const company = clean(r.company).toLowerCase();
    if (company) return 'c:' + company;
    return '';
  };
  function upsertCustomer(r, source) {
    try {
      const key = matchKey(r); if (!key) return null;
      const t = now();
      const company = clean(r.company).toLowerCase();
      // Match on email first, then on company name, so the same business is never listed twice.
      let existing = db.prepare('SELECT * FROM customers WHERE match_key=?').get(key);
      if (!existing && company) existing = db.prepare("SELECT * FROM customers WHERE lower(company)=? ORDER BY (email<>'') DESC, id LIMIT 1").get(company);
      if (existing && !existing.email && clean(r.email)) {
        const ek = 'e:' + clean(r.email).toLowerCase();
        if (!db.prepare('SELECT id FROM customers WHERE match_key=?').get(ek)) db.prepare('UPDATE customers SET email=?, match_key=? WHERE id=?').run(clean(r.email, 254).toLowerCase(), ek, existing.id);
      }
      if (existing) {
        db.prepare(`UPDATE customers SET name=COALESCE(NULLIF(name,''),?), company=COALESCE(NULLIF(company,''),?), phone=COALESCE(NULLIF(phone,''),?), address=COALESCE(NULLIF(address,''),?), updated_at=? WHERE id=?`)
          .run(clean(r.name, 180), clean(r.company, 200), clean(r.phone, 60), clean(r.address, 500), t, existing.id);
        return existing.id;
      }
      return db.prepare('INSERT INTO customers(match_key,name,company,email,phone,address,source,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(key, clean(r.name, 180), clean(r.company, 200), clean(r.email, 254).toLowerCase(), clean(r.phone, 60), clean(r.address, 500), source, '', t, t).lastInsertRowid;
    } catch (e) { console.error('Customer upsert failed:', e.message); return null; }
  }
  // Backfill from existing records (safe to repeat).
  db.prepare(`SELECT contact_name name, company, email, phone, address, kind FROM leads WHERE kind<>'career' ORDER BY id`).all().forEach(r => upsertCustomer(r, r.kind === 'bid' ? 'bid request' : 'website inquiry'));
  db.prepare('SELECT customer_name name, company, email, site_address address FROM estimates ORDER BY id').all().forEach(r => upsertCustomer(r, 'estimate'));

  const related = c => {
    const email = (c.email || '').toLowerCase(), company = (c.company || '').toLowerCase();
    const m = (e, co) => (email && (e || '').toLowerCase() === email) || (company && (co || '').toLowerCase() === company);
    const leads = db.prepare(`SELECT id,kind,contact_name,company,email,project_name,status,created_at FROM leads WHERE kind<>'career'`).all().filter(x => m(x.email, x.company));
    const proposals = db.prepare('SELECT id,customer_name,company,email,project_name,proposal_total,status,created_at FROM estimates').all().filter(x => m(x.email, x.company));
    const pids = new Set(proposals.map(p => p.id));
    const contracts = db.prepare('SELECT id,estimate_id,customer_name,company,title,value,status,created_at FROM contracts').all().filter(x => pids.has(x.estimate_id) || (company && (x.company || '').toLowerCase() === company));
    const cids = new Set(contracts.map(x => x.id));
    const projects = db.prepare('SELECT id,contract_id,customer_name,company,name,status,progress,due_date,created_at FROM projects').all().filter(x => cids.has(x.contract_id) || (company && (x.company || '').toLowerCase() === company));
    const invoices = db.prepare('SELECT id,customer_name,company,email,invoice_number,amount,paid_amount,status,due_date,created_at FROM invoices').all().filter(x => m(x.email, x.company));
    const live = invoices.filter(i => i.status !== 'Void');
    return { leads, proposals, contracts, projects, invoices, billed: live.reduce((s, i) => s + Number(i.amount || 0), 0), paid: live.reduce((s, i) => s + Number(i.paid_amount || 0), 0) };
  };

  app.get('/api/admin/customers', auth, (req, res) => {
    const rows = db.prepare('SELECT * FROM customers ORDER BY updated_at DESC').all();
    res.json({ customers: rows.map(c => ({ ...c, ...related(c) })) });
  });
  app.post('/api/admin/customers', auth, (req, res) => {
    const b = req.body || {};
    if (!clean(b.name) && !clean(b.company)) return res.status(400).json({ error: 'Enter a contact name or company.' });
    if (b.email && !isEmail(b.email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!b.email && !clean(b.company)) return res.status(400).json({ error: 'Enter an email or a company so the customer can be matched to their records.' });
    const key = matchKey(b);
    if (db.prepare('SELECT id FROM customers WHERE match_key=?').get(key)) return res.status(409).json({ error: 'A customer with that email or company already exists.' });
    { const dupe = (b.company && db.prepare('SELECT id FROM customers WHERE lower(trim(company))=lower(trim(?))').get(b.company)) || (b.email && db.prepare('SELECT id FROM customers WHERE lower(email)=lower(?)').get(b.email)); if (dupe) return res.status(409).json({ error: `A customer with that email or company already exists (#${dupe.id}).`, id: dupe.id }); }
    const id = upsertCustomer({ ...b }, 'added manually');
    if (b.notes) db.prepare('UPDATE customers SET notes=? WHERE id=?').run(clean(b.notes, 5000), id);
    logAction(req, 'created', 'customer', id, clean(b.company || b.name));
    res.status(201).json({ id });
  });
  app.patch('/api/admin/customers/:id', auth, (req, res) => {
    const b = req.body || {}, id = Number(req.params.id);
    const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const fields = ['name', 'company', 'phone', 'address', 'notes'].filter(k => k in b);
    if (!fields.length) return res.json({ ok: true });
    db.prepare(`UPDATE customers SET ${fields.map(f => f + '=?').join(',')}, updated_at=? WHERE id=?`).run(...fields.map(f => clean(b[f], f === 'notes' ? 5000 : 500)), now(), id);
    logAction(req, 'updated', 'customer', id);
    res.json({ ok: true });
  });
  app.delete('/api/admin/customers/:id', auth, (req, res) => {
    const c = db.prepare('SELECT * FROM customers WHERE id=?').get(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Not found' });
    const me = String((req.user && req.user.email) || '').toLowerCase(), owner = process.env.ADMIN_EMAIL || '';
    let role = me === owner.toLowerCase() ? 'owner' : 'staff'; try { const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(me); if (r && role !== 'owner') role = r.role; } catch { /* */ }
    if (role !== 'owner') return res.status(403).json({ error: 'Only an owner can remove a customer.' });
    const label = c.company || c.name || c.email || '';
    if (String((req.body || {}).confirm || '').trim().toLowerCase() !== String(label).trim().toLowerCase()) return res.status(400).json({ error: `To confirm, type the customer name exactly: ${label}` });
    const r = related(c);
    const linked = r.proposals.length + r.contracts.length + r.projects.length + r.invoices.length;
    if (linked) return res.status(409).json({ error: `This customer has ${linked} linked proposal, contract, project or invoice record(s). Set the status to Inactive instead, so history is preserved.` });
    try { db.prepare('DELETE FROM customer_contacts WHERE customer_id=?').run(c.id); db.prepare('DELETE FROM customer_properties WHERE customer_id=?').run(c.id); } catch { /* */ }
    const x = db.prepare('DELETE FROM customers WHERE id=?').run(c.id);
    logAction(req, 'deleted', 'customer', Number(req.params.id), 'directory entry only; related records kept');
    res.json({ ok: true });
  });

  // ---------------- Quote templates ----------------
  app.get('/api/admin/templates', auth, (req, res) => res.json({ templates: db.prepare('SELECT * FROM quote_templates ORDER BY name').all() }));

  // ---------------- Backups ----------------
  const backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const listBackups = () => fs.readdirSync(backupDir).filter(f => /^brightclean-\d{8}-\d{6}\.db$/.test(f)).sort().reverse()
    .map(f => { const st = fs.statSync(path.join(backupDir, f)); return { name: f, size: st.size, created_at: st.mtime.toISOString() }; });
  let backupRunning = false;
  async function runBackup(reason) {
    if (backupRunning) return null;
    backupRunning = true;
    try {
      const d = new Date(), p = n => String(n).padStart(2, '0');
      const name = `brightclean-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.db`;
      await db.backup(path.join(backupDir, name));
      const all = listBackups();
      for (const old of all.slice(14)) { try { fs.unlinkSync(path.join(backupDir, old.name)); } catch { /* ignore */ } }
      db.prepare('INSERT INTO automation_log(kind,ref_id,stage,sent_to,status,detail,created_at) VALUES(?,?,?,?,?,?,?)').run('backup', null, reason, null, 'ok', name, now());
      return name;
    } catch (e) {
      db.prepare('INSERT INTO automation_log(kind,ref_id,stage,sent_to,status,detail,created_at) VALUES(?,?,?,?,?,?,?)').run('backup', null, reason, null, 'failed', clean(e.message, 500), now());
      console.error('Backup failed:', e.message);
      return null;
    } finally { backupRunning = false; }
  }
  app.get('/api/admin/backups', auth, (req, res) => res.json({ backups: listBackups(), retention: 14, folder: 'data/backups' }));
  app.post('/api/admin/backups', auth, async (req, res) => {
    const name = await runBackup('manual');
    if (!name) return res.status(500).json({ error: 'Backup failed. Check the server log.' });
    logAction(req, 'created', 'backup', 0, name);
    res.status(201).json({ name });
  });
  app.get('/api/admin/backups/:name', auth, (req, res) => {
    const name = path.basename(req.params.name);
    if (!/^brightclean-\d{8}-\d{6}\.db$/.test(name)) return res.status(400).json({ error: 'Invalid backup name' });
    const p = path.join(backupDir, name);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
    logAction(req, 'downloaded', 'backup', 0, name);
    res.download(p);
  });

  // ---------------- Health ----------------
  const started = Date.now();
  const health = (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ ok: true, db: 'ok', uptime_s: Math.round((Date.now() - started) / 1000), version });
    } catch (e) { res.status(503).json({ ok: false, db: 'error' }); }
  };
  app.get('/health', health);
  app.get('/api/health', health);

  // ---------------- Automation ----------------
  const sentAlready = (kind, ref, stage) => !!db.prepare("SELECT id FROM automation_log WHERE kind=? AND ref_id=? AND stage=? AND status='sent'").get(kind, ref, stage);
  const log = (kind, ref, stage, to, status, detail) => db.prepare('INSERT INTO automation_log(kind,ref_id,stage,sent_to,status,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(kind, ref, stage, to, status, clean(detail, 1000), now());
  const days = ms => ms / 864e5;
  const money = v => '$' + Number(v || 0).toFixed(2);
  let lastRun = null, running = false;

  async function send(kind, ref, stage, to, subject, text) {
    const mailer = getMailer();
    if (!mailer) { log(kind, ref, stage, to, 'skipped', 'Email is not configured'); return false; }
    try {
      await mailer.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER, to, subject, text });
      log(kind, ref, stage, to, 'sent', subject);
      return true;
    } catch (e) { log(kind, ref, stage, to, 'failed', e.message); return false; }
  }

  async function runAutomations(atTime) {
    if (running) return { skipped: 'already running' };
    running = true;
    const t = atTime ? new Date(atTime) : new Date();
    const today = require('./bizdate').today(t); // business (Central) date — UTC would age reminders a day early every evening
    const result = { proposal_reminders: 0, invoice_reminders: 0, bid_deadline_alerts: 0, backup: null };
    try {
      // Bid deadline alerts (internal): open GC bid requests due within 3 days / tomorrow-or-today with no proposal sent yet.
      { const to = process.env.NOTIFY_EMAIL || process.env.ADMIN_EMAIL;
        if (to && isEmail(to)) {
          const rows = db.prepare("SELECT l.* FROM leads l WHERE l.kind='bid' AND l.bid_due_date IS NOT NULL AND l.bid_due_date<>'' AND l.status NOT IN ('Proposal Sent','Won','Lost','Archived') AND NOT EXISTS (SELECT 1 FROM estimates e WHERE e.lead_id=l.id AND e.status IN ('Sent','Viewed','Approved','Declined'))").all();
          for (const l of rows) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(l.bid_due_date)) continue;
            const diff = days(new Date(l.bid_due_date + 'T12:00:00Z') - new Date(today + 'T12:00:00Z'));
            const stage = diff < 0 ? 'missed' : diff <= 1 ? 'due1' : diff <= 3 ? 'due3' : null;
            if (!stage || sentAlready('bid_deadline', l.id, stage)) continue;
            if (stage === 'due3' && (sentAlready('bid_deadline', l.id, 'due1') || sentAlready('bid_deadline', l.id, 'missed'))) continue;
            if (stage === 'due1' && sentAlready('bid_deadline', l.id, 'missed')) continue;
            const label = stage === 'missed' ? `MISSED bid deadline (${l.bid_due_date})` : diff === 0 ? 'Bid due TODAY' : diff === 1 ? 'Bid due tomorrow' : `Bid due in ${diff} days`;
            const ok = await send('bid_deadline', l.id, stage, to, `${label}: ${l.project_name || 'bid request'} - ${l.company || l.contact_name || ''}`,
              `${label}.\n\nProject: ${l.project_name || '-'}\nGeneral contractor: ${l.company || '-'} (${l.contact_name || ''} ${l.email || ''} ${l.phone || ''})\nDue: ${l.bid_due_date}\nStatus: ${l.status}\n\nNo proposal has been sent yet. Open the lead: ${baseUrl()}/admin/#leads`);
            if (ok) result.bid_deadline_alerts++;
          }
        } }
      if (isOn('auto_proposal_reminders')) {
        const rows = db.prepare("SELECT * FROM estimates WHERE status IN ('Sent','Viewed') AND email IS NOT NULL AND email<>''").all();
        for (const e of rows) {
          if (e.expires_on && e.expires_on < today) continue;
          if (!isEmail(e.email)) continue;
          const last = new Date(e.last_viewed_at || e.viewed_at || e.sent_at || e.updated_at);
          const age = days(t - last);
          const stage = age >= 7 ? 'day7' : age >= 3 ? 'day3' : null;
          if (!stage || sentAlready('proposal_reminder', e.id, stage)) continue;
          if (stage === 'day3' && sentAlready('proposal_reminder', e.id, 'day7')) continue;
          const link = `${baseUrl()}/proposal/${e.public_token}`;
          const ok = await send('proposal_reminder', e.id, stage, e.email, `Following up: Bright Clean proposal for ${e.project_name || 'your project'}`,
            `Hello ${e.customer_name},\n\nWe wanted to follow up on the proposal we sent for ${e.project_name || 'your project'}.\n\nReview the proposal: ${link}\n\nIf you have questions or need changes to the scope, reply to this email or call 515-329-5889.\n\nBright Cleaning Sev Inc.`);
          if (ok) { result.proposal_reminders++; if (stage === 'day7' && !sentAlready('proposal_reminder', e.id, 'day3')) log('proposal_reminder', e.id, 'day3', e.email, 'sent', 'covered by day-7 reminder'); }
        }
      }
      if (isOn('auto_invoice_reminders')) {
        const rows = db.prepare("SELECT * FROM invoices WHERE status NOT IN ('Paid','Void','Draft') AND amount>paid_amount AND due_date IS NOT NULL AND due_date<>'' AND email IS NOT NULL AND email<>''").all();
        for (const i of rows) {
          if (!isEmail(i.email)) continue;
          const diff = days(new Date(i.due_date + 'T12:00:00Z') - new Date(today + 'T12:00:00Z'));
          const stage = diff <= -7 ? 'overdue7' : diff <= -1 ? 'overdue1' : (diff >= 0 && diff <= 3) ? 'due3' : null;
          if (!stage || sentAlready('invoice_reminder', i.id, stage)) continue;
          if (stage === 'due3' && (sentAlready('invoice_reminder', i.id, 'overdue1') || sentAlready('invoice_reminder', i.id, 'overdue7'))) continue;
          if (stage === 'overdue1' && sentAlready('invoice_reminder', i.id, 'overdue7')) continue;
          const bal = Number(i.amount) - Number(i.paid_amount || 0);
          const subject = stage === 'due3' ? `Reminder: invoice ${i.invoice_number} is due ${i.due_date}` : `Past due: invoice ${i.invoice_number}`;
          const ok = await send('invoice_reminder', i.id, stage, i.email, subject,
            `Hello ${i.customer_name || i.company || ''},\n\nThis is a reminder that invoice ${i.invoice_number} has a balance of ${money(bal)}${stage === 'due3' ? `, due ${i.due_date}` : `, which was due ${i.due_date}`}.\n\nIf you have already sent payment, thank you, and please disregard this message. For questions, reply to this email or call 515-329-5889.\n\nBright Cleaning Sev Inc.`);
          if (ok) result.invoice_reminders++;
        }
      }
      if (isOn('auto_backup')) {
        const latest = listBackups()[0];
        if (!latest || days(t - new Date(latest.created_at)) >= 0.95) result.backup = await runBackup('daily');
      }
    } finally { running = false; lastRun = { at: t.toISOString(), ...result }; }
    return result;
  }

  app.get('/api/admin/settings', auth, (req, res) => {
    const s = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value === '1']));
    res.json({
      settings: s, email_configured: !!getMailer(), public_base_url: baseUrl(), last_run: lastRun,
      schedule: 'Every hour while the server is running',
      log: db.prepare('SELECT * FROM automation_log ORDER BY id DESC LIMIT 50').all()
    });
  });
  app.put('/api/admin/settings', auth, (req, res) => {
    const b = req.body || {};
    const changed = [];
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in b) {
      const v = b[k] === true || b[k] === '1' || b[k] === 1 ? '1' : '0';
      db.prepare('UPDATE settings SET value=?,updated_at=? WHERE key=?').run(v, now(), k);
      changed.push(`${k}=${v === '1' ? 'on' : 'off'}`);
    }
    if (changed.length) logAction(req, 'changed settings', 'automation', 0, changed.join(', '));
    res.json({ ok: true });
  });
  app.post('/api/admin/automation/run', auth, async (req, res) => {
    // An optional date lets staging tests simulate a future day; production always uses the real clock.
    const at = process.env.NODE_ENV !== 'production' && req.body && req.body.at ? req.body.at : undefined;
    const r = await runAutomations(at);
    logAction(req, 'ran', 'automation', 0, JSON.stringify(r));
    res.json({ ok: true, result: r });
  });

  if (!process.env.DISABLE_SCHEDULER) {
    setTimeout(() => runAutomations().catch(e => console.error('Automation error:', e.message)), 60 * 1000).unref();
    setInterval(() => runAutomations().catch(e => console.error('Automation error:', e.message)), 60 * 60 * 1000).unref();
  }

  return { upsertCustomer, isOn, isEmail, baseUrl };
};
module.exports.isEmail = v => EMAIL_RE.test(String(v || '').trim()) && String(v).trim().length <= 254;
