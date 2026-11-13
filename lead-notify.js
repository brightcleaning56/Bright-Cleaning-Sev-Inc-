// Lead alerts for leads that arrive through the API (partner sites, bots, Zapier).
// One email per lead floods the inbox when a source sends a burst. This sends the first alert at once,
// then holds later leads from the same source and sends them as one digest when the window opens.
// No lead is dropped: every lead is saved before this runs, and the digest lists every held lead.
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const MAX_LINES = 50;

function createLeadNotifier({ notify, to, windowMs = DEFAULT_WINDOW_MS, now = () => Date.now(), setTimer = setTimeout }) {
  const states = new Map(); // source id -> { last, held: [], timer }

  function send(source, lines) {
    if (!notify || !lines.length) return Promise.resolve(false);
    const shown = lines.slice(0, MAX_LINES);
    const more = lines.length - shown.length;
    const subject = lines.length === 1 ? `New lead from ${source}` : `${lines.length} new leads from ${source}`;
    const body = shown.join('\n\n----------\n\n') + (more > 0 ? `\n\n…and ${more} more. See Leads in the admin for the full list.` : '');
    try {
      return Promise.resolve(notify(subject, body, to)).then(() => true, () => false);
    } catch {
      return Promise.resolve(false); // a notifier that throws must not fail the intake request
    }
  }

  function flush(source, st) {
    st.timer = null;
    if (!st.held.length) return;
    const lines = st.held.splice(0);
    st.last = now();
    send(source, lines);
  }

  // Queue one lead alert. `line` is the full text for that lead.
  function leadArrived(sourceId, sourceName, line) {
    const st = states.get(sourceId) || { last: null, held: [], timer: null };
    states.set(sourceId, st);
    const t = now();
    if (!st.held.length && (st.last === null || t - st.last >= windowMs)) {
      st.last = t;
      send(sourceName, [line]);
      return 'sent';
    }
    st.held.push(line);
    if (!st.timer) {
      const wait = st.last === null ? 0 : Math.max(0, windowMs - (t - st.last));
      st.timer = setTimer(() => flush(sourceName, st), wait);
      if (st.timer && typeof st.timer.unref === 'function') st.timer.unref();
    }
    return 'held';
  }

  // Test helper and shutdown helper: clears pending timers.
  function stop() { for (const st of states.values()) if (st.timer) { clearTimeout(st.timer); st.timer = null; } }

  return { leadArrived, stop, _states: states };
}

module.exports = { createLeadNotifier, DEFAULT_WINDOW_MS };
