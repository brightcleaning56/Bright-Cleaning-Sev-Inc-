// Signs an owner or manager in the way the real app requires: password, then the authenticator code.
// The first time an account signs in, two-step sign-in is turned on for it (setup, then a confirmed code),
// and the secret is kept for the rest of the test run so later sign-ins can answer the code step.
// A code is single-use (F-14.3a): the server accepts only a time step newer than the last one it accepted for the
// account. So each sign-in here answers with the next step that is newer than the last one this helper used, and
// waits for the 30-second window to reach it when needed. The server accepts codes one step either side of now.
// `post(path, body, token)` must resolve to an object with a `data` field (the parsed JSON response).
const totp = require('../totp');

const STEP_MS = 30000;
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

module.exports = function makeSignIn(post) {
  const secrets = new Map();
  const lastStep = new Map();
  const key = email => String(email).toLowerCase();

  // The step to answer with now: the current one, or the one after the last accepted step if that is later.
  // If that step is more than one ahead of now, wait until the window reaches it.
  async function pickStep(email) {
    const last = lastStep.has(key(email)) ? lastStep.get(key(email)) : -Infinity;
    const now = Math.floor(Date.now() / STEP_MS);
    const target = Math.max(now, last + 1);
    if (target > now + 1) await sleep(((target - 1) * STEP_MS) - Date.now() + 50);
    return Math.max(Math.floor(Date.now() / STEP_MS), last + 1);
  }
  const codeFor = (email, step) => totp.codeAt(secrets.get(key(email)), step);

  async function signIn(email, password) {
    const first = (await post('/api/admin/login', { email, password }, null)).data || {};
    if (first.mfa_required) {
      const step = await pickStep(email);
      const second = (await post('/api/admin/login/mfa', { mfa_token: first.mfa_token, code: codeFor(email, step) }, null)).data || {};
      if (!second.token) throw new Error('two-step sign-in failed: ' + JSON.stringify(second));
      lastStep.set(key(email), step);
      return second.token;
    }
    if (!first.token) throw new Error('sign-in failed: ' + JSON.stringify(first));
    // Not enrolled yet: set two-step sign-in up now, as the owner would on first sign-in.
    const setup = (await post('/api/admin/mfa/setup', {}, first.token)).data || {};
    if (!setup.secret) throw new Error('two-step set-up failed: ' + JSON.stringify(setup));
    secrets.set(key(email), setup.secret);
    const step = await pickStep(email);
    const enabled = (await post('/api/admin/mfa/enable', { code: codeFor(email, step) }, first.token)).data || {};
    if (!enabled.token) throw new Error('two-step enable failed: ' + JSON.stringify(enabled));
    lastStep.set(key(email), step); // the enabling code is spent too
    return enabled.token;
  }

  // Lets a test that sends its own codes tell the helper which step it has spent.
  signIn.recordStep = (email, step) => lastStep.set(key(email), Math.max(step, lastStep.has(key(email)) ? lastStep.get(key(email)) : -Infinity));
  return signIn;
};
