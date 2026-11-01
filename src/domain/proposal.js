'use strict';

const { escapeHtml, sha256 } = require('../util');

const DISCLAIMER = 'This is a cost estimate prepared from the information available when it was made. '
  + 'It is not a guarantee of project award or a confirmed contract. Final pricing depends on the '
  + 'scope, site conditions and written agreement between the parties.';

const money = (n) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/**
 * Builds the proposal document. Every user-supplied value is HTML-escaped so a
 * project name cannot inject markup into the document sent to a GC.
 */
function renderProposal({ org, opportunity, permit, estimate, validUntil, version = 1 }) {
  const rows = estimate.lineItems
    .filter((li) => li.amount !== 0)
    .map((li) => `<tr><td>${escapeHtml(li.label)}</td><td class="num">${money(li.amount)}</td></tr>`)
    .join('\n');
  const addr = org.legal.postalAddress;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Proposal - ${escapeHtml(permit.projectName)}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;color:#1d2330;margin:40px;max-width:820px}
h1{font-size:22px;margin:0 0 4px} table{width:100%;border-collapse:collapse;margin-top:16px}
td{padding:8px;border-bottom:1px solid #d9dde5} .num{text-align:right} .total td{font-weight:bold}
.muted{color:#5b6472;font-size:13px} .disclaimer{margin-top:24px;font-size:12px;color:#5b6472}
</style></head><body>
<h1>${escapeHtml(org.legal.legalName)}</h1>
<div class="muted">${escapeHtml(addr.line1)}, ${escapeHtml(addr.city)}, ${escapeHtml(addr.state)} ${escapeHtml(addr.postalCode)}</div>
<h2>Proposal v${version}: ${escapeHtml(permit.projectName)}</h2>
<div><strong>Project address:</strong> ${escapeHtml(permit.propertyAddress)}, ${escapeHtml(permit.city)}, ${escapeHtml(permit.state)}</div>
<div><strong>Permit:</strong> ${escapeHtml(permit.permitId)} (source: <a href="${escapeHtml(permit.sourceUrl)}">${escapeHtml(permit.sourceUrl)}</a>)</div>
<div><strong>Square feet:</strong> ${permit.squareFeet ? escapeHtml(Number(permit.squareFeet).toLocaleString('en-US')) : 'to be confirmed'}</div>
<div><strong>Pricing basis:</strong> ${escapeHtml(estimate.basis)}</div>
<div><strong>Valid until:</strong> ${escapeHtml(validUntil)}</div>
<table>
${rows}
<tr class="total"><td>Total</td><td class="num">${money(estimate.total)}</td></tr>
</table>
<p>${escapeHtml(org.proposal?.scope || '')}</p>
<p class="disclaimer">${escapeHtml(DISCLAIMER)}</p>
<p class="disclaimer">Opportunity reference: ${escapeHtml(opportunity.id)}</p>
</body></html>`;
  return { html, hash: sha256(html), subject: `Proposal: ${permit.projectName} (${permit.permitId})` };
}

module.exports = { renderProposal, DISCLAIMER };
