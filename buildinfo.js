// Build fingerprint: SHA-256 over every file that actually runs (root *.js server modules, public/**, package.json),
// sorted by path. The live server reports it at /health; tools/build-manifest.js writes the same value into
// BUILD_MANIFEST.json in a release archive. Equal fingerprints = the archive is exactly the code that is running.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
function files(root) {
  const out = [];
  for (const f of fs.readdirSync(root)) if (/\.js$/.test(f) && fs.statSync(path.join(root, f)).isFile()) out.push(f);
  if (fs.existsSync(path.join(root, 'package.json'))) out.push('package.json');
  const walk = d => { for (const f of fs.readdirSync(path.join(root, d))) { const rel = d + '/' + f, st = fs.statSync(path.join(root, rel)); if (st.isDirectory()) walk(rel); else out.push(rel); } };
  if (fs.existsSync(path.join(root, 'public'))) walk('public');
  return out.sort();
}
function compute(root = __dirname) {
  // Text files are hashed with LF line endings, so a Windows checkout (CRLF) and the Linux server give the same fingerprint.
  const TEXT = /\.(js|html|css|json|txt|md|xml|svg)$/i;
  const bytesOf = p => { const b = fs.readFileSync(path.join(root, p)); return TEXT.test(p) ? Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n')) : b; };
  const list = files(root).map(p => ({ path: p, sha256: crypto.createHash('sha256').update(bytesOf(p)).digest('hex') }));
  const fingerprint = crypto.createHash('sha256').update(list.map(f => `${f.path}:${f.sha256}\n`).join('')).digest('hex');
  return { fingerprint, files: list.length, list };
}
module.exports = { compute };
