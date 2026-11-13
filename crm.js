// Customers CRM: multiple contacts and properties per customer, structured internal notes (author + time),
// account status/owner, and one profile endpoint that gathers every related record with separated financials.
// Notes are internal only: no customer-facing page or email reads this table.
module.exports = function mountCRM(app, ctx) {
  const { db, auth, logAction, clean, isEmail, adminEmail } = ctx;
  const now = () => new Date().toISOString();
  const who = req => (req.user && req.user.email) || null;
  const cols = db.prepare('PRAGMA table_info(customers)').all().map(c => c.name);
  for (const [c, t] of [['status', "TEXT NOT NULL DEFAULT 'Active'"], ['account_owner', 'TEXT'], ['customer_type', 'TEXT'], ['industry', 'TEXT'], ['tax_id', 'TEXT']])
    if (!cols.includes(c)) db.exec(`ALTER TABLE customers ADD COLUMN ${c} ${t}`);
  db.exec(`
  CREATE TABLE IF NOT EXISTS customer_contacts(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, name TEXT NOT NULL, title TEXT, email TEXT, phone TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0, can_sign INTEGER NOT NULL DEFAULT 0, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS contacts_cust ON customer_contacts(customer_id);
  CREATE TABLE IF NOT EXISTS customer_properties(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, name TEXT NOT NULL, address TEXT, property_type TEXT,
    units INTEGER, square_feet REAL, access_notes TEXT, status TEXT NOT NULL DEFAULT 'Active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS props_cust ON customer_properties(customer_id);
  CREATE TABLE IF NOT EXISTS customer_notes(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, category TEXT NOT NULL DEFAULT 'General', body TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0, author TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS notes_cust ON customer_notes(customer_id);`);
  // Every customer's stored person becomes its primary contact (existing customers now, new ones on first open).
  const ensureContact = c => { if ((c.name || c.email) && !db.prepare('SELECT 1 FROM customer_contacts WHERE customer_id=?').get(c.id))
    db.prepare('INSERT INTO customer_contacts(customer_id,name,email,phone,is_primary,created_at,updated_at) VALUES(?,?,?,?,1,?,?)').run(c.id, c.name || c.email, c.email || '', c.phone || '', now(), now()); };
  db.prepare('SELECT * FROM customers').all().forEach(ensureContact);

  const STATUSES = ['Prospect', 'Active', 'Inactive', 'Do not service'], NOTE_CATS = ['General', 'Site access', 'Billing', 'Sales', 'Service', 'Complaint follow-up'];
  const PROP_TYPES = ['Office', 'Multifamily', 'Construction site', 'Retail', 'Healthcare', 'School', 'Industrial', 'Other'];
  const getCust = id => db.prepare('SELECT * FROM customers WHERE id=?').get(Number(id));
  const roleOf = req => { const e = String(who(req) || '').toLowerCase(); if (!adminEmail || e === adminEmail.toLowerCase()) return 'owner'; const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e); return r ? r.role : 'staff'; };

  function profile(c) {
    ensureContact(c);
    const contacts = db.prepare('SELECT * FROM customer_contacts WHERE customer_id=? ORDER BY is_primary DESC, name').all(c.id);
    const emails = new Set([c.email, ...contacts.map(x => x.email)].filter(Boolean).map(e => e.toLowerCase()));
    const phones = new Set([c.phone, ...contacts.map(x => x.phone)].filter(Boolean).map(p => String(p).replace(/\D/g, '').slice(-10)).filter(p => p.length >= 7));
    const company = (c.company || '').toLowerCase().trim();
    const mine = (e, co) => (e && emails.has(String(e).toLowerCase())) || (company && String(co || '').toLowerCase().trim() === company);
    const leads = db.prepare(`SELECT id,kind,contact_name,company,email,project_name,service,status,created_at FROM leads WHERE kind<>'career'`).all().filter(x => mine(x.email, x.company));
    const est = db.prepare('SELECT id,customer_name,company,email,project_name,scope_category,proposal_total,total_cost,status,sent_at,viewed_at,decided_at,created_at FROM estimates').all().filter(x => mine(x.email, x.company));
    const eids = new Set(est.map(e => e.id));
    const contracts = db.prepare('SELECT * FROM contracts').all().filter(x => eids.has(x.estimate_id) || (company && String(x.company || '').toLowerCase().trim() === company));
    const kids = new Set(contracts.map(x => x.id));
    const projects = db.prepare('SELECT * FROM projects').all().filter(x => kids.has(x.contract_id) || (company && String(x.company || '').toLowerCase().trim() === company));
    const pids = new Set(projects.map(p => p.id));
    const invoices = db.prepare('SELECT * FROM invoices').all().filter(x => mine(x.email, x.company) || pids.has(x.project_id));
    // Complaint history: every case for this customer stays here after it leaves the Quality queue (open, resolved or closed).
    let complaints = []; try { complaints = db.prepare('SELECT id, status, severity, category, description, property, service_date, reported_at, response_due, resolved_at, closed_at, created_at, updated_at FROM quality_complaints WHERE customer_id=? ORDER BY id DESC').all(c.id); } catch { /* table is created by the quality module at startup */ }
    const iids = new Set(invoices.map(i => i.id));
    let payments = []; try { payments = db.prepare('SELECT * FROM payments ORDER BY received_at DESC').all().filter(p => iids.has(p.invoice_id)); } catch { /* no payments table */ }
    const calls = db.prepare('SELECT * FROM calls ORDER BY id DESC').all().filter(x => x.customer_id === c.id || (x.phone && phones.has(String(x.phone).replace(/\D/g, '').slice(-10))) || (company && String(x.company || '').toLowerCase().trim() === company));
    let mail = []; try { mail = db.prepare('SELECT id,to_addr,subject,body,status,error,created_at FROM email_log ORDER BY id DESC LIMIT 500').all().filter(m => String(m.to_addr || '').toLowerCase().split(/,\s*/).some(e => emails.has(e))); } catch { /* */ }
    const replies = [...emails].length ? db.prepare(`SELECT id,from_addr,from_name,subject,preview,received_at FROM inbox_messages WHERE LOWER(from_addr) IN (${[...emails].map(() => '?').join(',')}) ORDER BY received_at DESC LIMIT 500`).all(...emails) : [];
    const issues = db.prepare('SELECT * FROM customer_issues WHERE customer_id=? ORDER BY id DESC').all(c.id);
    const docs = db.prepare('SELECT id,title,kind,revision,file_name,file_url,size,analysis_status,created_at FROM documents WHERE customer_id=? OR project_id IN (' + ([...pids].join(',') || '0') + ') ORDER BY id DESC').all(c.id);
    const visits = db.prepare('SELECT * FROM visits WHERE customer_id=? OR project_id IN (' + ([...pids].join(',') || '0') + ') ORDER BY date DESC').all(c.id);
    const inspections = db.prepare('SELECT id,area,date,score,passed,project_id FROM inspections WHERE customer_id=? OR project_id IN (' + ([...pids].join(',') || '0') + ') ORDER BY date DESC').all(c.id);
    const sum = (a, f) => Math.round(a.reduce((t, x) => t + Number(f(x) || 0), 0) * 100) / 100;
    const liveInv = invoices.filter(i => i.status !== 'Void');
    const signed = contracts.filter(k => ['Signed', 'Executed', 'Fully signed'].includes(k.signature_status));
    const financials = {
      estimates: { value: sum(est.filter(e => ['Draft', 'Ready'].includes(e.status)), e => e.proposal_total), count: est.filter(e => ['Draft', 'Ready'].includes(e.status)).length },
      proposals_out: { value: sum(est.filter(e => ['Sent', 'Viewed'].includes(e.status)), e => e.proposal_total), count: est.filter(e => ['Sent', 'Viewed'].includes(e.status)).length },
      approved: { value: sum(est.filter(e => e.status === 'Approved'), e => e.proposal_total), count: est.filter(e => e.status === 'Approved').length },
      contracts_signed: { value: sum(signed, k => k.value), count: signed.length },
      contracts_unsigned: { value: sum(contracts.filter(k => !signed.includes(k)), k => k.value), count: contracts.length - signed.length },
      invoiced: { value: sum(liveInv, i => i.amount), count: liveInv.length },
      collected: { value: sum(liveInv, i => i.paid_amount), count: payments.length },
      outstanding: { value: sum(liveInv.filter(i => i.paid_amount < i.amount), i => i.amount - i.paid_amount), count: liveInv.filter(i => i.paid_amount < i.amount).length }
    };
    // Communication history: calls, emails and notes in one timeline.
    const notes = db.prepare('SELECT * FROM customer_notes WHERE customer_id=? ORDER BY pinned DESC, id DESC').all(c.id);
    const comms = [...calls.map(x => ({ type: 'call', at: x.created_at, title: `${x.direction} call · ${x.outcome}`, text: x.summary || '', by: x.created_by })),
      ...mail.map(x => ({ type: 'email', at: x.created_at, title: `Email: ${x.subject}`, text: `To ${x.to_addr}${x.status === 'failed' ? ' (failed)' : ''}`, by: 'system' })),
      ...replies.map(x => ({ type: 'reply', at: x.received_at, title: `Reply: ${x.subject || '(no subject)'}`, text: x.preview || '', by: x.from_name || x.from_addr })),
      ...notes.map(x => ({ type: 'note', at: x.created_at, title: `Note · ${x.category}`, text: x.body, by: x.author }))].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const ids = { lead: leads.map(x => x.id), estimate: [...eids], contract: [...kids], project: [...pids], invoice: [...iids] };
    const act = db.prepare(`SELECT * FROM audit_log WHERE (entity='customer' AND entity_id=?) OR (entity IN ('contact','property','customer note') AND details LIKE ?) ORDER BY id DESC LIMIT 200`).all(c.id, `%customer #${c.id}%`)
      .concat(...Object.entries(ids).map(([k, v]) => v.length ? db.prepare(`SELECT * FROM audit_log WHERE entity=? AND entity_id IN (${v.join(',')}) ORDER BY id DESC LIMIT 100`).all(k) : []))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 200);
    return { customer: c, complaints, contacts, properties: db.prepare('SELECT * FROM customer_properties WHERE customer_id=? ORDER BY status, name').all(c.id), notes, calls, emails: mail, replies, issues,
      leads, estimates: est.filter(e => ['Draft', 'Ready'].includes(e.status)), proposals: est.filter(e => !['Draft', 'Ready'].includes(e.status)), contracts, projects, invoices, payments, documents: docs, visits, inspections,
      financials, communications: comms, activity: act, options: { statuses: STATUSES, note_categories: NOTE_CATS, property_types: PROP_TYPES }, role: null };
  }
  app.get('/api/admin/customers/:id/profile', auth, (req, res) => {
    const c = getCust(req.params.id); if (!c) return res.status(404).json({ error: 'Customer not found.' });
    const p = profile(c); p.role = roleOf(req); p.users = db.prepare('SELECT email FROM admin_users ORDER BY email').all().map(u => u.email).concat(adminEmail ? [adminEmail] : []).filter((v, i, a) => a.indexOf(v) === i);
    res.json(p);
  });
  app.get('/api/admin/customers/:id/links', auth, (req, res) => {
    const c = getCust(req.params.id); if (!c) return res.status(404).json({ error: 'Customer not found.' });
    const p = profile(c);
    res.json({ contacts: p.contacts.map(k => ({ id: k.id, name: k.name, phone: k.phone, email: k.email, is_primary: k.is_primary })), properties: p.properties.map(x => ({ id: x.id, name: x.name, address: x.address, status: x.status })), projects: p.projects.map(x => ({ id: x.id, name: x.name, status: x.status })) });
  });
  // Account fields (status, owner, type, industry, tax ID) with validation and an audit trail of what changed.
  app.patch('/api/admin/customers/:id/account', auth, (req, res) => {
    const c = getCust(req.params.id); if (!c) return res.status(404).json({ error: 'Customer not found.' });
    const b = req.body || {}, set = {}, errs = [];
    if ('status' in b) { if (!STATUSES.includes(b.status)) errs.push('Choose a valid status.'); else set.status = b.status; }
    for (const k of ['account_owner', 'customer_type', 'industry', 'tax_id', 'name', 'company', 'phone', 'address']) if (k in b) set[k] = clean(b[k], 300);
    if ('email' in b) { if (b.email && !isEmail(b.email)) errs.push('Enter a valid email address.'); else set.email = clean(b.email, 254); }
    if (set.company !== undefined && set.company) { const d = db.prepare('SELECT id FROM customers WHERE lower(company)=lower(?) AND id<>?').get(set.company, c.id); if (d) errs.push(`Another customer (#${d.id}) already uses that company name.`); }
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const changed = Object.keys(set).filter(k => String(set[k] ?? '') !== String(c[k] ?? ''));
    if (changed.length) {
      db.prepare(`UPDATE customers SET ${changed.map(k => k + '=?').join(',')}, updated_at=? WHERE id=?`).run(...changed.map(k => set[k]), now(), c.id);
      logAction(req, 'updated', 'customer', c.id, changed.map(k => `${k}: "${c[k] ?? ''}" → "${set[k]}"`).join('; ').slice(0, 1500));
    }
    res.json({ ok: true, changed });
  });

  // ---------- Contacts ----------
  function contactValidate(b, custId, selfId) {
    const out = {}, errs = [];
    if (!selfId || 'name' in b) { const n = clean(b.name, 150); if (!n) errs.push('Enter the contact name.'); else out.name = n; }
    if ('email' in b) { if (b.email && !isEmail(b.email)) errs.push('Enter a valid email address.'); else out.email = clean(b.email, 254); }
    for (const k of ['title', 'phone', 'notes']) if (k in b) out[k] = clean(b[k], k === 'notes' ? 2000 : 120);
    for (const k of ['is_primary', 'can_sign']) if (k in b) out[k] = b[k] ? 1 : 0;
    if (out.email) { const d = db.prepare('SELECT id FROM customer_contacts WHERE customer_id=? AND lower(email)=lower(?) AND id<>?').get(custId, out.email, selfId || 0); if (d) errs.push('This customer already has a contact with that email.'); }
    return { out, errs };
  }
  const setPrimary = (custId, id) => { db.prepare('UPDATE customer_contacts SET is_primary=CASE WHEN id=? THEN 1 ELSE 0 END WHERE customer_id=?').run(id, custId);
    const p = db.prepare('SELECT * FROM customer_contacts WHERE id=?').get(id); db.prepare('UPDATE customers SET name=?, email=COALESCE(NULLIF(?,\'\'),email), phone=COALESCE(NULLIF(?,\'\'),phone), updated_at=? WHERE id=?').run(p.name, p.email || '', p.phone || '', now(), custId); };
  app.post('/api/admin/customers/:id/contacts', auth, (req, res) => {
    const c = getCust(req.params.id); if (!c) return res.status(404).json({ error: 'Customer not found.' });
    ensureContact(c);
    const { out, errs } = contactValidate(req.body || {}, c.id, 0); if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const cols = Object.keys(out), t = now();
    const id = db.prepare(`INSERT INTO customer_contacts(customer_id,${cols.join(',')},created_at,updated_at) VALUES(?,${cols.map(() => '?').join(',')},?,?)`).run(c.id, ...cols.map(k => out[k]), t, t).lastInsertRowid;
    if (out.is_primary || !db.prepare('SELECT 1 FROM customer_contacts WHERE customer_id=? AND is_primary=1').get(c.id)) setPrimary(c.id, id);
    logAction(req, 'added', 'contact', id, `${out.name} to customer #${c.id}`);
    res.status(201).json({ id });
  });
  app.patch('/api/admin/customers/:id/contacts/:cid', auth, (req, res) => {
    const k = db.prepare('SELECT * FROM customer_contacts WHERE id=? AND customer_id=?').get(Number(req.params.cid), Number(req.params.id)); if (!k) return res.status(404).json({ error: 'Contact not found.' });
    const { out, errs } = contactValidate(req.body || {}, k.customer_id, k.id); if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const cols = Object.keys(out).filter(x => x !== 'is_primary');
    if (cols.length) db.prepare(`UPDATE customer_contacts SET ${cols.map(x => x + '=?').join(',')}, updated_at=? WHERE id=?`).run(...cols.map(x => out[x]), now(), k.id);
    if (out.is_primary) setPrimary(k.customer_id, k.id);
    logAction(req, 'updated', 'contact', k.id, `${k.name} (customer #${k.customer_id}): ${Object.keys(out).join(', ')}`);
    res.json({ ok: true });
  });
  app.delete('/api/admin/customers/:id/contacts/:cid', auth, (req, res) => {
    const k = db.prepare('SELECT * FROM customer_contacts WHERE id=? AND customer_id=?').get(Number(req.params.cid), Number(req.params.id)); if (!k) return res.status(404).json({ error: 'Contact not found.' });
    if (k.is_primary) return res.status(400).json({ error: 'Make another contact primary before removing this one.' });
    db.prepare('DELETE FROM customer_contacts WHERE id=?').run(k.id);
    logAction(req, 'removed', 'contact', k.id, `${k.name} from customer #${k.customer_id}`);
    res.json({ ok: true });
  });

  // ---------- Properties / service locations ----------
  function propValidate(b, selfId) {
    const out = {}, errs = [];
    if (!selfId || 'name' in b) { const n = clean(b.name, 200); if (!n) errs.push('Name the property or location.'); else out.name = n; }
    for (const k of ['address', 'access_notes']) if (k in b) out[k] = clean(b[k], k === 'access_notes' ? 3000 : 500);
    if ('property_type' in b) out.property_type = PROP_TYPES.includes(b.property_type) ? b.property_type : 'Other';
    if ('status' in b) out.status = ['Active', 'Inactive'].includes(b.status) ? b.status : 'Active';
    if ('units' in b) { const v = b.units === '' || b.units == null ? null : Math.trunc(Number(b.units)); if (v !== null && !(v >= 0 && v < 100000)) errs.push('Units must be a whole number.'); else out.units = v; }
    if ('square_feet' in b) { const v = b.square_feet === '' || b.square_feet == null ? null : Number(String(b.square_feet).replace(/,/g, '')); if (v !== null && !(v >= 0 && v < 1e8)) errs.push('Square feet must be a number.'); else out.square_feet = v; }
    return { out, errs };
  }
  app.post('/api/admin/customers/:id/properties', auth, (req, res) => {
    const c = getCust(req.params.id); if (!c) return res.status(404).json({ error: 'Customer not found.' });
    const { out, errs } = propValidate(req.body || {}, 0); if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    if (out.address && db.prepare('SELECT 1 FROM customer_properties WHERE customer_id=? AND lower(address)=lower(?)').get(c.id, out.address)) return res.status(409).json({ error: 'This customer already has a property at that address.' });
    const cols = Object.keys(out), t = now();
    const id = db.prepare(`INSERT INTO customer_properties(customer_id,${cols.join(',')},created_at,updated_at) VALUES(?,${cols.map(() => '?').join(',')},?,?)`).run(c.id, ...cols.map(k => out[k]), t, t).lastInsertRowid;
    logAction(req, 'added', 'property', id, `${out.name} to customer #${c.id}`);
    res.status(201).json({ id });
  });
  app.patch('/api/admin/customers/:id/properties/:pid', auth, (req, res) => {
    const p = db.prepare('SELECT * FROM customer_properties WHERE id=? AND customer_id=?').get(Number(req.params.pid), Number(req.params.id)); if (!p) return res.status(404).json({ error: 'Property not found.' });
    const { out, errs } = propValidate(req.body || {}, p.id); if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const cols = Object.keys(out);
    if (cols.length) db.prepare(`UPDATE customer_properties SET ${cols.map(x => x + '=?').join(',')}, updated_at=? WHERE id=?`).run(...cols.map(x => out[x]), now(), p.id);
    logAction(req, 'updated', 'property', p.id, `${p.name} (customer #${p.customer_id}): ${cols.join(', ')}`);
    res.json({ ok: true });
  });

  // ---------- Internal notes ----------
  app.post('/api/admin/customers/:id/notes', auth, (req, res) => {
    const c = getCust(req.params.id); if (!c) return res.status(404).json({ error: 'Customer not found.' });
    const body = clean((req.body || {}).body, 5000); if (!body) return res.status(400).json({ error: 'Write the note first.' });
    const cat = NOTE_CATS.includes(req.body.category) ? req.body.category : 'General', t = now();
    const id = db.prepare('INSERT INTO customer_notes(customer_id,category,body,pinned,author,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(c.id, cat, body, req.body.pinned ? 1 : 0, who(req), t, t).lastInsertRowid;
    logAction(req, 'added', 'customer note', id, `${cat} note on customer #${c.id}`);
    res.status(201).json({ note: db.prepare('SELECT * FROM customer_notes WHERE id=?').get(id) });
  });
  app.patch('/api/admin/customers/:id/notes/:nid', auth, (req, res) => {
    const n = db.prepare('SELECT * FROM customer_notes WHERE id=? AND customer_id=?').get(Number(req.params.nid), Number(req.params.id)); if (!n) return res.status(404).json({ error: 'Note not found.' });
    if (n.author !== who(req) && roleOf(req) !== 'owner') return res.status(403).json({ error: 'Only the author or an owner can edit this note.' });
    const b = req.body || {}, set = {};
    if ('body' in b) { const v = clean(b.body, 5000); if (!v) return res.status(400).json({ error: 'A note cannot be empty.' }); set.body = v; }
    if ('pinned' in b) set.pinned = b.pinned ? 1 : 0;
    if ('category' in b && NOTE_CATS.includes(b.category)) set.category = b.category;
    const cols = Object.keys(set);
    if (cols.length) db.prepare(`UPDATE customer_notes SET ${cols.map(x => x + '=?').join(',')}, updated_at=? WHERE id=?`).run(...cols.map(x => set[x]), now(), n.id);
    logAction(req, 'edited', 'customer note', n.id, `customer #${n.customer_id}: ${cols.join(', ')}${set.body ? ` (was: "${n.body.slice(0, 200)}")` : ''}`);
    res.json({ ok: true });
  });

  // ---------- Send email to a customer contact (logged in Email Center and on the profile) ----------
  app.post('/api/admin/customers/:id/email', auth, async (req, res) => {
    const c = getCust(req.params.id); if (!c) return res.status(404).json({ error: 'Customer not found.' });
    const b = req.body || {}, to = clean(b.to, 254), subject = clean(b.subject, 200), body = clean(b.body, 10000);
    const allowed = new Set([c.email, ...db.prepare('SELECT email FROM customer_contacts WHERE customer_id=?').all(c.id).map(x => x.email)].filter(Boolean).map(e => e.toLowerCase()));
    if (!to || !allowed.has(to.toLowerCase())) return res.status(400).json({ error: 'Choose one of this customer\'s contacts.' });
    if (!subject || !body) return res.status(400).json({ error: 'Write a subject and a message.' });
    const m = ctx.getMailer(); if (!m) return res.status(503).json({ error: 'Email is not set up yet.' });
    try { await m.sendMail({ from: process.env.FROM_EMAIL || 'info@brightclean.net', to, subject, text: body }); }
    catch (e) { return res.status(502).json({ error: 'Email could not be sent: ' + e.message }); }
    logAction(req, 'emailed', 'customer', c.id, `${to}: ${subject}`);
    res.json({ ok: true });
  });
  return { profile };
};
