// Insights: learns from what happened to proposals (won, lost, expired) and where leads come from.
// It only reads records and returns suggestions for the owner to review. It never changes prices,
// proposals, leads or customers. A group needs at least MIN decided proposals before it is compared.
module.exports = function mountInsights(app, ctx) {
  const { db, auth, adminEmail } = ctx;
  const MIN = 5;          // decided proposals needed before a group is compared
  const GAP = 0.2;        // a group must differ from the overall win rate by this much to get a suggestion
  const DECIDED = ['Approved', 'Declined', 'Expired'];

  const roleOf = req => {
    const e = String((req.user && req.user.email) || '').toLowerCase();
    if (!adminEmail || e === adminEmail.toLowerCase()) return 'owner';
    const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e);
    return (r && r.role) || 'staff';
  };
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
  const band = v => { const n = Number(v) || 0; return n < 5000 ? 'Under $5,000' : n <= 25000 ? '$5,000 to $25,000' : 'Over $25,000'; };

  function group(decided, key) {
    const m = new Map();
    for (const r of decided) {
      const k = key(r) || 'Not set';
      const g = m.get(k) || { name: k, decided: 0, won: 0 };
      g.decided++; if (r.status === 'Approved') g.won++;
      m.set(k, g);
    }
    return [...m.values()].map(g => ({ ...g, win_rate: pct(g.won, g.decided) })).sort((a, b) => b.decided - a.decided);
  }

  function compute(sinceIso) {
    const rows = db.prepare(`SELECT e.id, e.status, e.scope_category, e.proposal_total, e.sent_at, e.decided_at, e.lead_id, l.origin
      FROM estimates e LEFT JOIN leads l ON l.id = e.lead_id
      WHERE e.archived_at IS NULL AND e.sent_at IS NOT NULL AND e.sent_at >= ?`).all(sinceIso);
    const decided = rows.filter(r => DECIDED.includes(r.status));
    const won = decided.filter(r => r.status === 'Approved').length;
    const overall = pct(won, decided.length);
    const bySvc = group(decided, r => r.scope_category);
    const bySource = group(decided, r => r.origin || (r.lead_id ? 'Lead, no source' : 'Created directly'));
    const byBand = group(decided, r => band(r.proposal_total));
    const days = decided.filter(r => r.decided_at).map(r => (Date.parse(r.decided_at) - Date.parse(r.sent_at)) / 864e5).filter(x => x >= 0);

    const suggestions = [];
    if (decided.length < MIN) {
      suggestions.push({ kind: 'info', text: `Not enough decided proposals yet (${decided.length} of ${MIN} needed) to suggest changes. This page updates as proposals are decided.` });
    } else {
      for (const [label, list] of [['service', bySvc], ['lead source', bySource], ['price range', byBand]]) {
        for (const g of list) {
          if (g.decided < MIN || g.win_rate == null || overall == null) continue;
          const diff = (g.win_rate - overall) / 100;
          if (Math.abs(diff) < GAP) continue;
          suggestions.push(diff < 0
            ? { kind: 'review', text: `${g.name} (${label}) wins ${g.win_rate}% of ${g.decided} decided proposals, against ${overall}% overall. Review the price or the proposal for this group.` }
            : { kind: 'keep', text: `${g.name} (${label}) wins ${g.win_rate}% of ${g.decided} decided proposals, against ${overall}% overall. This is working; keep the approach.` });
        }
      }
    }
    return {
      decided: decided.length, won, overall_win_rate: overall,
      avg_days_to_decision: days.length ? Math.round((days.reduce((s, x) => s + x, 0) / days.length) * 10) / 10 : null,
      open: rows.filter(r => ['Sent', 'Viewed'].includes(r.status)).length,
      by_service: bySvc, by_source: bySource, by_price: byBand, suggestions
    };
  }

  app.get('/api/admin/insights', auth, (req, res) => {
    if (!['owner', 'manager'].includes(roleOf(req))) return res.status(403).json({ error: 'Only an owner or manager can see insights.' });
    const months = Math.min(36, Math.max(1, Number(req.query.months) || 12));
    const since = new Date(Date.now() - months * 30.4 * 864e5).toISOString();
    const intake = db.prepare(`SELECT COALESCE(l.origin, 'Not set') AS origin, COUNT(DISTINCT l.id) AS leads, COUNT(DISTINCT e.lead_id) AS with_estimate
      FROM leads l LEFT JOIN estimates e ON e.lead_id = l.id WHERE l.created_at >= ? GROUP BY COALESCE(l.origin, 'Not set') ORDER BY leads DESC`).all(since);
    res.json({ months, ...compute(since), intake,
      note: 'Suggestions only. Nothing is changed automatically; prices, proposals and customers stay as they are until someone edits them.' });
  });
};
