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
// Express middleware: verify every uploaded file; on any failure delete ALL files from this request and refuse it.
function verifyUploads(req, res, next) {
  const files = [].concat(req.file || [], Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat());
  for (const f of files) {
    const err = check(f.path, f.originalname);
    if (err) { for (const g of files) { try { fs.unlinkSync(g.path); } catch { /* */ } } return res.status(400).json({ error: err }); }
  }
  next();
}
// Wrap a multer instance so .array/.single/.fields/.any always run the content check afterwards.
function guard(multerInstance) {
  const wrap = m => (...a) => [multerInstance[m](...a), verifyUploads];
  return { array: wrap('array'), single: wrap('single'), fields: wrap('fields'), any: wrap('any'), none: (...a) => multerInstance.none(...a) };
}
module.exports = { check, verifyUploads, guard };
