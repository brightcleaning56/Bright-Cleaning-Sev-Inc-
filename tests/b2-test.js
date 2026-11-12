// Off-site backup upload (Backblaze B2 native API) against a fake B2. No real account or credentials are used.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const results = []; const assert = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { const ev = await fn(); results.push({ name, status: 'PASS', evidence: ev }); console.log('PASS  ' + name); }
  catch (e) { results.push({ name, status: 'FAIL', evidence: e.message }); console.log('FAIL  ' + name + '  -> ' + e.message); }
}

const ENV_KEYS = ['BACKUP_BUCKET', 'BACKUP_KEY_ID', 'BACKUP_KEY_SECRET', 'BACKUP_S3_ENDPOINT'];
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const restoreEnv = () => ENV_KEYS.forEach(k => saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
const realFetch = global.fetch;

function setConfig() {
  process.env.BACKUP_BUCKET = 'brightclean-backups-eric';
  process.env.BACKUP_KEY_ID = 'test-key-id';
  process.env.BACKUP_KEY_SECRET = 'test-secret';
  process.env.BACKUP_S3_ENDPOINT = 'https://s3.us-east-005.backblazeb2.com';
}
function json(obj, status = 200) { return { ok: status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) }; }

// A fake B2 that records each request so the test can assert on what was sent.
function fakeB2({ authStatus = 200, uploadStatus = 200, uploadText = '' } = {}) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    if (url.includes('b2_authorize_account')) return authStatus === 200
      ? json({ accountId: 'acct-1', authorizationToken: 'auth-tok', apiInfo: { storageApi: { apiUrl: 'https://api.fake-b2', bucketId: 'bkt-1', bucketName: 'brightclean-backups-eric' } } })
      : json({ code: 'bad_auth_token' }, authStatus);
    if (url.includes('b2_get_upload_url')) return json({ uploadUrl: 'https://upload.fake-b2/x', authorizationToken: 'up-tok' });
    if (url.startsWith('https://upload.fake-b2')) return { ok: uploadStatus < 300, status: uploadStatus, text: async () => uploadText };
    return json({}, 404);
  };
  return calls;
}

function tempFile(bytes) {
  const f = path.join(os.tmpdir(), 'b2-test-' + crypto.randomBytes(4).toString('hex') + '.db.enc');
  fs.writeFileSync(f, Buffer.alloc(bytes, 7));
  return f;
}

(async () => {
  const b2 = require(path.join(ROOT, 'backupb2.js'));

  await check('B2: nothing is uploaded when the settings are missing', async () => {
    ENV_KEYS.forEach(k => delete process.env[k]);
    const calls = fakeB2();
    const f = tempFile(10);
    const r = await b2.uploadFile(f, 'x.db.enc');
    fs.unlinkSync(f); global.fetch = realFetch; restoreEnv();
    assert(r.skipped === true && r.ok === false, 'expected skipped: ' + JSON.stringify(r));
    assert(calls.length === 0, 'no request should be sent');
    return 'skipped without any request';
  });

  await check('B2: full upload sends the whole file with its SHA-1 and length, then reports success', async () => {
    setConfig();
    const calls = fakeB2();
    const size = 1691682, f = tempFile(size);
    const r = await b2.uploadFile(f, 'brightclean-test.db.enc');
    fs.unlinkSync(f); global.fetch = realFetch; restoreEnv();
    assert(r.ok === true, 'upload should succeed: ' + JSON.stringify(r));
    const up = calls.find(c => c.url.startsWith('https://upload.fake-b2'));
    assert(up, 'upload request missing');
    assert(up.headers['Content-Length'] === String(size), 'declared length ' + up.headers['Content-Length']);
    assert(up.body.length === size, 'sent bytes ' + up.body.length + ' of ' + size);
    const sha1 = crypto.createHash('sha1').update(Buffer.alloc(size, 7)).digest('hex');
    assert(up.headers['X-Bz-Content-Sha1'] === sha1, 'SHA-1 mismatch');
    assert(up.headers['X-Bz-File-Name'] === 'brightclean-test.db.enc', 'file name header');
    assert(up.headers.Authorization === 'up-tok', 'upload token');
    return `sent ${size} bytes with matching SHA-1 and length`;
  });

  await check('B2: a rejected key is reported with the status and does not throw', async () => {
    setConfig();
    fakeB2({ authStatus: 401 });
    const f = tempFile(10);
    const r = await b2.uploadFile(f, 'x.db.enc');
    fs.unlinkSync(f); global.fetch = realFetch; restoreEnv();
    assert(r.ok === false && /401/.test(r.detail), 'expected a 401 report: ' + JSON.stringify(r));
    return 'reports 401 without throwing';
  });

  await check('B2: an upload refused by Backblaze is reported with the reason', async () => {
    setConfig();
    fakeB2({ uploadStatus: 400, uploadText: '<Error><Code>IncompleteBody</Code></Error>' });
    const f = tempFile(10);
    const r = await b2.uploadFile(f, 'x.db.enc');
    fs.unlinkSync(f); global.fetch = realFetch; restoreEnv();
    assert(r.ok === false && /400/.test(r.detail) && /IncompleteBody/.test(r.detail), 'reason missing: ' + JSON.stringify(r));
    return 'reports status and reason';
  });

  await check('B2: a key limited to a different bucket is refused before any upload', async () => {
    setConfig();
    const calls = [];
    global.fetch = async (url) => { calls.push(url); return json({ accountId: 'a', authorizationToken: 't', apiInfo: { storageApi: { apiUrl: 'https://api.fake-b2', bucketId: 'x', bucketName: 'some-other-bucket' } } }); };
    const f = tempFile(10);
    const r = await b2.uploadFile(f, 'x.db.enc');
    fs.unlinkSync(f); global.fetch = realFetch; restoreEnv();
    assert(r.ok === false && /limited to bucket/.test(r.detail), 'expected bucket refusal: ' + JSON.stringify(r));
    assert(!calls.some(u => u.includes('upload')), 'no upload should be attempted');
    return 'refused before upload';
  });

  global.fetch = realFetch; restoreEnv();
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
