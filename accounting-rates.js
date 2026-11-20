// Accounting rates the owner sets on the Accounting page: labor burden %, sales tax %, and the weekly overtime threshold.
// Until now these were settings with no screen. Each change is written to the audit trail and applies from the next posting
// or approval; figures already posted or approved keep what they had.
// Only an owner can change them (see ROLE_RULES in server.js); owners and managers can read them.

const RATES = {
  ledger_burden_pct: { label: 'Labor burden %', def: 0, min: 0, max: 100, step: 0.01,
    applies: 'Burden is posted with each approved time entry from now on. Entries already posted keep the burden they had.' },
  sales_tax_rate_pct: { label: 'Sales tax %', def: 6, min: 0, max: 20, step: 0.01,
    applies: 'Suggested on invoices issued from now on. Invoices already posted keep their tax.' },
  overtime_after_hours: { label: 'Overtime after (hours a week)', def: 40, min: 1, max: 168, step: 0.5,
    applies: 'Applies to time approved from now on. Time already approved keeps its cost.' },
};

function currentValue(db, key) {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    const v = Number(r && r.value);
    return r && r.value !== '' && Number.isFinite(v) ? v : RATES[key].def;
  } catch { return RATES[key].def; }
}

function listRates(db) {
  return Object.entries(RATES).map(([key, m]) => ({ key, label: m.label, value: currentValue(db, key), default: m.def, min: m.min, max: m.max, step: m.step, applies: m.applies }));
}

function setRate(db, key, raw, by) {
  const m = RATES[key];
  if (!m) throw new Error('Unknown rate.');
  const v = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  if (raw === '' || raw == null || !Number.isFinite(v) || v < m.min || v > m.max) throw new Error(`${m.label} must be between ${m.min} and ${m.max}.`);
  const before = currentValue(db, key), now = new Date().toISOString();
  db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(key, String(v), now);
  require('./audit').record(db, { actor: by, action: 'changed rate', entity: 'settings', entityId: null, detail: `${m.label}: ${before} to ${v}` });
  return { key, value: v, previous: before };
}

function mount(app, ctx) {
  const { db, auth } = ctx;
  app.get('/api/admin/ledger/rates', auth, (req, res) => res.json({ rates: listRates(db) }));
  app.post('/api/admin/ledger/rates', auth, (req, res) => {
    const b = req.body || {};
    try { const r = setRate(db, String(b.key || ''), b.value, req.user && req.user.email); res.json({ ok: true, ...r, rates: listRates(db) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
}

module.exports = { RATES, currentValue, listRates, setRate, mount };
