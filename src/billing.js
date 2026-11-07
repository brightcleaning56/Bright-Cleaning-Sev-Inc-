import { leadAccessFrom } from './entitlements.js';
import { config } from './config.js';

export const ALL_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];

// Lead-intelligence plans: priced by territory (states), not per city market.
// Prices are starting points for market testing; the owner sets the real ones in Stripe.
export const LEAD_PLANS = {
  trial:    { name: 'Free trial (14 days)', monthly: 0, states: 1, savedSearches: 3, exportsPerMonth: 0, contactDetails: true, seats: 1 },
  local:    { name: 'Local', monthly: 79, states: 1, savedSearches: 10, exportsPerMonth: 500, contactDetails: true, seats: 2 },
  regional: { name: 'Regional', monthly: 149, states: 3, savedSearches: 25, exportsPerMonth: 2500, contactDetails: true, seats: 5 },
  national: { name: 'National', monthly: 399, states: 51, savedSearches: 100, exportsPerMonth: 20000, contactDetails: true, seats: 15 },
};

/** What a company may see in the lead database right now. */
export function leadAccess(org) {
  return leadAccessFrom(org);   // unified catalog (src/entitlements.js); LEAD_PLANS kept only for reference/back-compat
}

// Deprecated: superseded by the unified catalog in src/entitlements.js (kept so older references resolve).
export const PLANS = {
  starter: { name: 'Starter', monthly: 99, bidsPerMonth: 5, seats: 1 },
  professional: { name: 'Professional', monthly: 249, bidsPerMonth: Infinity, seats: 3 },
  business: { name: 'Business', monthly: 499, bidsPerMonth: Infinity, seats: 10 },
  internal: { name: 'Internal (platform-owned company)', monthly: 0, bidsPerMonth: Infinity, seats: 50 },
};

export function entitled(org) {
  const sub = org.subscription || {};
  if (sub.plan === 'internal') return { ok: true, plan: PLANS.internal };
  if (!['active', 'trialing'].includes(sub.status)) return { ok: false, reason: `subscription ${sub.status || 'none'}` };
  return { ok: true, plan: PLANS[sub.plan] };
}

export async function createCheckout(org, plan, { fetchImpl = fetch } = {}) {
  const price = config.stripePrices[plan];
  if (!config.stripeSecret || !price) return { ok: false, error: 'Stripe not configured for this plan' };
  const body = new URLSearchParams({
    mode: 'subscription', 'line_items[0][price]': price, 'line_items[0][quantity]': '1',
    client_reference_id: org.id, 'subscription_data[metadata][orgId]': org.id,
    success_url: `${config.baseUrl}/?billing=success`, cancel_url: `${config.baseUrl}/?billing=cancel`,
  });
  if (org.stripeCustomerId) body.set('customer', org.stripeCustomerId);
  const res = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST', headers: { Authorization: `Bearer ${config.stripeSecret}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const json = await res.json();
  if (!res.ok) return { ok: false, error: json.error?.message || `stripe ${res.status}` };
  return { ok: true, url: json.url };
}

const planForPrice = id => Object.entries(config.stripePrices).find(([, p]) => p && p === id)?.[0] || null;

/** Apply a verified Stripe event. Caller must verify the signature first. */
export function applyStripeEvent(store, ev) {
  const o = ev.data?.object || {};
  const orgId = o.client_reference_id || o.metadata?.orgId || o.subscription_details?.metadata?.orgId;
  const org = orgId ? store.get('orgs', orgId) : store.list('orgs', x => x.stripeCustomerId && x.stripeCustomerId === o.customer)[0];
  if (!org) return { ok: false, reason: 'org not found' };
  org.subscription ||= {};
  switch (ev.type) {
    case 'checkout.session.completed':
      org.stripeCustomerId = o.customer; org.subscription.stripeSubscriptionId = o.subscription; org.subscription.status = 'active'; break;
    case 'customer.subscription.created': case 'customer.subscription.updated':
      org.subscription.status = o.status; org.subscription.plan = planForPrice(o.items?.data?.[0]?.price?.id) || org.subscription.plan;
      org.subscription.currentPeriodEnd = o.current_period_end; break;
    case 'customer.subscription.deleted': org.subscription.status = 'canceled'; break;
    case 'invoice.payment_failed': org.subscription.status = 'past_due'; break;
    case 'invoice.paid': if (org.subscription.status === 'past_due') org.subscription.status = 'active'; break;
    default: return { ok: true, ignored: ev.type };
  }
  store.put('orgs', org);
  store.audit({ actor: 'stripe', orgId: org.id, action: `billing.${ev.type}`, target: ev.id });
  return { ok: true };
}
