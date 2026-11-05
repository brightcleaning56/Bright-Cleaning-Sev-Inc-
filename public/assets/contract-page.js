(() => {
  const token = location.pathname.split('/').pop(), $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const say = (t, ok) => { $('#msg').innerHTML = t ? `<div class="msg ${ok ? 'ok' : 'err'}">${esc(t)}</div>` : ''; if (t) scrollTo(0, 0); };
  const post = async (u, j) => { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(j) }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Something went wrong'); return d; };
  async function load() {
    const r = await fetch('/api/contract/' + token); const d = await r.json().catch(() => ({}));
    if (!r.ok) { $('#app').innerHTML = `<div class="card"><h1>Contract unavailable</h1><p>${esc(d.error || 'This link is not valid.')}</p></div>`; return; }
    const k = d.contract, open = ['Sent', 'Viewed'].includes(k.signature_status);
    $('#app').innerHTML = `<div class="card"><h1>${esc(k.title || 'Services contract')}</h1><div class="muted">${esc(k.kind || 'Contract')} ${esc(k.number)} · ${esc(k.company || k.customer_name || '')}</div>
      <dl><dt>Term</dt><dd>${esc(k.start_date || '—')} to ${esc(k.end_date || '—')}</dd><dt>Contract value</dt><dd>${money(k.value)}</dd>${k.payment_terms ? `<dt>Payment terms</dt><dd>${esc(k.payment_terms)}</dd>` : ''}${k.billing ? `<dt>Billing</dt><dd>${esc(k.billing)}</dd>` : ''}${k.auto_renew ? `<dt>Renewal</dt><dd>Renews automatically unless either party gives ${k.notice_days || 30} days' notice</dd>` : ''}</dl>
      <div class="row"><a class="btn ghost" href="/api/contract/${token}/pdf">Download PDF</a></div><p class="muted" style="margin:10px 0 0">Questions? Office 515-329-5889 · Eric Moore (Owner) 469-267-8472 · info@brightclean.net</p></div>
      <div class="card"><h2>Scope of work</h2><div class="pre">${esc(k.scope || '')}</div></div>
      <div class="card"><h2>Terms and conditions</h2><div class="pre">${esc(k.terms || '')}</div></div>
      ${k.signature_status === 'Customer signed' || k.signature_status === 'Signed' ? `<div class="card"><h2>Signed</h2><p>Signed by <b>${esc(k.signer_name)}</b> on ${esc(String(k.signed_at).slice(0, 10))}.${k.countersigned_at ? ' Countersigned by Bright Cleaning Sev Inc. — this contract is in effect.' : ' Bright Cleaning Sev Inc. will countersign shortly.'}</p></div>` : ''}
      ${k.signature_status === 'Declined' ? `<div class="card"><h2>Declined</h2><p>You declined this contract: ${esc(k.decline_reason)}. We will follow up with an updated version.</p></div>` : ''}
      ${open ? `<div class="card"><h2>Sign</h2><label for="nm">Full name</label><input type="text" id="nm" autocomplete="name"><label for="tt">Title</label><input type="text" id="tt" autocomplete="organization-title">
        <label class="chk"><input type="checkbox" id="ag"> <span>I have read this contract and I am authorized to sign it on behalf of ${esc(k.company || 'my company')}. Typing my name is my electronic signature.</span></label>
        <div class="row"><button class="primary" id="sg">Sign contract</button><button class="ghost" id="dc">Decline…</button></div>
        <div id="dcBox" hidden><label for="rs">Why are you declining?</label><textarea id="rs" rows="3"></textarea><div class="row"><button class="ghost" id="dcGo">Send decline</button></div></div></div>` : ''}`;
    if (!open) return;
    $('#sg').onclick = async () => { $('#sg').disabled = true; try { await post(`/api/contract/${token}/sign`, { name: $('#nm').value.trim(), title: $('#tt').value.trim(), agree: $('#ag').checked }); say('Thank you — your signature was recorded.', true); load(); } catch (e) { say(e.message); $('#sg').disabled = false; } };
    $('#dc').onclick = () => { $('#dcBox').hidden = false; };
    $('#dcGo').onclick = async () => { try { await post(`/api/contract/${token}/decline`, { reason: $('#rs').value.trim() }); say('Your response was sent. We will follow up.', true); load(); } catch (e) { say(e.message); } };
  }
  load();
})();
