// One place that says what a contract is worth, for the financial reports. Phase 2 of the accounting plan.
// Today several screens add up every contract row. Amendments, renewals and superseded versions are separate rows,
// so those sums can count the same work twice. This module reports each figure with its parts, and changes no dashboard.
//
// Counting rule used for the report (the owner still has to confirm it):
//   - Contracted value = signed original contracts (kind Contract) plus signed renewals, excluding superseded versions and archived rows.
//   - Amendments are listed separately and are not added, because their value may already be inside the contract they change.
//   - Dashboard figure = what the screens add today (every signed row, no exclusions). The gap is shown so the owner can see it.

const SIGNED = ['Signed', 'Executed', 'Fully signed'];
const money = n => Math.round((Number(n) || 0) * 100) / 100;

function isSigned(c) { return SIGNED.includes(c.signature_status); }
function kindOf(c) { return c.kind || 'Contract'; }
function isSuperseded(c) { return !!c.superseded_by || c.status === 'Superseded'; }

function contractValueReport(rows) {
  const signed = rows.filter(isSigned);
  const live = signed.filter(c => !isSuperseded(c) && !c.archived_at);
  const originals = live.filter(c => kindOf(c) === 'Contract');
  const renewals = live.filter(c => kindOf(c) === 'Renewal');
  const amendments = live.filter(c => kindOf(c) === 'Amendment');
  const sum = list => money(list.reduce((s, c) => s + (Number(c.value) || 0), 0));
  const dashboard = sum(signed);
  const contracted = sum(originals) + sum(renewals);
  return {
    contracted_value: money(contracted),
    parts: {
      originals: { count: originals.length, value: sum(originals) },
      renewals: { count: renewals.length, value: sum(renewals) },
      amendments_listed_not_added: { count: amendments.length, value: sum(amendments) }
    },
    superseded_excluded: { count: signed.filter(isSuperseded).length, value: sum(signed.filter(isSuperseded)) },
    dashboard_sum_today: dashboard,
    overstatement_on_dashboard: money(dashboard - contracted),
    rule: 'Signed originals + signed renewals, no superseded or archived rows. Amendments are listed, not added. Owner to confirm.'
  };
}

// The one figure the screens show: contracted value and how many contracts make it up.
function summary(rows) {
  const r = contractValueReport(rows);
  return { value: r.contracted_value, count: r.parts.originals.count + r.parts.renewals.count };
}

function mount(app, ctx) {
  const { db, auth } = ctx;
  app.get('/api/admin/contract-value', auth, (req, res) => {
    const cols = db.prepare('PRAGMA table_info(contracts)').all().map(c => c.name);
    const want = ['id', 'kind', 'value', 'status', 'signature_status', 'superseded_by', 'archived_at'];
    const rows = db.prepare(`SELECT ${want.filter(c => cols.includes(c)).join(',')} FROM contracts`).all();
    res.json(contractValueReport(rows));
  });
}

module.exports = { contractValueReport, summary, isSigned, kindOf, isSuperseded, mount };
