// Signs an owner or manager in the way the real app requires: password, then the authenticator code.
// The first time an account signs in, two-step sign-in is turned on for it (setup, then a confirmed code),
// and the secret is kept for the rest of the test run so later sign-ins can answer the code step.
// `post(path, body, token)` must resolve to an object with a `data` field (the parsed JSON response).
const totp = require('../totp');

module.exports = function makeSignIn(post) {
  const secrets = new Map();
  const code = email => totp.codeAt(secrets.get(String(email).toLowerCase()), Math.floor(Date.now() / 30000));
  return async function signIn(email, password) {
    const first = (await post('/api/admin/login', { email, password }, null)).data || {};
    if (first.mfa_required) {
      const second = (await post('/api/admin/login/mfa', { mfa_token: first.mfa_token, code: code(email) }, null)).data || {};
      if (!second.token) throw new Error('two-step sign-in failed: ' + JSON.stringify(second));
      return second.token;
    }
    if (!first.token) throw new Error('sign-in failed: ' + JSON.stringify(first));
    // Not enrolled yet: set two-step sign-in up now, as the owner would on first sign-in.
    const setup = (await post('/api/admin/mfa/setup', {}, first.token)).data || {};
    if (!setup.secret) throw new Error('two-step set-up failed: ' + JSON.stringify(setup));
    secrets.set(String(email).toLowerCase(), setup.secret);
    const enabled = (await post('/api/admin/mfa/enable', { code: code(email) }, first.token)).data || {};
    if (!enabled.token) throw new Error('two-step enable failed: ' + JSON.stringify(enabled));
    return enabled.token;
  };
};
