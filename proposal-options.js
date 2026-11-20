// Proposal options: one proposal can offer several choices, for example a 1-week, 2-week or 3-week finish,
// or a whole project versus one building. Each option has its own priced lines (quantity x price per unit),
// so the client sees units, price per unit and amount, and picks one option on the public page.
// Prices stay editable until the client accepts. Every change is kept in estimate_option_changes.
// Staff edit options on the estimate. The public page reads them and records the chosen option.

const LOCKED = ['Approved', 'Declined', 'Withdrawn', 'Superseded'];
const SCOPES = ['Whole project', 'Per building'];
const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
const round2 = n => Math.round(Number(n || 0) * 100) / 100;

// Options with their lines and totals. `total` is the subtotal of the lines, before the estimate's tax.
function optionsFor(db, estimateId) {
  const opts = db.prepare('SELECT * FROM estimate_options WHERE estimate_id=? ORDER BY position, id').all(estimateId);
  const lines = db.prepare('SELECT * FROM estimate_option_lines WHERE option_id=? ORDER BY position, id');
  return opts.map(o => {
    const ls = lines.all(o.id).map(l => ({ id: l.id, description: l.description, unit: l.unit || '', quantity: l.quantity, unit_price: l.unit_price, amount: round2(l.quantity * l.unit_price) }));
    const total = round2(ls.reduce((s, l) => s + l.amount, 0));
    // Internal cost of delivering this option (staff only). The margin is checked on the option's own subtotal.
    const cost = o.cost == null ? null : num(o.cost);
    const margin_pct = cost > 0 && total > 0 ? Math.round((total - cost) / total * 1000) / 10 : null;
    return { id: o.id, label: o.label, duration_weeks: o.duration_weeks, scope_kind: o.scope_kind, building: o.building || '', lines: ls, total, cost, margin_pct };
  });
}

// What the estimate's proposal total becomes for an option subtotal (tax applied the same way as the estimate).
function totalWithTax(e, subtotal) { return round2(subtotal * (1 + num(e.tax_pct) / 100)); }

// Text that feeds the approval fingerprint. Empty when there are no options, so existing approvals stay valid.
function signature(db, estimateId) {
  const o = optionsFor(db, estimateId);
  if (!o.length) return '';
  return JSON.stringify(o.map(x => [x.id, x.label, x.duration_weeks, x.scope_kind, x.building, x.cost, x.lines.map(l => [l.description, l.unit, l.quantity, l.unit_price])]));
}

module.exports = (app, { db, auth, logAction, clean }) => {
  db.exec(`CREATE TABLE IF NOT EXISTS estimate_options(
    id INTEGER PRIMARY KEY AUTOINCREMENT, estimate_id INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0,
    label TEXT NOT NULL, duration_weeks INTEGER, scope_kind TEXT NOT NULL DEFAULT 'Whole project', building TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS estimate_option_lines(
    id INTEGER PRIMARY KEY AUTOINCREMENT, option_id INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0,
    description TEXT NOT NULL, unit TEXT, quantity REAL NOT NULL DEFAULT 0, unit_price REAL NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS estimate_option_changes(
    id INTEGER PRIMARY KEY AUTOINCREMENT, estimate_id INTEGER NOT NULL, option_id INTEGER, description TEXT,
    field TEXT NOT NULL, old_value TEXT, new_value TEXT, reason TEXT, actor TEXT, changed_at TEXT NOT NULL);`);
  try { db.exec('ALTER TABLE estimates ADD COLUMN selected_option_id INTEGER'); } catch (e) { /* column already exists */ }
  try { db.exec('ALTER TABLE estimate_options ADD COLUMN cost REAL'); } catch (e) { /* column already exists */ }

  const who = req => (req.user && req.user.email) || 'staff';
  const now = () => new Date().toISOString();

  function record(estimateId, optionId, description, field, oldValue, newValue, reason, actor, at) {
    db.prepare('INSERT INTO estimate_option_changes(estimate_id,option_id,description,field,old_value,new_value,reason,actor,changed_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(estimateId, optionId || null, description || null, field, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), reason || null, actor, at);
  }

  // Keeps the estimate's total in step with the options: the chosen option's total, or the lowest option until one is chosen.
  function syncTotal(estimateId) {
    const e = db.prepare('SELECT * FROM estimates WHERE id=?').get(estimateId);
    const opts = optionsFor(db, estimateId);
    if (!e || !opts.length) return;
    const chosen = opts.find(o => o.id === e.selected_option_id);
    const pick = chosen || opts.slice().sort((a, b) => a.total - b.total)[0];
    db.prepare('UPDATE estimates SET proposal_total=?, selected_option_id=?, updated_at=? WHERE id=?')
      .run(totalWithTax(e, pick.total), chosen ? chosen.id : null, now(), estimateId);
  }

  // Staff: the options for an estimate, with lines and totals.
  app.get('/api/admin/estimates/:id/options', auth, (req, res) => {
    const e = db.prepare('SELECT id,selected_option_id,status,tax_pct FROM estimates WHERE id=?').get(Number(req.params.id));
    if (!e) return res.status(404).json({ error: 'Not found' });
    res.json({ options: optionsFor(db, e.id), selected_option_id: e.selected_option_id || null, status: e.status, locked: LOCKED.includes(e.status), scopes: SCOPES });
  });

  // Staff: replace the options. Existing rows keep their ids so changes can be tracked.
  app.put('/api/admin/estimates/:id/options', auth, (req, res) => {
    const id = Number(req.params.id);
    const e = db.prepare('SELECT * FROM estimates WHERE id=?').get(id);
    if (!e) return res.status(404).json({ error: 'Not found' });
    if (LOCKED.includes(e.status) || e.decision_ip) return res.status(409).json({ error: `This proposal is ${e.status.toLowerCase()}. Duplicate it to make changes.` });
    const body = req.body || {};
    const reason = clean(body.reason, 300);
    const list = Array.isArray(body.options) ? body.options : null;
    if (!list) return res.status(400).json({ error: 'Send the options list.' });
    if (list.length > 10) return res.status(400).json({ error: 'Up to 10 options per proposal.' });
    const clean_ = [];
    for (const o of list) {
      const label = clean(o.label, 120);
      if (!label) return res.status(400).json({ error: 'Each option needs a name, for example "2-week finish" or "Building A".' });
      const scope = SCOPES.includes(o.scope_kind) ? o.scope_kind : 'Whole project';
      const weeks = o.duration_weeks === '' || o.duration_weeks == null ? null : Math.trunc(num(o.duration_weeks));
      if (weeks !== null && (weeks < 1 || weeks > 52)) return res.status(400).json({ error: 'Duration must be 1 to 52 weeks.' });
      const ls = Array.isArray(o.lines) ? o.lines : [];
      if (!ls.length) return res.status(400).json({ error: `"${label}" needs at least one priced line.` });
      if (ls.length > 60) return res.status(400).json({ error: `"${label}" has more than 60 lines.` });
      const lines = ls.map(l => ({ id: l.id ? Number(l.id) : null, description: clean(l.description, 200), unit: clean(l.unit, 30), quantity: num(l.quantity), unit_price: num(l.unit_price) }));
      if (lines.some(l => !l.description)) return res.status(400).json({ error: `Every line in "${label}" needs a description.` });
      const cost = o.cost === '' || o.cost == null ? null : num(o.cost);
      clean_.push({ id: o.id ? Number(o.id) : null, label, scope, weeks, building: clean(o.building, 120), cost, lines });
    }
    const at = now(), actor = who(req);
    try {
      db.transaction(() => {
        const oldOpts = db.prepare('SELECT * FROM estimate_options WHERE estimate_id=?').all(id);
        const keep = new Set();
        clean_.forEach((o, oi) => {
          let row = o.id ? oldOpts.find(x => x.id === o.id) : null;
          if (row) {
            const pairs = [['label', row.label, o.label], ['duration_weeks', row.duration_weeks, o.weeks], ['scope_kind', row.scope_kind, o.scope], ['building', row.building || '', o.building], ['cost', row.cost, o.cost]];
            for (const [f, a, b] of pairs) if (String(a ?? '') !== String(b ?? '')) record(id, row.id, row.label, f, a, b, reason, actor, at);
            db.prepare('UPDATE estimate_options SET label=?,duration_weeks=?,scope_kind=?,building=?,cost=?,position=?,updated_at=? WHERE id=?')
              .run(o.label, o.weeks, o.scope, o.building || null, o.cost, oi, at, row.id);
          } else {
            const info = db.prepare('INSERT INTO estimate_options(estimate_id,position,label,duration_weeks,scope_kind,building,cost,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
              .run(id, oi, o.label, o.weeks, o.scope, o.building || null, o.cost, at, at);
            row = { id: info.lastInsertRowid, label: o.label };
            record(id, row.id, o.label, 'option added', null, o.label, reason, actor, at);
          }
          keep.add(row.id);
          // Lines
          const oldLines = db.prepare('SELECT * FROM estimate_option_lines WHERE option_id=?').all(row.id);
          const keepL = new Set();
          o.lines.forEach((l, li) => {
            const lr = l.id ? oldLines.find(x => x.id === l.id) : null;
            if (lr) {
              const pairs = [['description', lr.description, l.description], ['unit', lr.unit || '', l.unit], ['quantity', lr.quantity, l.quantity], ['unit_price', lr.unit_price, l.unit_price]];
              for (const [f, a, b] of pairs) if (String(a) !== String(b)) record(id, row.id, l.description, f, a, b, reason, actor, at);
              db.prepare('UPDATE estimate_option_lines SET description=?,unit=?,quantity=?,unit_price=?,position=? WHERE id=?').run(l.description, l.unit || null, l.quantity, l.unit_price, li, lr.id);
              keepL.add(lr.id);
            } else {
              const info = db.prepare('INSERT INTO estimate_option_lines(option_id,position,description,unit,quantity,unit_price) VALUES(?,?,?,?,?,?)').run(row.id, li, l.description, l.unit || null, l.quantity, l.unit_price);
              keepL.add(Number(info.lastInsertRowid));
              record(id, row.id, l.description, 'line added', null, `${l.quantity} ${l.unit || ''} at ${l.unit_price}`, reason, actor, at);
            }
          });
          for (const lr of oldLines) if (!keepL.has(lr.id)) {
            db.prepare('DELETE FROM estimate_option_lines WHERE id=?').run(lr.id);
            record(id, row.id, lr.description, 'line removed', `${lr.quantity} ${lr.unit || ''} at ${lr.unit_price}`, null, reason, actor, at);
          }
        });
        for (const or of oldOpts) if (!keep.has(or.id)) {
          db.prepare('DELETE FROM estimate_option_lines WHERE option_id=?').run(or.id);
          db.prepare('DELETE FROM estimate_options WHERE id=?').run(or.id);
          record(id, or.id, or.label, 'option removed', or.label, null, reason, actor, at);
        }
        if (e.selected_option_id && !keep.has(e.selected_option_id)) db.prepare('UPDATE estimates SET selected_option_id=NULL WHERE id=?').run(id);
        syncTotal(id);
      })();
    } catch (err) {
      return res.status(500).json({ error: 'The options could not be saved. Nothing was changed.' });
    }
    logAction(req, 'updated options', 'estimate', id, reason || 'options edited');
    const after = optionsFor(db, id);
    res.json({ options: after, resend_needed: ['Sent', 'Viewed'].includes(e.status), total: db.prepare('SELECT proposal_total FROM estimates WHERE id=?').get(id).proposal_total });
  });

  // Public: the options for a proposal (no internal notes or cost data).
  app.get('/api/proposal/:token/options', (req, res) => {
    const e = db.prepare('SELECT id,status,tax_pct,selected_option_id FROM estimates WHERE public_token=?').get(clean(req.params.token, 100));
    if (!e) return res.status(404).json({ error: 'Proposal not found.' });
    if (['Draft', 'Ready', 'Withdrawn', 'Superseded'].includes(e.status)) return res.json({ options: [], selected_option_id: null });
    const opts = optionsFor(db, e.id).map(o => ({ id: o.id, label: o.label, duration_weeks: o.duration_weeks, scope_kind: o.scope_kind, building: o.building, subtotal: o.total, total: totalWithTax(e, o.total), lines: o.lines.map(l => ({ description: l.description, unit: l.unit, quantity: l.quantity, unit_price: l.unit_price, amount: l.amount })) }));
    res.json({ options: opts, selected_option_id: e.selected_option_id || null, tax_pct: Number(e.tax_pct) || 0, locked: LOCKED.includes(e.status) });
  });

  // Runs before the existing respond route. When the client approves, the chosen option sets the proposal total
  // so the approval and any contract use that price. Declines and invalid choices are handled by the existing route.
  app.post('/api/proposal/:token/respond', (req, res, next) => {
    const b = req.body || {};
    if (b.decision !== 'approve') return next();
    const e = db.prepare('SELECT * FROM estimates WHERE public_token=?').get(clean(req.params.token, 100));
    if (!e || LOCKED.includes(e.status)) return next();
    const opts = optionsFor(db, e.id);
    if (!opts.length) return next();
    const pick = opts.find(o => o.id === Number(b.option_id));
    if (!pick) return res.status(400).json({ error: 'Choose one of the options before you approve.' });
    const at = now();
    db.prepare('UPDATE estimates SET selected_option_id=?, proposal_total=?, updated_at=? WHERE id=?').run(pick.id, totalWithTax(e, pick.total), at, e.id);
    db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES('customer','chose option','estimate',?,?,?)").run(e.id, pick.label, at);
    next();
  });
};

// The scope text a contract starts with: the proposal scope, plus the chosen option's lines when one is chosen.
function contractScope(db, e) {
  const base = e.scope || '';
  const chosen = optionsFor(db, e.id).find(o => o.id === Number(e.selected_option_id));
  if (!chosen) return base;
  const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lines = chosen.lines.map(l => `- ${l.description}: ${Number(l.quantity).toLocaleString('en-US')}${l.unit ? ' ' + l.unit : ''} at ${money(l.unit_price)} = ${money(l.amount)}`);
  return [base, `Pricing option chosen: ${chosen.label}`, ...lines, `Option subtotal ${money(chosen.total)}${Number(e.tax_pct) > 0 ? ' before tax' : ''}; contract value ${money(e.proposal_total)}.`].filter(Boolean).join('\n');
}

module.exports.contractScope = contractScope;
module.exports.optionsFor = optionsFor;
module.exports.signature = signature;
module.exports.LOCKED = LOCKED;
