(() => {
  // /crew/<token> is the personal link; /crew is the sign-in page. A signed-in crew member uses the token 'me'.
  const rawToken = location.pathname.split('/').pop(), $ = s => document.querySelector(s);
  const SIGNIN = rawToken === 'crew' || rawToken === '';
  const token = SIGNIN ? 'me' : rawToken;
  const SESSION_KEY = 'bc_crew_session';
  const session = () => { try { return localStorage.getItem(SESSION_KEY) || ''; } catch { return ''; } };
  // The sign-in is an HttpOnly cookie the server sets, so this page never holds the session token; requests send it by themselves.
  const authHdr = () => ({});
  // A token an older version stored in this browser is removed; only a marker is kept now.
  if (session() && session() !== '1') { try { localStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ } }
  const KEY_DAY = 'bc_crew_day_' + token, KEY_Q = 'bc_crew_queue_' + token, KEY_OV = 'bc_crew_overlay_' + token;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const say = (t, good) => { $('#msg').innerHTML = t ? `<div class="msg ${good ? 'good' : 'err'}">${esc(t)}</div>` : ''; if (t) scrollTo(0, 0); };
  const fmt = d => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const hm = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const todayStr = () => { const t = new Date(); return [t.getFullYear(), String(t.getMonth() + 1).padStart(2, '0'), String(t.getDate()).padStart(2, '0')].join('-'); };
  const addDaysStr = (s, n) => { const t = new Date(s + 'T12:00:00'); t.setDate(t.getDate() + n); return [t.getFullYear(), String(t.getMonth() + 1).padStart(2, '0'), String(t.getDate()).padStart(2, '0')].join('-'); };
  const greet = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };

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
    document.querySelector('nav.tabs').hidden = true;
    $('#v-jobs').innerHTML = '<form id="crewLogin" class="card" style="padding:16px"><p class="muted">Sign in with the phone number or email your supervisor has on file, and your PIN.</p>' +
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
        try { localStorage.setItem(SESSION_KEY, '1'); } catch { /* storage blocked: the cookie still signs in */ }
        location.reload();
      } catch (e) { say(e.message); }
    };
  }
  if (token === 'me' && !session()) { showSignIn(); return; }
  if (token === 'me') {
    const out = document.createElement('button');
    out.type = 'button'; out.className = 'btn ghost'; out.textContent = 'Sign out'; out.style.cssText = 'margin-left:12px;flex:0 0 auto;min-height:40px';
    // Unsent changes stay with the person who made them: sign out only once they are sent. Then nothing is left for the next person on this phone.
    out.onclick = () => { if (queue().length) { say('Some changes are not sent yet. Connect to send them, then sign out.'); return; } try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(KEY_DAY); localStorage.removeItem(KEY_OV); } catch { /* storage blocked */ } fetch('/api/crew/logout', { method: 'POST' }).catch(() => {}).finally(() => location.reload()); };
    document.querySelector('header .who').appendChild(out);
  }

  let d = null, offlineAt = null, flushing = false;
  let view = 'jobs', sub = 'today';

  // Photos taken with no signal are kept on the phone (IndexedDB) and sent when it is back
  let photosWaiting = 0;
  function openPhotos() {
    return new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('This phone cannot keep photos offline.'));
      const r = indexedDB.open('bc-crew-photos', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('photos', { autoIncrement: true });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  function queuePhotos(items) {
    return openPhotos().then(db => new Promise((res, rej) => {
      const tx = db.transaction('photos', 'readwrite'); items.forEach(x => tx.objectStore('photos').add(x));
      tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => { db.close(); rej(tx.error); };
    }));
  }
  function pendingPhotos() {
    return openPhotos().then(db => new Promise((res, rej) => {
      const tx = db.transaction('photos', 'readonly'), items = [];
      tx.objectStore('photos').openCursor().onsuccess = e => { const c = e.target.result; if (c) { items.push({ key: c.key, ...c.value }); c.continue(); } };
      tx.oncomplete = () => { db.close(); res(items); }; tx.onerror = () => { db.close(); rej(tx.error); };
    }));
  }
  function removePhoto(key) {
    return openPhotos().then(db => new Promise((res, rej) => {
      const tx = db.transaction('photos', 'readwrite'); tx.objectStore('photos').delete(key);
      tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => { db.close(); rej(tx.error); };
    }));
  }
  let flushingPhotos = false;
  async function flushPhotos() {
    if (flushingPhotos || !navigator.onLine) return;
    flushingPhotos = true; let sent = 0;
    try {
      const items = await pendingPhotos().catch(() => []);
      for (const it of items) {
        try {
          const fd = new FormData(); fd.append('stage', it.stage); fd.append('photos', it.blob, it.name || 'photo.jpg');
          const r = await fetch(`/api/crew/${it.token}/jobs/${it.visitId}/photos`, { method: 'POST', headers: authHdr(), body: fd });
          if (!r.ok) continue; // keep it and try again later
          await removePhoto(it.key); sent++;
        } catch { break; } // still no signal: stop and try later
      }
    } finally { flushingPhotos = false; }
    photosWaiting = (await pendingPhotos().catch(() => [])).length;
    if (sent) say(`${sent} photo(s) from this phone uploaded.`, true);
    banner();
  }

  function banner() {
    const el = $('#net'); if (!el) return;
    const waiting = queue().length;
    const parts = [];
    if (offlineAt) parts.push(`Offline: showing jobs as of ${hm(offlineAt)}.`);
    if (waiting) parts.push(`${waiting} change${waiting === 1 ? '' : 's'} waiting to send.`);
    if (photosWaiting) parts.push(`${photosWaiting} photo${photosWaiting === 1 ? '' : 's'} waiting to upload.`);
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
          // No signal, a server error, or a sign-in or link that is not valid right now: keep the change and try again later.
          if (isOffline(e) || !e.status || e.status >= 500 || [401, 403, 404].includes(e.status)) { say('Some changes are waiting to be sent. They will send when the connection is back.'); break; }
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
    // device_at is when the crew member acted on this phone; the server uses it as the time of the action, even if the change syncs later.
    const at = Date.now();
    const item = { id: newId(), url: `/api/crew/${token}/jobs/${visitId}/${action}`, body: { ...(body || {}), client_id: newId(), device_at: new Date(at).toISOString() }, action, visitId, at };
    const q = queue(); q.push(item); store.set(KEY_Q, q);
    const ov = overlay(), o = ov[visitId] || {};
    if (action === 'checklist') o.checklist = { ...(o.checklist || {}), [body.index]: !!body.done };
    else if (action === 'onmyway') o.onmyway = true; // only a flag: it must not change the job's status
    else o.status = action === 'checkin' ? 'checkin' : action === 'checkout' ? 'checkout' : 'complete';
    ov[visitId] = o; store.set(KEY_OV, ov);
    return item;
  }

  // What the phone should show for one job: finished, in progress, or waiting to send.
  function currentSpot() {
    return new Promise(res => {
      if (!navigator.geolocation) return res({});
      navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }), () => res({}), { enableHighAccuracy: true, timeout: 6000, maximumAge: 60000 });
    });
  }
  function fmtMins(m) { m = Math.max(0, Math.round(m || 0)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; }
  function jobState(j, ov, q) {
    const o = ov[j.id] || {};
    const pending = q.some(x => x.visitId === j.id);
    const serverIn = !!(d.clocked_in && d.clocked_in.visit_id === j.id);
    const inHere = o.status === 'checkin' ? true : o.status === 'checkout' || o.status === 'complete' ? false : serverIn;
    const done = o.status === 'complete' || j.status === 'Done';
    return { o, pending, inHere, done };
  }

  // One job: the big actions first, then photos, then the details (scope, access, checklist) tucked under "Job details".
  function jobCard(j, st) {
    const { o, pending, inHere, done } = st;
    const rv = j.review_status || null; // null, Submitted, Approved or Returned
    const checked = i => (o.checklist && o.checklist[i] !== undefined) ? o.checklist[i] : !!j.checklist[i].done;
    const label = done ? 'Completed' : inHere ? 'In progress' : j.status;
    const stripe = done ? 'done' : inHere ? 'live' : '';
    return `<div class="card job ${stripe}" data-id="${j.id}">
      <div class="jtop"><h2>${esc(j.title)}</h2><span class="pill ${done ? 'done' : ''}">${esc(label)}</span></div>
      <div class="meta">${esc(fmt(j.date))} · ${esc(j.start_time || '')}${j.end_time ? '–' + esc(j.end_time) : ''}</div>
      <div class="meta">${esc(j.address || 'Address not set yet')}</div>
      ${j.on_site_minutes || inHere ? `<div class="meta">Time on site: ${esc(fmtMins(j.on_site_minutes || 0))}${j.break_minutes ? ' · breaks ' + esc(fmtMins(j.break_minutes)) : ''}${j.on_break ? ' · on break' : ''}</div>` : ''}
      <div class="tags">${pending ? '<span class="pill">Waiting to send</span>' : ''}${j.dispatched ? '' : '<span class="pill">Upcoming · office confirms</span>'}</div>
      ${done ? '' : `${rv === 'Returned' ? `<div class="msg err">Sent back by the office: ${esc(j.review_note || 'see the office')}. Fix it, then submit again.</div>` : ''}
      <div class="actions">
        ${inHere ? '<button class="ghost big" data-a="checkout">Check out<small>End job</small></button>' : '<button class="primary big" data-a="checkin">Check in<small>Start job</small></button>'}
        ${inHere ? `<button class="ghost big" data-a="break">${j.on_break ? 'End break' : 'Start break'}<small>${j.on_break ? 'Back to work' : 'Pause the clock'}</small></button>` : ''}
        ${inHere ? '' : (j.on_my_way_at || o.onmyway) ? '<button class="ghost big" disabled>On the way<small>Client told</small></button>' : '<button class="ghost big" data-a="onmyway">On my way<small>Tell the client</small></button>'}
        ${rv === 'Submitted' ? '<button class="ghost big" disabled>Waiting for approval<small>Office is reviewing</small></button>'
          : rv === 'Approved' ? '<button class="ok big" data-a="complete">Mark complete<small>Job approved</small></button>'
          : '<button class="ok big" data-a="submit">Submit for review<small>Checklist and photos</small></button>'}
      </div>`}
      <div class="photos"><b>Photos</b>
        <label class="btn ghost ph-up">Before<input type="file" accept="image/*" multiple style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden" data-ph="Before"></label>
        <label class="btn ghost ph-up">During<input type="file" accept="image/*" multiple style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden" data-ph="During"></label>
        <label class="btn ghost ph-up">After<input type="file" accept="image/*" multiple style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden" data-ph="After"></label>
      </div>
      <div class="photos"><b>Job notes</b><span class="muted">Saved on this job for the office to read at review</span></div>
      ${(j.notes || []).length ? (j.notes || []).slice(-5).map(n => `<div class="bubble me"><small>${esc(new Date(n.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</small>${esc(n.body)}</div>`).join('') : '<p class="muted">No notes yet. Say what was done here, or anything that happened.</p>'}
      <textarea rows="2" placeholder="What was done, or anything that happened here" data-note-text aria-label="Job note"></textarea>
      <div class="links"><button class="ghost" type="button" data-note-send>Add note to job</button></div>
      <div class="links">${j.address ? `<a class="btn ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(j.address)}">Directions</a>` : ''}</div>
      <details><summary>Job details</summary>
        ${j.instructions ? `<div class="sec">Instructions</div><div>${esc(j.instructions)}</div>` : ''}${j.rooms ? `<div class="sec">Rooms and areas</div><div style="white-space:pre-wrap">${esc(j.rooms)}</div>` : ''}${j.customer_requests ? `<div class="sec">Customer requests</div><div style="white-space:pre-wrap">${esc(j.customer_requests)}</div>` : ''}${j.equipment ? `<div class="sec">Equipment &amp; supplies</div><div>${esc(j.equipment)}</div>` : ''}
        <div class="sec">Site access</div><div>${esc(j.access || '—')}${j.site_contact ? '<br>Contact: ' + esc(j.site_contact) : ''}</div>${j.safety ? `<div class="sec">Safety</div><div>${esc(j.safety)}</div>` : ''}
        <div class="muted" style="margin-top:6px">Crew: ${esc(j.crew.join(', '))}</div>
        ${j.checklist.length ? `<div class="sec">Checklist</div><ul class="check">${j.checklist.map((c, i) => `<li><input type="checkbox" data-ck="${i}" ${checked(i) ? 'checked' : ''} ${done ? 'disabled' : ''} aria-label="${esc(c.text || c.title || '')}"><span>${esc(c.text || c.title || '')}</span></li>`).join('')}</ul>` : ''}
        <div class="row"><label style="display:block;width:100%"><span class="muted">What kind of incident?</span><select data-inc-cat><option>Safety</option><option>Damage / incident</option><option>Equipment</option><option>Customer request</option><option>Other</option></select></label><button class="danger" data-a="incident">Report an incident</button></div>
      </details>
    </div>`;
  }

  function render() {
    const ov = overlay(), q = queue(), today = todayStr();
    $('#who').textContent = d.employee.name;
    const clockedIn = d.clocked_in ? hm(d.clocked_in.since) : null;
    $('#sub').textContent = `${d.employee.role || ''}${d.employee.crew ? ' · Crew ' + d.employee.crew : ''}${clockedIn ? ' · Checked in since ' + clockedIn : ''}`;
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === view));
    ['jobs', 'schedule', 'photos', 'incidents', 'messages', 'profile'].forEach(v => { const el = $('#v-' + v); if (el) el.hidden = v !== view; });

    const all = d.jobs.map(j => ({ j, ...jobState(j, ov, q) }));
    const sameDay = all.filter(x => x.j.date === today);
    const todays = all.filter(x => x.j.date === today || (x.j.date < today && !x.done));
    const upcoming = all.filter(x => x.j.date > today && !x.done);
    const completed = all.filter(x => x.done);
    const doneToday = sameDay.filter(x => x.done).length;
    const pct = sameDay.length ? Math.round(doneToday / sameDay.length * 100) : 0;
    const remaining = todays.filter(x => !x.done).length;
    const inNow = all.filter(x => x.inHere).length;
    const first = String(d.employee.name || '').split(' ')[0];
    const list = { today: todays, upcoming, completed }[sub] || todays;
    const emptyText = { today: 'No jobs for today.', upcoming: 'No upcoming jobs yet.', completed: 'No completed jobs yet.' }[sub];
    // Next stop: the next job that is not finished, with the time the client expects the crew
    const nextOne = all.filter(x => !x.done && x.j.status !== 'Cancelled').sort((a, b) => (a.j.date + (a.j.start_time || '')).localeCompare(b.j.date + (b.j.start_time || '')))[0];
    const nextStop = nextOne ? `<div class="card job live"><small class="muted">Next stop</small><h2>${esc(nextOne.j.title)}</h2><div class="meta">${esc(fmt(nextOne.j.date))}${nextOne.j.start_time ? ' · ' + esc(nextOne.j.start_time) : ''} · ${esc(nextOne.j.address || 'Address not set yet')}</div>${nextOne.j.start_time ? `<div class="muted">The client expects the crew at ${esc(nextOne.j.start_time)}. They can follow your arrival on their tracking page.</div>` : ''}${(nextOne.j.on_my_way_at || (nextOne.o && nextOne.o.onmyway)) ? '<div class="msg good">You have told the client you are on the way.</div>' : ''}${nextOne.j.address ? `<div class="links"><a class="btn ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(nextOne.j.address)}">Directions</a></div>` : ''}</div>` : '';

    if (view === 'jobs') {
      const ring = 2 * Math.PI * 34;
      $('#v-jobs').innerHTML = `
        <section class="hero"><div><small class="muted">${greet()}</small><h1>${esc(first)}</h1><p>Here’s your work for today.</p></div><span class="datechip">${esc(new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))}</span></section>
        <div class="grid"><div>
          <div class="stats">
            <div class="stat"><small>Today’s jobs</small><b>${todays.length}</b></div>
            <div class="stat"><small>Completed</small><b>${doneToday}</b></div>
            <div class="stat"><small>Remaining</small><b>${remaining}</b></div>
            <div class="stat"><small>Checked in</small><b>${inNow}</b></div>
          </div>
          ${nextStop}
          <div class="subtabs">${[['today', 'Today', todays.length], ['upcoming', 'Upcoming', upcoming.length], ['completed', 'Completed', completed.length]].map(([k, l, n]) => `<button type="button" class="subtab ${sub === k ? 'on' : ''}" data-sub="${k}">${l} (${n})</button>`).join('')}</div>
          <div id="jobs">${!d.jobs.length ? '<div class="card"><b>No dispatched jobs this week.</b><p class="muted">Your supervisor will send jobs here once they are dispatched.</p></div>' : list.length ? list.map(x => jobCard(x.j, x)).join('') : `<div class="card"><b>Nothing here.</b><p class="muted">${emptyText}</p></div>`}</div>
        </div>
        <aside>
          <div class="card ring"><svg width="84" height="84" viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="34" fill="none" stroke="#e5ebf2" stroke-width="10"/><circle cx="42" cy="42" r="34" fill="none" stroke="#17904c" stroke-width="10" stroke-linecap="round" stroke-dasharray="${(ring * pct / 100).toFixed(1)} ${ring.toFixed(1)}" transform="rotate(-90 42 42)"/></svg><div><b>Today’s progress</b><p class="muted" style="margin:4px 0 0">${doneToday} of ${sameDay.length} job${sameDay.length === 1 ? '' : 's'} completed (${pct}%)</p></div></div>
          <div class="card"><b>Quick actions</b><div class="qa" style="margin-top:10px"><button type="button" class="ghost" data-view-go="photos">Take photo</button><button type="button" class="danger" data-view-go="incidents">Report incident</button></div></div>
        </aside></div>`;
    }

    if (view === 'schedule') {
      const days = [0, 1, 2, 3, 4, 5, 6].map(n => addDaysStr(today, n));
      $('#v-schedule').innerHTML = `<h1 style="font-size:22px;margin:4px 0 10px">Next 7 days</h1>` + days.map(day => {
        const rows = all.filter(x => x.j.date === day);
        return `<h3 class="day">${esc(fmt(day))}${day === today ? ' · Today' : ''}</h3>` + (rows.length ? rows.map(x => `<div class="card row-job"><b>${esc(x.j.start_time || 'Any time')}${x.j.end_time ? '–' + esc(x.j.end_time) : ''}</b> · ${esc(x.j.title)}<div class="meta">${esc(x.j.address || 'Address not set yet')}</div><div class="meta">Crew: ${esc(x.j.crew.join(', '))}</div></div>`).join('') : '<p class="muted" style="margin:0 0 6px">No jobs</p>');
      }).join('');
    }

    if (view === 'photos') {
      $('#v-photos').innerHTML = `<h1 style="font-size:22px;margin:4px 0 4px">Photos</h1><p class="muted">Add before and after photos to a job. You can add more at any time.</p>` +
        (todays.length ? todays.map(x => `<div class="card job" data-id="${x.j.id}"><h2>${esc(x.j.title)}</h2><div class="meta">${esc(x.j.address || '')}</div><div class="photos"><label class="btn ghost ph-up">Before<input type="file" accept="image/*" multiple style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden" data-ph="Before"></label><label class="btn ghost ph-up">After<input type="file" accept="image/*" multiple style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden" data-ph="After"></label></div></div>`).join('') : '<div class="card"><b>No jobs for today.</b></div>');
    }

    if (view === 'photos') { $('#v-photos').insertAdjacentHTML('beforeend', receiptCardHtml(todays)); wireReceipt(); }
    if (view === 'incidents') {
      $('#v-incidents').innerHTML = `<h1 style="font-size:22px;margin:4px 0 4px">Report an incident</h1><p class="muted">Use this for damage, access problems, missing supplies, complaints or safety issues. Reporting needs signal.</p>` +
        (todays.length ? todays.map(x => `<div class="card job" data-id="${x.j.id}"><h2>${esc(x.j.title)}</h2><div class="meta">${esc(x.j.address || '')}</div><div class="actions" style="grid-template-columns:1fr"><button class="danger big" data-a="incident">Report an incident for this job</button></div></div>`).join('') : '<div class="card"><b>No jobs for today.</b><p class="muted">Pick the job from My jobs when you have one.</p></div>');
    }

    if (view === 'profile') {
      $('#v-profile').innerHTML = `<h1 style="font-size:22px;margin:4px 0 10px">Profile</h1><div class="card"><b>${esc(d.employee.name)}</b><p class="muted" style="margin:4px 0 0">${esc(d.employee.role || '')}${d.employee.crew ? ' · Crew ' + esc(d.employee.crew) : ''}</p>${clockedIn ? `<p class="muted">Checked in since ${esc(clockedIn)}</p>` : '<p class="muted">Not checked in.</p>'}</div>`;
    }
    wire();
    banner();
  }

  // Crew receipt (Phase 2): a photo or PDF of a purchase, sent with the job. The office reviews it before it posts.
  function receiptCardHtml(list) {
    const opts = list.map(x => `<option value="${x.j.id}">${esc(x.j.title)}</option>`).join('');
    return `<div class="card" id="rc-card" style="margin-top:12px"><b>Add a receipt</b><p class="muted" style="margin:4px 0 10px">A photo or PDF of a purchase for a job. The office reviews it before it is posted.</p>
      <form id="rc-form" style="display:grid;gap:10px">
        <label>Job<select name="visit_id">${opts}<option value="">No job today</option></select></label>
        <label>Vendor<input name="vendor" required maxlength="120" placeholder="Store or supplier"></label>
        <label>Amount<input name="amount" inputmode="decimal" required placeholder="0.00"></label>
        <label>Type<select name="category"><option value="materials">Materials</option><option value="equipment">Equipment</option><option value="travel">Travel or fuel</option><option value="other">Other</option></select></label>
        <label>Note<input name="description" maxlength="300"></label>
        <label>Receipt photo or PDF<input type="file" name="receipt" accept="image/*,application/pdf" capture="environment" required></label>
        <button class="ok big" type="submit">Send receipt</button>
        <div id="rc-msg" class="muted" role="status"></div>
      </form></div>`;
  }
  function wireReceipt() {
    const rc = $('#rc-form'); if (!rc) return;
    rc.onsubmit = async ev => {
      ev.preventDefault();
      const msg = $('#rc-msg'), fd = new FormData(rc), file = fd.get('receipt');
      if (!file || !file.size) { msg.textContent = 'Choose a photo or PDF first.'; return; }
      if (!navigator.onLine) { msg.textContent = 'Receipts need signal. Send it when you have it.'; return; }
      msg.textContent = 'Sending…';
      try {
        const r = await fetch(`/api/crew/${token}/receipts`, { method: 'POST', headers: authHdr(), body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'The receipt did not send.');
        rc.reset(); msg.textContent = 'Receipt sent. The office will review it.';
      } catch (e) { msg.textContent = e.message; }
    };
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
          const body = { title: t, description: prompt('Details (optional)') || '', priority: 'High', category: (card.querySelector('[data-inc-cat]') || {}).value || 'Other' };
          b.disabled = true;
          try { await post(`/api/crew/${token}/jobs/${id}/incident`, body); say('Incident reported to the office.', true); }
          catch (e) { say(isOffline(e) ? 'Incidents need signal. Report it when you are connected.' : e.message); }
          b.disabled = false; return;
        }
        if (a === 'submit') {
          // Sending for review needs the server to see the checklist and photos, so it is not queued offline
          if (!navigator.onLine) return say('Sending for review needs signal. Try again when you are connected.');
          b.disabled = true;
          try { await post(`/api/crew/${token}/jobs/${id}/submit`, {}); say('Sent to the office for review.', true); await refresh(); }
          catch (e) { say(isOffline(e) ? 'Sending for review needs signal. Try again when you are connected.' : e.message); b.disabled = false; }
          return;
        }
        if (a === 'break') {
          // A break is sent straight to the server, like submit, so the clock is right at once
          if (!navigator.onLine) return say('Breaks need signal. Try again when you are connected.');
          b.disabled = true;
          try { await post(`/api/crew/${token}/jobs/${id}/break`, {}); say('Break updated.', true); await refresh(); }
          catch (e) { say(isOffline(e) ? 'Breaks need signal. Try again when you are connected.' : e.message); b.disabled = false; }
          return;
        }
        // Check-in records where the phone was, if the crew allows location. Without it, check-in still works.
        const geo = a === 'checkin' ? await currentSpot() : {};
        queueChange(id, a, geo);
        const refusal = await flush();
        const done = { checkin: 'Checked in.', checkout: 'Checked out.', complete: 'Job marked complete. Thank you!', onmyway: 'On my way. The client has been told.' }[a];
        const saved = { checkin: 'Check-in', checkout: 'Check-out', complete: 'Job completion', onmyway: 'On my way' }[a];
        if (refusal) { if (!queue().length) await refresh(); else render(); return; } // keep the refusal message on screen
        say(queue().length ? `${saved} saved on this phone. It will send when you have signal.` : done, true);
        if (!queue().length) await refresh(); else render();
      });
      const noteBtn = card.querySelector('[data-note-send]');
      if (noteBtn) noteBtn.onclick = async () => {
        const body = ((card.querySelector('[data-note-text]') || {}).value || '').trim();
        if (!body) return say('Write a note first.');
        if (!navigator.onLine) return say('Notes need signal. Send it when you are connected.');
        noteBtn.disabled = true;
        try { await post(`/api/crew/${token}/jobs/${id}/notes`, { body }); say('Note added to the job.', true); await refresh(); }
        catch (e) { say(isOffline(e) ? 'Notes need signal. Send it when you are connected.' : e.message); noteBtn.disabled = false; }
      };
      card.querySelectorAll('[data-ck]').forEach(c => c.onchange = async () => {
        queueChange(id, 'checklist', { index: Number(c.dataset.ck), done: c.checked });
        await flush();
        if (queue().length) render(); else await refresh();
      });
      card.querySelectorAll('[data-ph]').forEach(inp => inp.onchange = async () => {
        if (!inp.files.length) return;
        const files = [...inp.files]; let sent = 0;
        // No signal: keep the photos on the phone; they upload when it is back
        const keepOffline = async list => {
          try { await queuePhotos(list.map(f => ({ token, visitId: id, stage: inp.dataset.ph, blob: f, name: f.name, type: f.type, at: Date.now() }))); inp.value = ''; await flushPhotos(); say(`${list.length} photo(s) saved on this phone. They upload when you have signal.`, true); }
          catch { say('This phone cannot keep photos offline. Connect to upload them.'); }
        };
        if (!navigator.onLine) return keepOffline(files);
        try {
          // The server takes up to 6 files per request, so send larger picks in batches
          for (let i = 0; i < files.length; i += 6) {
            const fd = new FormData(); fd.append('stage', inp.dataset.ph); files.slice(i, i + 6).forEach(f => fd.append('photos', f));
            const r = await fetch(`/api/crew/${token}/jobs/${id}/photos`, { method: 'POST', headers: authHdr(), body: fd }).then(x => x.json().then(j => ({ ok: x.ok, j }))); if (!r.ok) throw new Error(r.j.error || 'Upload failed'); sent += r.j.ids.length;
          }
          inp.value = ''; say(`${sent} ${inp.dataset.ph.toLowerCase()} photo(s) uploaded. Add more any time.`, true);
        }
        catch (e) { if (isOffline(e)) return keepOffline(files.slice(sent)); say(e.message); }
      });
    });
  }

  // Messages with the office: one conversation, optionally tied to a job. Needs signal.
  async function loadMessages() {
    const box = $('#v-messages'); if (!box) return;
    let list = [];
    try { list = (await get(`/api/crew/${token}/messages`)).messages || []; }
    catch (e) { box.innerHTML = `<h1 style="font-size:22px;margin:4px 0 10px">Messages</h1><div class="msg err">${esc(isOffline(e) ? 'Messages need signal. Connect to read and send messages.' : e.message)}</div>`; return; }
    const jobs = d ? d.jobs : [];
    box.innerHTML = `<h1 style="font-size:22px;margin:4px 0 4px">Messages</h1><p class="muted">Messages go straight to the office. Pick a job if your message is about one.</p>
      <div class="card">${list.length ? list.map(m => `<div class="bubble ${m.direction === 'crew' ? 'me' : 'office'}"><small>${m.direction === 'crew' ? 'You' : 'Office'} · ${esc(hm(m.created_at))}</small><div>${esc(m.body)}</div></div>`).join('') : '<p class="muted">No messages yet.</p>'}</div>
      <form id="msgForm" class="card"><select id="msgJob" aria-label="About which job"><option value="">General (no job)</option>${jobs.map(j => `<option value="${j.id}">${esc(fmt(j.date))} · ${esc(j.title)}</option>`).join('')}</select>
        <textarea id="msgBody" rows="3" maxlength="1000" placeholder="Write a message to the office" style="margin-top:8px"></textarea>
        <button type="submit" class="primary big" style="margin-top:8px;width:100%">Send to office</button></form>`;
    box.querySelector('#msgForm').onsubmit = async ev => {
      ev.preventDefault();
      const body = box.querySelector('#msgBody').value.trim(); if (!body) return say('Write a message first.');
      const vid = box.querySelector('#msgJob').value;
      try { await post(`/api/crew/${token}/messages`, { body, visit_id: vid ? Number(vid) : null }); say('Message sent to the office.', true); loadMessages(); }
      catch (e) { say(isOffline(e) ? 'Messages need signal. Try again when you are connected.' : e.message); }
    };
  }

  // Navigation: the tab bar, the quick actions and the Today / Upcoming / Completed switch
  document.addEventListener('click', e => {
    const v = e.target.closest('[data-view], [data-view-go]');
    if (v) { view = v.dataset.view || v.dataset.viewGo; say(''); render(); if (view === 'messages') loadMessages(); scrollTo(0, 0); return; }
    const s = e.target.closest('[data-sub]');
    if (s) { sub = s.dataset.sub; render(); }
  });

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

  window.addEventListener('online', async () => { await flush(); await refresh(); flushPhotos(); });
  setInterval(() => { if (queue().length) flush().then(banner); flushPhotos(); }, 30000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/crew-sw.js').catch(() => { /* the page works without it */ });
  refresh().then(() => flush()).then(() => { if (!queue().length && d) refresh(); }).then(() => flushPhotos());
})();
