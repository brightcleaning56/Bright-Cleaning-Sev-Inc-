// Containment: public forms and the customer portal refuse files unless PUBLIC_UPLOADS=1; staff uploads are not touched.
// Run: node tests/upload-restrict-test.js
const fs = require('fs'), os = require('os'), path = require('path');
const filecheck = require('../filecheck');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'restrict-'));
const mkFile = name => { const p = path.join(tmp, name); fs.writeFileSync(p, '%PDF-1.4\n%%EOF'); return { path: p, originalname: name }; };
const mockRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
let failed = 0;
const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(extra || {}))); if (!cond) failed++; };

delete process.env.PUBLIC_UPLOADS;
ok('closed by default', filecheck.publicUploadsOpen() === false);

// A public form with a file: refused, file deleted.
const f1 = mkFile('bid.pdf'); const res1 = mockRes(); let passed1 = false;
filecheck.refuseUnlessOpen({ files: [f1] }, res1, () => { passed1 = true; });
ok('public file upload refused with 403', !passed1 && res1.code === 403 && /not accepted right now/.test(res1.body.error), { code: res1.code });
ok('refused file is deleted from disk', !fs.existsSync(f1.path));

// A form with no files: passes straight through.
const res2 = mockRes(); let passed2 = false;
filecheck.refuseUnlessOpen({ files: [] }, res2, () => { passed2 = true; });
ok('form without files is not affected', passed2);

// A staff upload that is not a public path is never routed here, but the switch reopens the public paths.
process.env.PUBLIC_UPLOADS = '1';
const f2 = mkFile('bid2.pdf'); const res3 = mockRes(); let passed3 = false;
filecheck.refuseUnlessOpen({ files: [f2] }, res3, () => { passed3 = true; });
ok('PUBLIC_UPLOADS=1 reopens the path', passed3 && fs.existsSync(f2.path));
delete process.env.PUBLIC_UPLOADS;

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failed ? failed + ' failed' : 'all passed'}`);
process.exit(failed ? 1 : 0);
