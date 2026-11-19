// Upload content checks: the file's bytes must match its extension, and PDFs may not carry scripts or auto-launch actions.
// This is a content check, not a virus scanner; it blocks the common "renamed executable" and "PDF with an embedded action" attacks.
const fs = require('fs'), path = require('path');
const SIG = {
  pdf: [[0x25, 0x50, 0x44, 0x46]],                                  // %PDF
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  jpg: [[0xff, 0xd8, 0xff]], jpeg: [[0xff, 0xd8, 0xff]],
  gif: [[0x47, 0x49, 0x46, 0x38]], webp: [[0x52, 0x49, 0x46, 0x46]], heic: null, // heic: container varies; checked by "ftyp" below
  zip: [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06]],
  docx: [[0x50, 0x4b, 0x03, 0x04]], xlsx: [[0x50, 0x4b, 0x03, 0x04]], pptx: [[0x50, 0x4b, 0x03, 0x04]],
  doc: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]], xls: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]]
};
const EXE = [[0x4d, 0x5a], [0x7f, 0x45, 0x4c, 0x46], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe], [0x23, 0x21]]; // MZ, ELF, Mach-O, fat, #!
const starts = (buf, sig) => sig.every((b, i) => buf[i] === b);
function check(filePath, originalName) {
  const ext = path.extname(String(originalName || '')).slice(1).toLowerCase(), name = path.basename(String(originalName || 'file'));
  let fd, head = Buffer.alloc(16); try { fd = fs.openSync(filePath, 'r'); fs.readSync(fd, head, 0, 16, 0); } catch { return `${name} could not be read.`; } finally { if (fd !== undefined) fs.closeSync(fd); }
  if (EXE.some(s => starts(head, s))) return `${name} is a program, not a document. It was not accepted.`;
  if (ext === 'heic' || ext === 'heif') return head.slice(4, 8).toString('latin1') === 'ftyp' ? null : `${name} is not a real ${ext.toUpperCase()} image.`;
  if (['mp4', 'm4v', 'mov'].includes(ext)) return head.slice(4, 8).toString('latin1') === 'ftyp' ? null : `${name} is not a real ${ext.toUpperCase()} video (its contents do not match its name). It was not accepted.`;
  if (ext === 'webp') return starts(head, [0x52, 0x49, 0x46, 0x46]) && head.slice(8, 12).toString('latin1') === 'WEBP' ? null : `${name} is not a real WEBP image (its contents do not match its name). It was not accepted.`;
  if (ext === 'webm') return starts(head, [0x1a, 0x45, 0xdf, 0xa3]) ? null : `${name} is not a real WEBM video (its contents do not match its name). It was not accepted.`;
  const sigs = SIG[ext]; if (!sigs) return `${name}: this file type is not accepted.`;
  if (!sigs.some(s => starts(head, s))) return `${name} is not a real ${ext.toUpperCase()} file (its contents do not match its name). It was not accepted.`;
  if (ext === 'pdf') {
    const txt = fs.readFileSync(filePath).toString('latin1');
    if (/\/(JavaScript|JS|Launch)\b/.test(txt)) return `${name} contains embedded scripts or automatic actions, which are not allowed in uploaded PDFs. Save it as a plain PDF ("Print to PDF") and try again.`;
  }
  return null;
}
// Virus scan through ClamAV's clamd (INSTREAM protocol). Enabled when CLAMAV_HOST is set (CLAMAV_PORT defaults to 3310).
// UPLOAD_SCAN_REQUIRED=1 makes the scanner mandatory: uploads are refused while it is not configured or not reachable.
const net = require('net');
const scannerConfigured = () => !!process.env.CLAMAV_HOST;
function clamScan(filePath) {
  const host = process.env.CLAMAV_HOST, port = Number(process.env.CLAMAV_PORT) || 3310;
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const chunks = []; let done = false;
    const finish = (err, val) => { if (done) return; done = true; sock.destroy(); err ? reject(err) : resolve(val); };
    sock.setTimeout(60000, () => finish(new Error('scanner timed out')));
    sock.on('error', e => finish(e));
    sock.on('data', d => chunks.push(d));
    sock.on('end', () => {
      const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
      if (/ OK$/.test(reply)) return finish(null, { infected: false });
      const m = reply.match(/^stream: (.+) FOUND$/);
      if (m) return finish(null, { infected: true, signature: m[1] });
      finish(new Error('unexpected scanner reply: ' + reply.slice(0, 120)));
    });
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      const data = fs.readFileSync(filePath);
      for (let i = 0; i < data.length; i += 65536) {
        const part = data.subarray(i, Math.min(i + 65536, data.length));
        const len = Buffer.alloc(4); len.writeUInt32BE(part.length, 0);
        sock.write(len); sock.write(part);
      }
      const end = Buffer.alloc(4); end.writeUInt32BE(0, 0); sock.write(end);
    });
  });
}
// Express middleware: verify every uploaded file; on any failure delete ALL files from this request and refuse it.
async function verifyUploads(req, res, next) {
  const files = [].concat(req.file || [], Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat());
  const refuse = (status, msg) => { for (const g of files) { try { fs.unlinkSync(g.path); } catch { /* */ } } return res.status(status).json({ error: msg }); };
  for (const f of files) {
    const err = check(f.path, f.originalname);
    if (err) return refuse(400, err);
  }
  const required = process.env.UPLOAD_SCAN_REQUIRED === '1';
  if (!scannerConfigured()) {
    if (required && files.length) return refuse(503, 'Uploads are unavailable: virus scanning is required but not configured.');
    return next();
  }
  for (const f of files) {
    let r;
    try { r = await clamScan(f.path); }
    catch (e) {
      if (required) return refuse(503, 'Uploads cannot be checked right now. Try again in a few minutes.');
      console.warn('Virus scan unavailable, upload accepted without it:', e.message);
      continue;
    }
    if (r.infected) return refuse(400, `${path.basename(f.originalname || 'file')} was blocked by the virus scanner (${r.signature}).`);
  }
  next();
}
// Wrap a multer instance so .array/.single/.fields/.any always run the content check afterwards.
function guard(multerInstance) {
  const wrap = m => (...a) => [multerInstance[m](...a), verifyUploads];
  return { array: wrap('array'), single: wrap('single'), fields: wrap('fields'), any: wrap('any'), none: (...a) => multerInstance.none(...a) };
}
module.exports = { check, verifyUploads, guard };
