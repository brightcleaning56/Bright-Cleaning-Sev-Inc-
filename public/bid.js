// Bid without signing in. The page is opened from the link in an invitation email. Everything is built with DOM
// calls (no HTML strings), so values from the link or the bid cannot inject markup.
(() => {
  const root = document.getElementById('bid');
  const token = decodeURIComponent(location.pathname.split('/')[2] || '');
  const el = (tag, props = {}, kids = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'text') n.textContent = v; else if (k === 'class') n.className = v; else n.setAttribute(k, v); }
    for (const k of [].concat(kids)) if (k) n.append(k);
    return n;
  };
  const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fail = text => root.replaceChildren(el('div', { class: 'err', role: 'alert', text }));

  function summary(d) {
    const r = d.request;
    return el('div', { class: 'bid-summary' }, [
      el('h1', { text: r.title }),
      el('p', { class: 'bid-meta', text: `${r.address}, ${r.city}, ${r.state}${r.projectType ? ' · ' + r.projectType.replace(/_/g, ' ') : ''}` }),
      el('p', { class: 'bid-meta', text: `From ${r.buyerName || 'the GC'} · bids due ${r.dueDate}` }),
      r.trades.length ? el('p', { class: 'bid-meta', text: 'Trades: ' + r.trades.join(', ') }) : null,
      r.description ? el('p', { class: 'bid-desc', text: r.description }) : null,
    ]);
  }

  function field(label, input) { return el('label', { class: 'bid-field' }, [el('span', { text: label }), input]); }
  function input(name, props = {}) { return el('input', { name, id: name, ...props }); }

  function form(d) {
    const f = el('form', { class: 'pg-form bid-form', novalidate: '' });
    const err = el('p', { class: 'status err', role: 'alert' });
    const amount = input('amount', { inputmode: 'decimal', placeholder: 'e.g. 12,500', required: '' });
    const scope = el('textarea', { name: 'scope', id: 'scope', rows: '5', placeholder: 'What is included, at least 10 characters', required: '', minlength: '10' });
    const exclusions = el('textarea', { name: 'exclusions', id: 'exclusions', rows: '3', placeholder: 'What is not included or assumed (optional)' });
    const docs = input('documentUrl', { type: 'url', placeholder: 'https://… (optional)' });
    const valid = input('validDays', { type: 'number', min: '1', max: '365', placeholder: '30' });
    const recurring = el('input', { type: 'checkbox', name: 'recurring', id: 'recurring' });
    const cname = input('contactName', { autocomplete: 'name', required: '', maxlength: '120' });
    const cemail = input('contactEmail', { type: 'email', autocomplete: 'email', required: '', maxlength: '200' });
    const submit = el('button', { class: 'btn btn-primary', type: 'submit', text: d.submitted ? 'Revise my bid' : 'Submit bid' });
    f.append(
      el('div', { class: 'row2' }, [field('Your name', cname), field('Work email (the bid comes from this address)', cemail)]),
      field('Total price (USD)', amount),
      el('label', { class: 'bid-check' }, [recurring, el('span', { text: 'This is a monthly price, not a one-time total' })]),
      field('What is included', scope),
      field('Exclusions and assumptions', exclusions),
      el('div', { class: 'row2' }, [field('Link to your proposal (optional)', docs), field('Valid for (days)', valid)]),
      err,
      el('div', { class: 'row2 bid-actions' }, [el('p', { class: 'bid-note', text: 'Your bid is recorded with a receipt. You can revise it until the due date.' }), submit]));
    f.addEventListener('submit', async e => {
      e.preventDefault(); err.textContent = '';
      const body = { contactName: cname.value, contactEmail: cemail.value, amount: amount.value, scope: scope.value, exclusions: exclusions.value,
        documentUrl: docs.value || undefined, validDays: valid.value ? Number(valid.value) : undefined, recurring: recurring.checked };
      const amt = Number(String(body.amount).replace(/[$,\s]/g, ''));
      if (!(amt > 0)) { err.textContent = 'Enter the total price as a number greater than zero.'; amount.focus(); return; }
      if (String(body.scope).trim().length < 10) { err.textContent = 'Describe what is included (at least 10 characters).'; scope.focus(); return; }
      submit.disabled = true; submit.textContent = 'Sending…';
      try {
        const res = await fetch('/api/bid-link/' + encodeURIComponent(token), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || 'Your bid could not be sent. Please try again.');
        root.replaceChildren(el('div', { class: 'bid-done', role: 'status' }, [
          el('h2', { text: 'Bid received' }), el('p', { text: out.message }),
          el('p', { text: `Total ${money(out.submission.total)} · ${new Date(out.submission.submittedAt).toLocaleString()}` })]));
      } catch (ex) {
        err.textContent = ex.message; submit.disabled = false; submit.textContent = d.submitted ? 'Revise my bid' : 'Submit bid';
      }
    });
    return f;
  }

  async function load() {
    if (!token) return fail('This bid link is incomplete. Open the link from your invitation email.');
    let res, d;
    try { res = await fetch('/api/bid-link/' + encodeURIComponent(token)); d = await res.json().catch(() => ({})); }
    catch { return fail('We could not load this invitation. Check your connection and reload.'); }
    if (!res.ok) return fail(d.error || 'This bid link is invalid or has expired.');
    const parts = [summary(d)];
    if (!d.request.open) parts.push(el('div', { class: 'empty', text: 'This request is closed and no longer takes bids.' }));
    else if (!d.addendaAcknowledged) parts.push(el('div', { class: 'empty', text: `This request has ${d.request.addenda} addendum${d.request.addenda === 1 ? '' : 's'}. Sign in to BUILDINTEL to review and acknowledge ${d.request.addenda === 1 ? 'it' : 'them'} before you bid.` }));
    else {
      if (d.submitted) parts.push(el('p', { class: 'bid-note', text: 'You have already sent a bid for this request. Submitting again revises it.' }));
      parts.push(el('h2', { class: 'bid-h2', text: `Bid for ${d.company}` }), form(d));
    }
    root.replaceChildren(...parts);
  }
  load();
})();
