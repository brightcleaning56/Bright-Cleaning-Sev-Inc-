// Copies database backups to Backblaze B2 (S3-compatible API). Uses only Node's built-in crypto and fetch.
// Turned on by setting these in Render: BACKUP_BUCKET, BACKUP_KEY_ID, BACKUP_KEY_SECRET, BACKUP_S3_ENDPOINT
// (for example https://s3.us-west-004.backblazeb2.com). Without them nothing is uploaded and nothing breaks.
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

const sha256hex = data => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const amzDate = d => d.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20261110T230000Z
const encodePath = p => p.split('/').map(s => encodeURIComponent(s)).join('/');

// Builds AWS Signature Version 4 headers for a PUT of one object (path-style URL).
function signPut({ endpoint, bucket, key, keyId, secret, body, now = new Date() }) {
  const url = new URL(endpoint);
  const region = (url.hostname.match(/^s3\.([^.]+)\./) || [])[1] || 'us-west-004';
  const objPath = `/${encodePath(bucket)}/${encodePath(key)}`;
  const date = amzDate(now), day = date.slice(0, 8);
  const payloadHash = sha256hex(body);
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': date };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map(n => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonical = ['PUT', objPath, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secret, day), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return {
    url: `${url.origin}${objPath}`,
    headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
  };
}

// Uploads one file. Returns { ok, detail }. Never throws, so a failed upload cannot break the local backup.
async function uploadFile(localPath, objectName) {
  const c = config();
  if (!c) return { ok: false, skipped: true, detail: 'Off-site copy not configured' };
  try {
    const body = fs.readFileSync(localPath);
    const req = signPut({ ...c, key: objectName, body });
    const res = await fetch(req.url, { method: 'PUT', headers: { ...req.headers, 'content-length': String(body.length) }, body });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 600);
      return { ok: false, detail: `B2 responded ${res.status} (sent ${body.length} bytes of ${objectName}) ${text}`.trim() };
    }
    return { ok: true, detail: `uploaded to ${c.bucket} as ${objectName}` };
  } catch (e) {
    return { ok: false, detail: e.message || 'upload failed' };
  }
}

module.exports = { config, signPut, uploadFile };
