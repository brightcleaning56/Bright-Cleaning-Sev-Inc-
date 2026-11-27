// Checks the receipt scanner's PDF builder: page count, page sizes, and that every cross-reference offset
// points at its object. Run with: node tests/scan-pdf-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'scan-pdf.js'), 'utf8');
const ctx = { TextEncoder, Uint8Array, globalThis: {} };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const { buildPdf } = ctx.globalThis.BCScanPdf;

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0xff, 0xd9]);
const pdf = buildPdf([{ jpeg, width: 612, height: 792 }, { jpeg, width: 400, height: 300 }]);
const text = Buffer.from(pdf).toString('latin1');

assert.ok(text.startsWith('%PDF-1.4'), 'missing PDF header');
assert.ok(text.trimEnd().endsWith('%%EOF'), 'missing end of file');
assert.ok(/\/Type \/Pages \/Kids \[3 0 R 6 0 R\] \/Count 2/.test(text), 'page tree wrong');
assert.ok(text.includes('/MediaBox [0 0 612 792]') && text.includes('/MediaBox [0 0 400 300]'), 'page sizes wrong');
assert.strictEqual((text.match(/\/Subtype \/Image/g) || []).length, 2, 'expected two images');

// Every xref entry must point at "N 0 obj".
const xrefAt = text.lastIndexOf('\nxref\n') + 1;
const startxref = Number(text.match(/startxref\n(\d+)/)[1]);
assert.strictEqual(startxref, xrefAt, 'startxref does not point at the xref table');
const lines = text.slice(xrefAt).split('\n');
const count = Number(lines[1].split(' ')[1]);
for (let k = 1; k < count; k++) {
  const off = Number(lines[2 + k].slice(0, 10));
  assert.ok(text.slice(off, off + `${k} 0 obj`.length) === `${k} 0 obj`, `object ${k} offset ${off} is wrong`);
}
console.log('PASS  scan PDF: two pages, sizes, image objects and cross-reference offsets are correct');
