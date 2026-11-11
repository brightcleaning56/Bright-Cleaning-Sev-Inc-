// Copies database backups to Backblaze B2 using the native B2 API. Uses only Node's built-in crypto and fetch.
// Turned on by setting these in Render: BACKUP_BUCKET, BACKUP_KEY_ID, BACKUP_KEY_SECRET, and BACKUP_S3_ENDPOINT.
// BACKUP_S3_ENDPOINT is kept for compatibility; only its presence is needed. Without these nothing is uploaded and nothing breaks.
const crypto = require('crypto');
const fs = require('fs');

function config() {
  const c = {
    bucket: process.env.BACKUP_BUCKET || '',
    keyId: process.env.BACKUP_KEY_ID || '',
    secret: process.env.BACKUP_KEY_SECRET || '',
    endpoint: (process.env.BACKUP_S3_ENDPOINT || '').replace(/\/+$/, ''),
  };
  return c.bucket && c.keyId && c.secret && c.endpoint ? c : null;
}

const AUTH_URL = 'https://api.backblazeb2.com/b2api/v3/b2_authorize_account';

async function authorize(c) {
  const basic = Buffer.from(`${c.keyId}:${c.secret}`).toString('base64');
  const res = await fetch(AUTH_URL, { headers: { Authorization: `Basic ${basic}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`authorize ${res.status} ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
  const j = JSON.parse(text);
  const api = j.apiInfo.storageApi;
  if (api.bucketId && api.bucketName && api.bucketName !== c.bucket) throw new Error(`key is limited to bucket ${api.bucketName}`);
  return { token: j.authorizationToken, apiUrl: api.apiUrl, bucketId: api.bucketId, accountId: j.accountId };
}

async function bucketIdFor(c, auth) {
  if (auth.bucketId) return auth.bucketId;
  const res = await fetch(`${auth.apiUrl}/b2api/v3/b2_list_buckets`, {
    method: 'POST', headers: { Authorization: auth.token, 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: auth.accountId, bucketName: c.bucket }),
  });
  const j = await res.json();
  const b = (j.buckets || []).find(x => x.bucketName === c.bucket);
  if (!b) throw new Error(`bucket ${c.bucket} not found`);
  return b.bucketId;
}

// Uploads one file. Returns { ok, detail }. Never throws, so a failed upload cannot break the local backup.
async function uploadFile(localPath, objectName) {
  const c = config();
  if (!c) return { ok: false, skipped: true, detail: 'Off-site copy not configured' };
  try {
    const body = fs.readFileSync(localPath);
    const auth = await authorize(c);
    const bucketId = await bucketIdFor(c, auth);
    const urlRes = await fetch(`${auth.apiUrl}/b2api/v3/b2_get_upload_url`, {
      method: 'POST', headers: { Authorization: auth.token, 'content-type': 'application/json' },
      body: JSON.stringify({ bucketId }),
    });
    const up = await urlRes.json();
    if (!up.uploadUrl) throw new Error(`get_upload_url ${urlRes.status} ${JSON.stringify(up).slice(0, 200)}`);
    const sha1 = crypto.createHash('sha1').update(body).digest('hex');
    const res = await fetch(up.uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: up.authorizationToken,
        'X-Bz-File-Name': encodeURIComponent(objectName),
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
        'X-Bz-Content-Sha1': sha1,
      },
      body,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, detail: `B2 upload responded ${res.status} (sent ${body.length} bytes of ${objectName}) ${text.replace(/\s+/g, ' ').slice(0, 400)}` };
    return { ok: true, detail: `uploaded to ${c.bucket} as ${objectName} (${body.length} bytes)` };
  } catch (e) {
    return { ok: false, detail: e.message || 'upload failed' };
  }
}

module.exports = { config, uploadFile };
