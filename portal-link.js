// The client portal address that goes into every proposal the customer receives (email, PDF, reminders).
// The portal page offers sign-in and "Request a Service", so the customer can act on the proposal or ask for new work.
const base = () => (process.env.PUBLIC_BASE_URL || 'https://brightclean.net').replace(/\/+$/, '');
module.exports = { portalUrl: () => base() + '/portal.html' };
