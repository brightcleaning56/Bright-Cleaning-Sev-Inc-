(() => {
  const form = document.getElementById('qForm');
  if (!form) return;
  const $ = id => document.getElementById(id);
  const KEY = 'bc_quote_draft_v1';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let schema = {}, current = null;

  const store = {
    get() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } },
    set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage unavailable */ } },
    clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
  };

  function answers() {
    const fd = new FormData(form), out = {};
    for (const [k, v] of fd.entries()) {
      if (v instanceof File) continue;
      if (out[k] !== undefined) out[k] = [].concat(out[k], v); else out[k] = v;
    }
    form.querySelectorAll('.qmulti').forEach(m => { const n = m.dataset.name; out[n] = [...m.querySelectorAll('input:checked')].map(i => i.value); });
    return out;
  }
  const visible = (f, a) => !f.show_if || (f.show_if.has ? [].concat(a[f.show_if.field] || []).includes(f.show_if.has) : a[f.show_if.field] === f.show_if.is);

  function fieldHtml(f) {
    const id = 'f_' + f.name, req = f.required ? ' *' : '', r = f.required ? ' required' : '';
    if (f.type === 'select') return `<label for="${id}">${esc(f.label)}${req}</label><select id="${id}" name="${f.name}"${r}><option value="">Select</option>${f.options.map(o => `<option>${esc(o)}</option>`).join('')}</select>`;
    if (f.type === 'yesno') return `<label for="${id}">${esc(f.label)}${req}</label><select id="${id}" name="${f.name}"${r}><option value="">Select</option><option>Yes</option><option>No</option></select>`;
    if (f.type === 'multi') return `<span class="label" id="${id}">${esc(f.label)}${req}</span><div class="qmulti" data-name="${f.name}" role="group" aria-labelledby="${id}">${f.options.map(o => `<label><input type="checkbox" name="${f.name}" value="${esc(o)}"> ${esc(o)}</label>`).join('')}</div>`;
    if (f.type === 'textarea') return `<label for="${id}">${esc(f.label)}${req}</label><textarea id="${id}" name="${f.name}"${r}></textarea>`;
    const t = f.type === 'number' ? 'text" inputmode="decimal' : f.type === 'date' ? 'date' : 'text';
    return `<label for="${id}">${esc(f.label)}${req}</label><input id="${id}" name="${f.name}" type="${t}"${r}>`;
  }

  function choose(key, restore) {
    current = key;
    const def = schema[key];
    [...$('qSvc').children].forEach(b => b.setAttribute('aria-checked', String(b.dataset.key === key)));
    $('qSvcTitle').textContent = '2. About the job — ' + def.title;
    $('qFields').innerHTML = def.fields.map(f => `<div class="field${f.type === 'multi' || f.type === 'textarea' ? ' full' : ''}" data-f="${f.name}">${fieldHtml(f)}</div>`).join('');
    $('qStep1').hidden = true; $('qStep2').hidden = false; $('qStep3').hidden = true;
    if (restore) fill(restore);
    applyVisibility();
    if (!restore) $('qFields').querySelector('input,select,textarea')?.focus();
  }

  function fill(a) {
    for (const [k, v] of Object.entries(a)) {
      if (k === 'service_key' || k === 'consent') continue;
      const multi = [...form.querySelectorAll('.qmulti')].find(m => m.dataset.name === k);
      if (multi) { [].concat(v).forEach(x => { const i = [...multi.querySelectorAll('input')].find(i => i.value === x); if (i) i.checked = true; }); continue; }
      const el = form.elements[k];
      if (el && !(el instanceof RadioNodeList) && el.type !== 'file' && el.type !== 'checkbox') el.value = v;
    }
  }

  function applyVisibility() {
    if (!current) return;
    const a = answers();
    for (const f of schema[current].fields) {
      const wrap = $('qFields').querySelector(`[data-f="${f.name}"]`);
      const show = visible(f, a);
      wrap.hidden = !show;
      wrap.querySelectorAll('input,select,textarea').forEach(el => { el.disabled = !show; });
    }
  }

  function save() { if (current) store.set({ service_key: current, ...answers(), saved_at: Date.now() }); }

  function check() {
    const a = answers(), errs = [];
    form.querySelectorAll('.field.err').forEach(e => e.classList.remove('err'));
    const bad = (name, msg) => { errs.push(msg); form.querySelector(`[data-f="${name}"]`)?.classList.add('err'); const el = form.elements[name]; if (el && el.closest) el.closest('.field')?.classList.add('err'); };
    for (const f of schema[current].fields) {
      if (!visible(f, a)) continue;
      const v = a[f.name];
      const empty = Array.isArray(v) ? !v.length : !String(v ?? '').trim();
      if (f.required && empty) { bad(f.name, `${f.label} is required.`); continue; }
      if (f.type === 'number' && !empty) { const n = Number(String(v).replace(/,/g, '')); if (!Number.isFinite(n) || n < (f.min ?? 0)) bad(f.name, `${f.label} must be a number${f.min ? ' of at least ' + f.min : ''}.`); }
    }
    if (!String(a.contact_name || '').trim()) bad('contact_name', 'Your name is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(a.email || ''))) bad('email', 'Enter a valid email address.');
    if (!String(a.phone || '').trim()) bad('phone', 'Phone is required.');
    if (!String(a.address || '').trim()) bad('address', 'Service address is required.');
    if (!form.elements.consent.checked) bad('consent', 'Please agree to be contacted about this request.');
    return errs;
  }

  function review() {
    const errs = check();
    $('qErr').textContent = errs.join(' ');
    $('qErr').className = 'form-status' + (errs.length ? ' error' : '');
    if (errs.length) { form.querySelector('.field.err input, .field.err select, .field.err textarea')?.focus(); return; }
    const a = answers(), rows = [['Service', schema[current].title]];
    for (const f of schema[current].fields) if (visible(f, a)) { const v = [].concat(a[f.name] ?? []).filter(x => String(x).trim()); if (v.length) rows.push([f.label, v.join(', ')]); }
    rows.push(['Name', a.contact_name], ['Company', a.company], ['Email', a.email], ['Phone', a.phone], ['Address', a.address], ['Notes', a.notes]);
    const files = [...($('q_files').files || [])].map(f => f.name);
    if (files.length) rows.push(['Files', files.join(', ')]);
    $('qSum').innerHTML = rows.filter(r => String(r[1] || '').trim()).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    $('qStep2').hidden = true; $('qStep3').hidden = false; $('qSend').focus();
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(form);
    fd.set('service_key', current);
    $('qSend').disabled = true; $('qStatus').textContent = 'Sending…'; $('qStatus').className = 'form-status';
    try {
      const r = await fetch('/api/quotes', { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Something went wrong. Please call +1 (515) 303-3024.');
      store.clear();
      $('qStep3').hidden = true; $('qDone').hidden = false; if ($('qDone').scrollIntoView) $('qDone').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      $('qStatus').textContent = err.message; $('qStatus').className = 'form-status error'; $('qSend').disabled = false;
    }
  });

  $('qReview').addEventListener('click', review);
  $('qBack').addEventListener('click', () => { $('qStep3').hidden = true; $('qStep2').hidden = false; });
  $('qChange').addEventListener('click', () => { $('qStep2').hidden = true; $('qStep1').hidden = false; save(); });
  $('qClear').addEventListener('click', () => { if (!confirm('Clear your answers and start over?')) return; store.clear(); form.reset(); current = null; $('qStep2').hidden = true; $('qStep1').hidden = false; [...$('qSvc').children].forEach(b => b.setAttribute('aria-checked', 'false')); });
  form.addEventListener('input', () => { applyVisibility(); save(); });
  form.addEventListener('change', () => { applyVisibility(); save(); });

  fetch('/api/quote-schema').then(r => r.json()).then(j => {
    schema = j.services;
    $('qSvc').innerHTML = Object.entries(schema).map(([k, s]) => `<button type="button" role="radio" aria-checked="false" data-key="${k}"><b>${esc(s.title)}</b><span>${esc(s.blurb)}</span></button>`).join('');
    [...$('qSvc').children].forEach(b => b.addEventListener('click', () => {
      const keep = current === b.dataset.key ? answers() : null;
      choose(b.dataset.key, keep); save();
    }));
    const want = new URLSearchParams(location.search).get('service');
    const draft = store.get();
    if (draft && schema[draft.service_key] && (!want || want === draft.service_key)) {
      choose(draft.service_key, draft);
      $('qErr').textContent = 'We restored the answers you started earlier.'; $('qErr').className = 'form-status';
    } else if (want && schema[want]) choose(want);
  }).catch(() => { $('qSvc').innerHTML = '<p>Unable to load the form. Please call +1 (515) 303-3024 or use the <a href="/request-a-quote.html">bid request form</a>.</p>'; });
})();
