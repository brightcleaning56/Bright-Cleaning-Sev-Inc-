// Builds one PDF from JPEG pages, for the receipt scanner. Each page is sized to its image.
// Used in the browser by the admin's receipt scan; the same code is tested in Node (tests/scan-pdf-test.js).
(function (root) {
  function buildPdf(pages) {
    const enc = s => new TextEncoder().encode(s);
    const chunks = [];
    let len = 0;
    const offsets = [];
    const push = d => { const b = typeof d === 'string' ? enc(d) : d; chunks.push(b); len += b.length; };
    const obj = (n, body) => { offsets[n] = len; push(n + ' 0 obj\n'); push(body); push('\nendobj\n'); };
    const n = pages.length;
    push('%PDF-1.4\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    const kids = pages.map((_, i) => (3 + i * 3) + ' 0 R').join(' ');
    obj(2, '<< /Type /Pages /Kids [' + kids + '] /Count ' + n + ' >>');
    pages.forEach((p, i) => {
      const pn = 3 + i * 3, cn = pn + 1, imn = pn + 2;
      const W = p.width, H = p.height;
      obj(pn, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Resources << /XObject << /Im' + i + ' ' + imn + ' 0 R >> >> /Contents ' + cn + ' 0 R >>');
      const content = 'q ' + W + ' 0 0 ' + H + ' 0 0 cm /Im' + i + ' Do Q';
      obj(cn, '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
      offsets[imn] = len;
      push(imn + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + W + ' /Height ' + H + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.jpeg.length + ' >>\nstream\n');
      push(p.jpeg);
      push('\nendstream\nendobj\n');
    });
    const total = 3 + n * 3;
    const xref = len;
    let table = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (let k = 1; k < total; k++) table += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
    push(table);
    push('trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    const out = new Uint8Array(len);
    let o = 0;
    chunks.forEach(c => { out.set(c, o); o += c.length; });
    return out;
  }
  root.BCScanPdf = { buildPdf: buildPdf };
})(typeof window !== 'undefined' ? window : globalThis);
