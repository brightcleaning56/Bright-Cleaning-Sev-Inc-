(() => {
  // /crew/<token> is the personal link; /crew is the sign-in page. A signed-in crew member uses the token 'me'.
  const rawToken = location.pathname.split('/').pop(), $ = s => document.querySelector(s);
  const SIGNIN = rawToken === 'crew' || rawToken === '';
  const token = SIGNIN ? 'me' : rawToken;
  const SESSION_KEY = 'bc_crew_session';
  const session = () => { try { return localStorage.getItem(SESSION_KEY) || ''; } catch { return ''; } };
  const authHdr = () => (token === 'me' && session()) ? { Authorization: 'Bearer ' + session() } : {};
  const KEY_DAY = 'bc_crew_day_' + token, KEY_Q = 'bc_crew_queue_' + token, KEY_OV = 'bc_crew_overlay_' + token;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const say = (t, good) => { $('#msg').innerHTML = t ? `<div class="msg ${good ? 'good' : 'err'}">${esc(t)}</div>` : ''; if (t) scrollTo(0, 0); };
  const fmt = d => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const hm = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // Phone storage: today's jobs, the queue of changes waiting to send, and what the phone has already changed locally.
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked or full: the page still works online */ } },
  };
  const queue = () => store.get(KEY_Q, []);
  const overlay = () => store.get(KEY_OV, {});
  const newId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));

  // Network failures are TypeError in browsers; a server answer (even an error) is never treated as offline.
  const isOffline = e => e instanceof TypeError;
  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { ...authHdr(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const err = new Error(j.error || 'Something went wrong'); err.status = r.status; throw err; }
    return j;
  }
  async function get(url) { const r = await fetch(url, { cache: 'no-store', headers: authHdr() }); const j = await r.json().catch(() => ({})); if (!r.ok) { const err = new Error(j.error || 'Something went wrong'); err.status = r.status; throw err; } return j; }

  // Sign-in page: phone or email and a PIN. A session lasts until the crew member signs out.
  function showSignIn() {
    $('#who').textContent = 'Sign in';
    $('#sub').textContent = '';
    $('#jobs').innerHTML = '<form id="crewLogin" class="card" style="padding:16px"><p class="muted">Sign in with the phone number or email your supervisor has on file, and your PIN.</p>' +
      '<label style="display:block;margin:8px 0">Phone or email<input id="crewUser" autocomplete="username" required style="display:block;width:100%;font-size:16px;padding:10px;margin-top:4px"></label>' +
      '<label style="display:block;margin:8px 0">PIN<input id="crewPin" inputmode="numeric" autocomplete="current-password" required style="display:block;width:100%;font-size:16px;padding:10px;margin-top:4px"></label>' +
      '<button type="submit" class="btn" style="width:100%;padding:12px;margin-top:8px">Sign in</button></form>';
    $('#crewLogin').onsubmit = async ev => {
      ev.preventDefault();
      const login = $('#crewUser').value.trim(), pin = $('#crewPin').value.trim();
      try {
        const r = await fetch('/api/crew/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, pin }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'Sign-in failed');
        localStorage.setItem(SESSION_KEY, j.token);
        location.reload();
      } catch (e) { say(e.message); }
    };
  }
  if (token === 'me' && !session()) { showSignIn(); return; }
  if (token === 'me') {
    const out = document.createElement('button');
    out.type = 'button'; out.className = 'btn ghost'; out.textContent = 'Sign out'; out.style.cssText = 'margin-left:auto';
    out.onclick = () => { try { localStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ } location.reload(); };
    document.querySelector('header').appendChild(out);
  }

  let d = null, offlineAt = null, flushing = false;

  function banner() {
    const el = $('#net'); if (!el) return;
    const waiting = queue().length;
    const parts = [];
    if (offlineAt) parts.push(`Offline: showing jobs as of ${hm(offlineAt)}.`);
    if (waiting) parts.push(`${waiting} change${waiting === 1 ? '' : 's'} waiting to send.`);
    el.hidden = !parts.length; el.textContent = parts.join(' ');
  }

  // Sends queued changes in the order they were made. A change the server refuses is dropped and the reason is shown.
  async function flush() {
    let lastRefusal = '';
    if (flushing) return lastRefusal; flushing = true;
    try {
      while (queue().length) {
        const item = queue()[0];
        try { await post(item.url, item.body); }
        catch (e) {
          if (isOffline(e)) break; // still no signal: keep the queue and try again later
          lastRefusal = e.message;
          say(`Could not send one change: ${e.message}`);
        }
        store.set(KEY_Q, queue().slice(1));
      }
    } finally { flushing = false; }
    if (!queue().length) store.set(KEY_OV, {});
    banner();
    return lastRefusal;
  }

  function queueChange(visitId, action, body) {
    const item = { id: newId(), url: `/api/crew/${token}/jobs/${visitId}/${action}`, body: { ...(body || {}), client_id: newId() }, action, visitId, at: Date.now() };
    const q = queue(); q.push(item); store.set(KEY_Q, q);
    const ov = overlay(), o = ov[visitId] || {};
    if (action === 'checklist') o.checklist = { ...(o.checklist || {}), [body.index]: !!body.done };
    else o.status = action === 'checkin' ? 'checkin' : action === 'checkout' ? 'checkout' : 'complete';
    ov[visitId] = o; store.set(KEY_OV, ov);
    return item;
  }

  function render() {
    const ov = overlay(), q = queue();
    $('#who').textContent = d.employee.name;
    const clockedIn = d.clocked_in ? hm(d.clocked_in.since) : null;
    $('#sub').textContent = `${d.employee.role || ''}${d.employee.crew ? ' · Crew ' + d.employee.crew : ''}${clockedIn ? ' · Checked in since ' + clockedIn : ''}`;
    if (!d.jobs.length) { $('#jobs').innerHTML = '<div class="card"><b>No dispatched jobs this week.</b><p class="muted">Your supervisor will send jobs here once they are dispatched.</p></div>'; return; }
    $('#jobs').innerHTML = d.jobs.map(j => {
      const o = ov[j.id] || {};
      const pending = q.some(x => x.visitId === j.id);
      const serverIn = !!(d.clocked_in && d.clocked_in.visit_id === j.id);
      const inHere = o.status === 'checkin' ? true : o.status === 'checkout' || o.status === 'complete' ? false : serverIn;
      const done = o.status === 'complete' || j.status === 'Done';
      const checked = i => (o.checklist && o.checklist[i] !== undefined) ? o.checklist[i] : !!j.checklist[i].done;
      return `<div class="card job" data-id="${j.id}"><span class="pill ${done ? 'done' : ''}">${esc(done ? 'Completed' : j.status)}</span>${pending ? ' <span class="pill">Waiting to send</span>' : ''}<h2>${esc(j.title)}</h2>
        <div class="muted">${fmt(j.date)} · ${esc(j.start_time || '')}${j.end_time ? '–' + esc(j.end_time) : ''}</div>
        <div>${esc(j.address || '')}</div>${j.address ? `<div class="row"><a class="btn ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(j.address)}">Directions</a></div>` : ''}
        ${j.instructions ? `<div class="sec">Instructions</div><div>${esc(j.instructions)}</div>` : ''}${j.equipment ? `<div class="sec">Equipment &amp; supplies</div><div>${esc(j.equipment)}</div>` : ''}
        <div class="sec">Site access</div><div>${esc(j.access || '—')}${j.site_contact ? '<br>Contact: ' + esc(j.site_contact) : ''}</div>${j.safety ? `<div class="sec">Safety</div><div>${esc(j.safety)}</div>` : ''}
        <div class="muted" style="margin-top:6px">Crew: ${esc(j.crew.join(', '))}</div>
        ${j.checklist.length ? `<div class="sec">Checklist</div><ul class="check">${j.checklist.map((c, i) => `<li><input type="checkbox" data-ck="${i}" ${checked(i) ? 'checked' : ''} ${done ? 'disabled' : ''} aria-label="${esc(c.text || c.title || '')}"><span>${esc(c.text || c.title || '')}</span></li>`).join('')}</ul>` : ''}
        ${done ? '' : `<div class="row">${inHere ? '<button class="ghost" data-a="checkout">Check out</button>' : '<button class="primary" data-a="checkin">Check in</button>'}<button class="ok" data-a="complete">Mark job complete</button></div>
        <div class="row"><style>.ph-up:focus-within{outline:3px solid #1f6fb2;outline-offset:2px}</style><label class="btn ghost ph-up">Before photos<input type="file" accept="image/*" capture="environment" multiple style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden" data-ph="Before"></label><label class="btn ghost ph-up">After photos<input type="file" accept="image/*" capture="environment" multiple style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden" data-ph="After"></label></div>
        <div class="row"><button class="danger" data-a="incident">Report an incident</button></div>`}</div>`;
    }).join('');
    wire();
    banner();
  }

  function wire() {
    document.querySelectorAll('.job').forEach(card => {
      const id = Number(card.dataset.id);
      card.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
        const a = b.dataset.a;
        if (a === 'complete' && !confirm('Mark this job complete?')) return;
        if (a === 'incident') {
          if (!navigator.onLine) return say('Incidents need signal. Report it when you are connected.');
          const t = prompt('What happened? (short)'); if (!t) return;
          const body = { title: t, description: prompt('Details (optional)') || '', priority: 'High' };
          b.disabled = true;
          try { await post(`/api/crew/${token}/jobs/${id}/incident`, body); say('Incident reported to the office.', true); }
          catch (e) { say(isOffline(e) ? 'Incidents need signal. Report it when you are connected.' : e.message); }
          b.disabled = false; return;
        }
        queueChange(id, a, {});
        const refusal = await flush();
        const done = { checkin: 'Checked in.', checkout: 'Checked out.', complete: 'Job marked complete. Thank you!' }[a];
        const saved = { checkin: 'Check-in', checkout: 'Check-out', complete: 'Job completion' }[a];
        if (refusal) { if (!queue().length) await refresh(); else render(); return; } // keep the refusal message on screen
        say(queue().length ? `${saved} saved on this phone. It will send when you have signal.` : done, true);
        if (!queue().length) await refresh(); else render();
      });
      card.querySelectorAll('[data-ck]').forEach(c => c.onchange = async () => {
        queueChange(id, 'checklist', { index: Number(c.dataset.ck), done: c.checked });
        await flush();
        if (queue().length) render(); else await refresh();
      });
      card.querySelectorAll('[data-ph]').forEach(inp => inp.onchange = async () => {
        if (!inp.files.length) return;
        if (!navigator.onLine) { inp.value = ''; return say('Photos need signal. Upload them when you are connected.'); }
        const fd = new FormData(); fd.append('stage', inp.dataset.ph); [...inp.files].forEach(f => fd.append('photos', f));
        try { const r = await fetch(`/api/crew/${token}/jobs/${id}/photos`, { method: 'POST', headers: authHdr(), body: fd }).then(x => x.json().then(j => ({ ok: x.ok, j }))); if (!r.ok) throw new Error(r.j.error || 'Upload failed'); say(`${r.j.ids.length} photo(s) uploaded.`, true); }
        catch (e) { say(isOffline(e) ? 'Photos need signal. Upload them when you are connected.' : e.message); }
      });
    });
  }

  // Loads today's jobs from the server; if the phone is offline, shows the copy saved on this phone.
  async function refresh() {
    try {
      d = await get('/api/crew/' + token);
      offlineAt = null; store.set(KEY_DAY, { at: Date.now(), data: d });
    } catch (e) {
      if (e.status === 401 && token === 'me') { try { localStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ } return showSignIn(); }
      if (!isOffline(e)) { $('#sub').textContent = ''; return say(e.message); }
      const saved = store.get(KEY_DAY, null);
      if (!saved) { $('#sub').textContent = ''; return say('You are offline and this phone has no saved jobs yet. Connect once to load them.'); }
      d = saved.data; offlineAt = saved.at;
    }
    render();
  }

  window.addEventListener('online', async () => { await flush(); await refresh(); });
  setInterval(() => { if (queue().length) flush().then(banner); }, 30000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/crew-sw.js').catch(() => { /* the page works without it */ });
  refresh().then(() => flush()).then(() => { if (!queue().length && d) refresh(); });
})();
