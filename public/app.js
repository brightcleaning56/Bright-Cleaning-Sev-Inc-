'use strict';

// BUILDINTEL owner console. Plain JavaScript, no external scripts, no inline handlers,
// so it runs under the strict Content-Security-Policy set by the server.

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const toastEl = document.getElementById('toast');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const money = (n) => Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// The admin key lives only in sessionStorage, so it is forgotten when the tab closes.
const getKey = () => { try { return sessionStorage.getItem('bi_admin') || ''; } catch (_) { return ''; } };
const setKey = (k) => { try { sessionStorage.setItem('bi_admin', k); } catch (_) { /* private mode */ } };
const clearKey = () => { try { sessionStorage.removeItem('bi_admin'); } catch (_) { /* ignore */ } };

let toastTimer = null;
function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = isError ? 'toast err' : 'toast';
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4500);
}

async function api(method, path, body, orgId) {
  const headers = { 'x-admin-key': getKey() };
  if (orgId) headers['x-org-id'] = orgId;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (res.status === 401) {
    clearKey();
    location.hash = '#/login';
    throw new Error('Admin key rejected. Sign in again.');
  }
  if (!res.ok) {
    const detail = data.details ? `: ${data.details.join('; ')}` : '';
    throw new Error((data.error || `Request failed (${res.status})`) + detail);
  }
  return data;
}

const badge = (status) => `<span class="badge ${esc(status)}">${esc(String(status).replace(/_/g, ' '))}</span>`;

function setView(html) {
  app.innerHTML = html;
}

async function run(fn) {
  try {
    await fn();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- login ----------

function viewLogin() {
  nav.hidden = true;
  setView(`
    <div class="card narrow">
      <h1>Owner sign-in</h1>
      <p class="muted">Enter the admin key set on the server (BUILDINTEL_ADMIN_KEY). It is kept for this browser tab only.</p>
      <form id="login">
        <label>Admin key <input id="admin-key" type="password" autocomplete="off" required minlength="24"></label>
        <button type="submit">Sign in</button>
      </form>
    </div>`);
  document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = document.getElementById('admin-key').value.trim();
    setKey(key);
    await run(async () => {
      await api('GET', '/api/readiness');
      location.hash = '#/';
    });
    if (!getKey()) return;
  });
}

// ---------- dashboard ----------

async function viewDashboard() {
  const [readiness, orgs, queue] = await Promise.all([
    api('GET', '/api/readiness'),
    api('GET', '/api/admin/orgs'),
    api('GET', '/api/admin/queue'),
  ]);
  setView(`
    <h1>Dashboard</h1>
    <div class="row">
      <div class="card kpi">
        <div class="muted">Go-live gates</div>
        <div class="big">${readiness.passed} / ${readiness.total}</div>
        <div>${readiness.goLive ? '<span class="pass">GO</span>' : '<span class="fail">NO-GO</span>'}</div>
      </div>
      <div class="card kpi">
        <div class="muted">Tenants</div><div class="big">${orgs.length}</div>
      </div>
      <div class="card kpi">
        <div class="muted">Waiting for your approval</div><div class="big">${queue.length}</div>
        <a href="#/queue">Open approval queue</a>
      </div>
    </div>
    <div class="row">
      <button id="run-cycle" type="button">Run autopilot cycle now</button>
      <span class="muted">Runs sync, matching, pricing and drafting for every active tenant. Dry-run unless send mode is live.</span>
    </div>
    <h2>Go-live gates</h2>
    <div class="card"><table>
      <tr><th>Status</th><th>Gate</th><th>Detail</th></tr>
      ${readiness.gates.map((g) => `<tr><td class="${esc(g.status)}">${esc(g.status.replace('_', ' '))}</td><td>${esc(g.label)}</td><td class="muted">${esc(g.detail)}</td></tr>`).join('')}
    </table></div>
    <h2>Tenants</h2>
    <div class="card">${orgs.length === 0 ? '<p class="muted">No tenants yet. <a href="#/setup">Create the first one.</a></p>' : `
      <table>
        <tr><th>Name</th><th>Status</th><th>Autopilot</th><th>Territories</th></tr>
        ${orgs.map((o) => `<tr>
          <td><a href="#/tenant/${esc(o.id)}">${esc(o.name)}</a></td>
          <td>${badge(o.status)}</td>
          <td>${o.autopilot && o.autopilot.enabled ? `on (limit ${money(o.autopilot.autoApproveMaxTotal)})` : 'off'}</td>
          <td>${esc((o.profile.territories || []).map((t) => `${t.state}${t.cities && t.cities.length ? ` (${t.cities.join(', ')})` : ''}`).join('; '))}</td>
        </tr>`).join('')}
      </table>`}</div>`);

  document.getElementById('run-cycle').addEventListener('click', () => run(async () => {
    const report = await api('POST', '/api/admin/autopilot/run');
    const s = report.orgs.flatMap((o) => o.results);
    toast(`Cycle done: ${s.length} permit decisions, ${report.sources.filter((x) => x.status === 'ok').length} sources synced`);
    viewDashboard();
  }));
}

// ---------- new tenant ----------

function parseTerritories(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [state, cities = ''] = line.split(':');
    return {
      state: state.trim().toUpperCase(),
      cities: cities.split(',').map((c) => c.trim()).filter(Boolean),
    };
  });
}

function viewSetup() {
  const types = ['office', 'retail', 'warehouse', 'multifamily', 'school', 'institutional', 'medical', 'industrial'];
  setView(`
    <h1>New tenant</h1>
    <form id="setup" class="card">
      <div class="grid">
        <label>Display name <input name="name" required></label>
        <label>Legal name <input name="legalName" required></label>
        <label>Business email <input name="email" type="email" required></label>
        <label>Street address <input name="line1" required></label>
        <label>Address line 2 <input name="line2"></label>
        <label>City <input name="city" required></label>
        <label>State <input name="state" maxlength="2" required></label>
        <label>ZIP <input name="postalCode" required></label>
        <label>Minimum square feet <input name="minSquareFeet" type="number" min="0" value="5000"></label>
        <label>Auto-approve limit (USD) <input name="autoApproveMaxTotal" type="number" min="0" value="1000"></label>
      </div>
      <label>Service territories, one per line as "ST: City, City" (leave cities empty for whole state)
        <textarea name="territories" required placeholder="IA: Des Moines, West Des Moines, Ankeny&#10;TX: Dallas"></textarea>
      </label>
      <fieldset class="plain">
        <legend class="muted">Project types</legend>
        <div class="grid">${types.map((t) => `<label><input type="checkbox" name="projectTypes" value="${t}" ${['office', 'retail', 'warehouse'].includes(t) ? 'checked' : ''}> ${t}</label>`).join('')}</div>
      </fieldset>
      <label>Scope statement shown on proposals <textarea name="scope"></textarea></label>
      <label><input type="checkbox" name="autopilotEnabled" checked> Autopilot enabled</label>
      <div class="row"><button type="submit">Create tenant</button><a href="#/">Cancel</a></div>
    </form>
    <div id="created"></div>`);

  document.getElementById('setup').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {
      name: f.get('name'),
      legalName: f.get('legalName'),
      email: f.get('email'),
      postalAddress: {
        line1: f.get('line1'), line2: f.get('line2') || '', city: f.get('city'),
        state: f.get('state'), postalCode: f.get('postalCode'),
      },
      territories: parseTerritories(f.get('territories')),
      projectTypes: f.getAll('projectTypes'),
      minSquareFeet: Number(f.get('minSquareFeet') || 0),
      scope: f.get('scope') || '',
      autopilot: { enabled: f.get('autopilotEnabled') === 'on', autoApproveMaxTotal: Number(f.get('autoApproveMaxTotal') || 0) },
    };
    run(async () => {
      const created = await api('POST', '/api/orgs', body);
      document.getElementById('created').innerHTML = `
        <div class="card">
          <h2>Tenant created: ${esc(created.org.name)}</h2>
          <p>Tenant API key (shown once; this console does not need it, but the tenant's own portal would):</p>
          <div class="keybox">${esc(created.apiKey)}</div>
          <p><a href="#/tenant/${esc(created.org.id)}">Open the tenant to add rate cards and contacts</a></p>
        </div>`;
      toast('Tenant created');
    });
  });
}

// ---------- tenant ----------

async function viewTenant(orgId) {
  const data = await api('GET', `/api/admin/orgs/${encodeURIComponent(orgId)}/overview`);
  const { org, contacts, opportunities, bids, audit } = data;
  const cards = (org.pricing && org.pricing.rateCards) || [];
  // Blank template on purpose: the owner must enter real rates. Saving it untouched is rejected by validation.
  const exampleCard = JSON.stringify([{
    service: 'final_clean', productionRate: null, laborRate: null, burdenPct: null, supervisionPct: null,
    overheadPct: null, marginPct: null, materialsPerSqFt: null, equipmentPerDay: null, days: 1, minimumBid: null,
    projectTypes: [],
  }], null, 2);

  setView(`
    <h1>${esc(org.name)} ${badge(org.status)}</h1>
    <p class="muted">${esc(org.legal.legalName)} · ${esc(org.legal.postalAddress.line1)}, ${esc(org.legal.postalAddress.city)}, ${esc(org.legal.postalAddress.state)} ${esc(org.legal.postalAddress.postalCode)}</p>

    <h2>Autopilot</h2>
    <form id="autopilot" class="card row">
      <label class="inline"><input type="checkbox" name="enabled" ${org.autopilot && org.autopilot.enabled ? 'checked' : ''}> Enabled</label>
      <label class="inline">Auto-approve limit (USD) <input name="autoApproveMaxTotal" type="number" min="0" value="${esc((org.autopilot && org.autopilot.autoApproveMaxTotal) || 0)}" class="w160"></label>
      <button type="submit">Save autopilot</button>
    </form>

    <h2>Rate cards</h2>
    <form id="pricing" class="card">
      <p class="muted">Enter one rate card per service as JSON. Everything is validated on save. Current cards: ${cards.length}.</p>
      <textarea name="cards">${esc(cards.length ? JSON.stringify(cards, null, 2) : exampleCard)}</textarea>
      <div class="row mt8"><button type="submit">Save rate cards</button></div>
    </form>

    <h2>Contacts</h2>
    <div class="card">
      ${contacts.length === 0 ? '<p class="muted">No contacts yet.</p>' : `
      <table>
        <tr><th>Company</th><th>Name</th><th>Email</th><th>Status</th><th>Source</th></tr>
        ${contacts.map((c) => `<tr><td>${esc(c.company)}</td><td>${esc(c.name)}</td><td>${esc(c.email)}</td><td>${badge(c.status)}</td><td class="muted">${esc(c.source)}</td></tr>`).join('')}
      </table>`}
      <form id="add-contact" class="grid mt12">
        <label>Company <input name="company" required></label>
        <label>Contact name <input name="name"></label>
        <label>Role <input name="role"></label>
        <label>Email <input name="email" type="email" required></label>
        <div class="row"><button type="submit">Add contact (unverified)</button></div>
      </form>
      ${contacts.length ? `
      <form id="verify-contact" class="grid mt12">
        <label>Contact <select name="contactId">${contacts.map((c) => `<option value="${esc(c.id)}">${esc(c.company)} · ${esc(c.email)} (${esc(c.status)})</option>`).join('')}</select></label>
        <label>Status <select name="status">
          <option value="verified">verified</option>
          <option value="source_confirmed">source_confirmed</option>
          <option value="probable">probable</option>
          <option value="outdated">outdated</option>
        </select></label>
        <label>Source (how you confirmed it) <input name="source" required placeholder="e.g. GC bid list, phone call 10/30"></label>
        <div class="row"><button type="submit">Record verification</button></div>
      </form>` : ''}
    </div>

    <h2>Opportunities</h2>
    <div class="card">${opportunities.length === 0 ? '<p class="muted">No opportunities yet. Run a cycle from the dashboard.</p>' : `
      <table>
        <tr><th>Status</th><th>Score</th><th>Reasons</th><th>Detail</th></tr>
        ${opportunities.map((o) => `<tr><td>${badge(o.status)}</td><td>${esc(o.score)}</td><td class="muted">${esc((o.reasons || []).join('; '))}</td><td class="muted">${esc(o.statusDetail)}</td></tr>`).join('')}
      </table>`}</div>

    <h2>Bids</h2>
    <div class="card">${bids.length === 0 ? '<p class="muted">No bids yet.</p>' : `
      <table>
        <tr><th>Project</th><th>Total</th><th>Status</th><th>Blockers / notes</th><th></th></tr>
        ${bids.map((b) => `<tr>
          <td>${esc(b.project ? `${b.project.projectName} (${b.project.permitId})` : b.id)}</td>
          <td>${money(b.total)}</td>
          <td>${badge(b.status)}</td>
          <td class="muted">${esc((b.blockers || []).join('; ') || (b.dispatch ? `dry-run preview: ${b.dispatch.previewFile}` : ''))}</td>
          <td class="row">
            ${b.status === 'pending_approval' ? `<button type="button" data-approve="${esc(b.id)}">Approve</button>` : ''}
            ${['draft', 'pending_approval', 'approved'].includes(b.status) ? `<button type="button" class="secondary" data-withdraw="${esc(b.id)}">Withdraw</button>` : ''}
          </td>
        </tr>`).join('')}
      </table>`}</div>

    <h2>Audit (latest 50)</h2>
    <div class="card"><table>
      <tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th></tr>
      ${audit.map((a) => `<tr><td class="muted">${esc(a.createdAt)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td class="muted">${esc(a.entityId)}</td></tr>`).join('')}
    </table></div>`);

  document.getElementById('autopilot').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    run(async () => {
      await api('POST', '/api/me/autopilot', {
        enabled: f.get('enabled') === 'on',
        autoApproveMaxTotal: Number(f.get('autoApproveMaxTotal') || 0),
      }, orgId);
      toast('Autopilot saved');
      viewTenant(orgId);
    });
  });

  document.getElementById('pricing').addEventListener('submit', (e) => {
    e.preventDefault();
    run(async () => {
      let rateCards;
      try { rateCards = JSON.parse(new FormData(e.target).get('cards')); } catch (_) {
        throw new Error('Rate cards must be valid JSON');
      }
      await api('PUT', '/api/me/pricing', { rateCards }, orgId);
      toast('Rate cards saved and validated');
      viewTenant(orgId);
    });
  });

  const addForm = document.getElementById('add-contact');
  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    run(async () => {
      await api('POST', '/api/contacts', {
        company: f.get('company'), name: f.get('name'), role: f.get('role'), email: f.get('email'),
      }, orgId);
      toast('Contact added as unverified');
      viewTenant(orgId);
    });
  });

  const verifyForm = document.getElementById('verify-contact');
  if (verifyForm) {
    verifyForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      run(async () => {
        await api('POST', `/api/contacts/${encodeURIComponent(f.get('contactId'))}/verify`, {
          orgId, status: f.get('status'), source: f.get('source'),
        });
        toast('Verification recorded');
        viewTenant(orgId);
      });
    });
  }

  app.querySelectorAll('[data-approve]').forEach((btn) => btn.addEventListener('click', () => run(async () => {
    const result = await api('POST', `/api/bids/${encodeURIComponent(btn.dataset.approve)}/approve`, undefined, orgId);
    toast(`Approved. Dispatch: ${result.dispatch.status}${result.dispatch.mode ? ` (${result.dispatch.mode})` : ''}`);
    viewTenant(orgId);
  })));
  app.querySelectorAll('[data-withdraw]').forEach((btn) => btn.addEventListener('click', () => run(async () => {
    if (!confirm('Withdraw this bid? This cannot be undone.')) return;
    await api('POST', `/api/bids/${encodeURIComponent(btn.dataset.withdraw)}/withdraw`, undefined, orgId);
    toast('Bid withdrawn');
    viewTenant(orgId);
  })));
}

// ---------- approval queue ----------

async function viewQueue() {
  const [queue, orgs] = await Promise.all([api('GET', '/api/admin/queue'), api('GET', '/api/admin/orgs')]);
  const names = Object.fromEntries(orgs.map((o) => [o.id, o.name]));
  setView(`
    <h1>Approval queue</h1>
    <p class="muted">Bids that need your decision: unconfirmed permits, bids above the auto-approval limit, or new GC relationships.</p>
    <div class="card">${queue.length === 0 ? '<p class="muted">Nothing waiting. The autopilot is handling everything inside your limits.</p>' : `
      <table>
        <tr><th>Tenant</th><th>Total</th><th>Status</th><th></th></tr>
        ${queue.map((b) => `<tr>
          <td>${esc(names[b.orgId] || b.orgId)}</td>
          <td>${money(b.total)}</td>
          <td>${badge(b.status)}</td>
          <td class="row">
            <button type="button" data-approve="${esc(b.id)}" data-org="${esc(b.orgId)}">Approve</button>
            <a href="#/tenant/${esc(b.orgId)}">Review</a>
          </td>
        </tr>`).join('')}
      </table>`}</div>`);
  app.querySelectorAll('[data-approve]').forEach((btn) => btn.addEventListener('click', () => run(async () => {
    const result = await api('POST', `/api/bids/${encodeURIComponent(btn.dataset.approve)}/approve`, undefined, btn.dataset.org);
    toast(`Approved. Dispatch: ${result.dispatch.status}`);
    viewQueue();
  })));
}

// ---------- routing ----------

async function route() {
  const hash = location.hash || '#/';
  if (!getKey() && hash !== '#/login') {
    location.hash = '#/login';
    return;
  }
  if (hash === '#/login') return viewLogin();
  nav.hidden = false;
  if (hash === '#/' || hash === '') return viewDashboard();
  if (hash === '#/setup') return viewSetup();
  if (hash === '#/queue') return viewQueue();
  const m = hash.match(/^#\/tenant\/([^/]+)$/);
  if (m) return viewTenant(decodeURIComponent(m[1]));
  setView('<p class="muted">Page not found.</p>');
  return undefined;
}

document.getElementById('signout').addEventListener('click', () => {
  clearKey();
  location.hash = '#/login';
});

window.addEventListener('hashchange', () => run(route));
run(route);
