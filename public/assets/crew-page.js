(() => {
  const token = location.pathname.split('/').pop(), $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const say = (t, good) => { $('#msg').innerHTML = t ? `<div class="msg ${good ? 'good' : 'err'}">${esc(t)}</div>` : ''; if (t) scrollTo(0, 0); };
  const api = async (url, opt = {}) => { const r = await fetch(url, { method: opt.method || 'GET', headers: opt.json ? { 'Content-Type': 'application/json' } : {}, body: opt.json ? JSON.stringify(opt.json) : opt.body }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Something went wrong'); return j; };
  const fmt = d => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  async function load() {
    let d; try { d = await api('/api/crew/' + token); } catch (e) { $('#sub').textContent = ''; return say(e.message); }
    $('#who').textContent = d.employee.name; $('#sub').textContent = `${d.employee.role || ''}${d.employee.crew ? ' · Crew ' + d.employee.crew : ''}${d.clocked_in ? ' · Checked in since ' + new Date(d.clocked_in.since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}`;
    if (!d.jobs.length) { $('#jobs').innerHTML = '<div class="card"><b>No dispatched jobs this week.</b><p class="muted">Your supervisor will send jobs here once they are dispatched.</p></div>'; return; }
    $('#jobs').innerHTML = d.jobs.map(j => { const inHere = d.clocked_in && d.clocked_in.visit_id === j.id; const done = j.status === 'Done';
      return `<div class="card job" data-id="${j.id}"><span class="pill ${done ? 'done' : ''}">${esc(done ? 'Completed' : j.status)}</span><h2>${esc(j.title)}</h2>
        <div class="muted">${fmt(j.date)} · ${esc(j.start_time || '')}${j.end_time ? '–' + esc(j.end_time) : ''}</div>
        <div>${esc(j.address || '')}</div>${j.address ? `<div class="row"><a class="btn ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(j.address)}">Directions</a></div>` : ''}
        ${j.instructions ? `<div class="sec">Instructions</div><div>${esc(j.instructions)}</div>` : ''}${j.equipment ? `<div class="sec">Equipment &amp; supplies</div><div>${esc(j.equipment)}</div>` : ''}
        <div class="sec">Site access</div><div>${esc(j.access || '—')}${j.site_contact ? '<br>Contact: ' + esc(j.site_contact) : ''}</div>${j.safety ? `<div class="sec">Safety</div><div>${esc(j.safety)}</div>` : ''}
        <div class="muted" style="margin-top:6px">Crew: ${esc(j.crew.join(', '))}</div>
        ${j.checklist.length ? `<div class="sec">Checklist</div><ul class="check">${j.checklist.map((c, i) => `<li><input type="checkbox" data-ck="${i}" ${c.done ? 'checked' : ''} ${done ? 'disabled' : ''} aria-label="${esc(c.text || c.title || '')}"><span>${esc(c.text || c.title || '')}</span></li>`).join('')}</ul>` : ''}
        ${done ? '' : `<div class="row">${inHere ? '<button class="ghost" data-a="checkout">Check out</button>' : '<button class="primary" data-a="checkin">Check in</button>'}<button class="ok" data-a="complete">Mark job complete</button></div>
        <div class="row"><label class="btn ghost">Before photos<input type="file" accept="image/*" capture="environment" multiple hidden data-ph="Before"></label><label class="btn ghost">After photos<input type="file" accept="image/*" capture="environment" multiple hidden data-ph="After"></label></div>
        <div class="row"><button class="danger" data-a="incident">Report an incident</button></div>`}</div>`; }).join('');
    document.querySelectorAll('.job').forEach(card => {
      const id = card.dataset.id;
      card.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
        const a = b.dataset.a; let body = {};
        if (a === 'incident') { const t = prompt('What happened? (short)'); if (!t) return; body = { title: t, description: prompt('Details (optional)') || '', priority: 'High' }; }
        if (a === 'complete' && !confirm('Mark this job complete?')) return;
        b.disabled = true; try { await api(`/api/crew/${token}/jobs/${id}/${a}`, { method: 'POST', json: body }); say({ checkin: 'Checked in.', checkout: 'Checked out.', complete: 'Job marked complete. Thank you!', incident: 'Incident reported to the office.' }[a], true); load(); } catch (e) { say(e.message); b.disabled = false; }
      });
      card.querySelectorAll('[data-ck]').forEach(c => c.onchange = async () => { try { await api(`/api/crew/${token}/jobs/${id}/checklist`, { method: 'POST', json: { index: Number(c.dataset.ck), done: c.checked } }); } catch (e) { say(e.message); c.checked = !c.checked; } });
      card.querySelectorAll('[data-ph]').forEach(inp => inp.onchange = async () => { if (!inp.files.length) return; const fd = new FormData(); fd.append('stage', inp.dataset.ph); [...inp.files].forEach(f => fd.append('photos', f)); try { const r = await api(`/api/crew/${token}/jobs/${id}/photos`, { method: 'POST', body: fd }); say(`${r.ids.length} photo(s) uploaded.`, true); } catch (e) { say(e.message); } inp.value = ''; });
    });
  }
  load();
})();
