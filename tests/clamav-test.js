// Upload virus scan: uses a fake clamd (INSTREAM protocol) so no ClamAV install is needed.
// Run: node tests/clamav-test.js
const net = require('net'), fs = require('fs'), os = require('os'), path = require('path');
const filecheck = require('../filecheck');

const fake = net.createServer(sock => {
  const parts = [];
  let buf = Buffer.alloc(0);
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    if (!buf.toString('latin1', 0, 10).startsWith('zINSTREAM\0')) return;
    let off = 10, data = [];
    while (buf.length >= off + 4) {
      const n = buf.readUInt32BE(off); off += 4;
      if (n === 0) { // end of stream
        const body = Buffer.concat(data).toString('latin1');
        sock.end(body.includes('EICAR-TEST') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
        return;
      }
      if (buf.length < off + n) return; // wait for more
      data.push(buf.subarray(off, off + n)); off += n;
    }
  });
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
const mkFile = (name, text) => { const p = path.join(tmp, name); fs.writeFileSync(p, text); return { path: p, originalname: name }; };
const mockRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const run = async (files) => {
  const res = mockRes(); let passed = false;
  await filecheck.verifyUploads({ files }, res, () => { passed = true; });
  return { passed, res };
};

(async () => {
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  process.env.CLAMAV_HOST = '127.0.0.1'; process.env.CLAMAV_PORT = String(fake.address().port);
  let failed = 0; const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(extra || {}))); if (!cond) failed++; };

  // %PDF header passes the content check, so these reach the scanner.
  const clean = mkFile('plan.pdf', '%PDF-1.4\nplain text\n%%EOF');
  const r1 = await run([clean]);
  ok('clean file is accepted', r1.passed && fs.existsSync(clean.path), r1.res.body);

  const bad = mkFile('invoice.pdf', '%PDF-1.4\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-TEST-FILE!$H+H*\n%%EOF');
  const r2 = await run([bad]);
  ok('infected file is refused with 400 and deleted', !r2.passed && r2.res.code === 400 && /virus scanner/.test(r2.res.body.error) && !fs.existsSync(bad.path), { code: r2.res.code, body: r2.res.body });

  // Scanner unreachable: accepted with a warning by default, refused when required.
  process.env.CLAMAV_PORT = '1'; // nothing listens here
  delete process.env.UPLOAD_SCAN_REQUIRED;
  const down = mkFile('down.pdf', '%PDF-1.4\n%%EOF');
  const r3 = await run([down]);
  ok('scanner down, not required: upload accepted', r3.passed, r3.res.body);

  process.env.UPLOAD_SCAN_REQUIRED = '1';
  const down2 = mkFile('down2.pdf', '%PDF-1.4\n%%EOF');
  const r4 = await run([down2]);
  ok('scanner down, required: refused with 503 and deleted', !r4.passed && r4.res.code === 503 && !fs.existsSync(down2.path), { code: r4.res.code });

  // Not configured at all, required: refused.
  delete process.env.CLAMAV_HOST;
  const none = mkFile('none.pdf', '%PDF-1.4\n%%EOF');
  const r5 = await run([none]);
  ok('scanner not configured, required: refused with 503', !r5.passed && r5.res.code === 503, { code: r5.res.code });
  delete process.env.UPLOAD_SCAN_REQUIRED;

  fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${failed ? failed + ' failed' : 'all passed'}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
