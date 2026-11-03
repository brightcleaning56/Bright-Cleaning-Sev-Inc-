// Minimal PDF writer (no dependencies): Letter pages, Helvetica / Helvetica-Bold text, lines and filled boxes.
// Enough for proposals, contracts and reports. Text is drawn with standard PDF fonts (WinAnsi), so it is selectable.
function esc(s) { return String(s).replace(/[\\()]/g, m => '\\' + m).replace(/[^\x20-\x7e\xa0-\xff]/g, c => ({ '\u2019': "'", '\u2018': "'", '\u201c': '"', '\u201d': '"', '\u2013': '-', '\u2014': '-', '\u2022': '-', '\u00d7': 'x', '\u2192': '->', '\u2026': '...' }[c] || '?')); }
const W = 612, H = 792, M = 54;
// Approximate Helvetica widths (per 1000 em) for wrapping.
const CW = c => ('iljtfI.,;:!|\''.includes(c) ? 278 : 'mwMW'.includes(c) ? 833 : c === ' ' ? 278 : /[A-Z]/.test(c) ? 667 : 556);
const width = (s, size) => [...String(s)].reduce((t, c) => t + CW(c), 0) * size / 1000;
function wrap(text, size, max) {
  const out = [];
  for (const para of String(text ?? '').split(/\n/)) {
    let line = '';
    for (const w of para.split(/\s+/)) {
      const t = line ? line + ' ' + w : w;
      if (width(t, size) > max && line) { out.push(line); line = w; } else line = t;
    }
    out.push(line);
  }
  return out;
}
class Doc {
  constructor() { this.pages = []; this.newPage(); }
  newPage() { this.ops = []; this.pages.push(this.ops); this.y = H - M; }
  ensure(h) { if (this.y - h < M) this.newPage(); }
  text(s, { x = M, size = 10, bold = false, color = '0 0 0', align = 'left', maxW = W - 2 * M } = {}) {
    let tx = x; if (align === 'right') tx = x + maxW - width(s, size); else if (align === 'center') tx = x + (maxW - width(s, size)) / 2;
    this.ops.push(`BT ${color} rg /${bold ? 'F2' : 'F1'} ${size} Tf ${tx.toFixed(1)} ${this.y.toFixed(1)} Td (${esc(s)}) Tj ET`);
  }
  para(s, opt = {}) {
    const size = opt.size || 10, lh = size * 1.35, x = opt.x || M, maxW = opt.maxW || W - 2 * M - (x - M);
    for (const l of wrap(s, size, maxW)) { this.ensure(lh); this.text(l, { ...opt, x, size }); this.y -= lh; }
  }
  gap(h = 8) { this.y -= h; }
  rule(color = '0.85 0.88 0.92') { this.ensure(6); this.ops.push(`${color} RG 0.8 w ${M} ${this.y.toFixed(1)} m ${W - M} ${this.y.toFixed(1)} l S`); this.y -= 8; }
  box(x, y, w, h, color) { this.ops.push(`${color} rg ${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f`); }
  heading(s, size = 13) { this.ensure(size * 2.2); this.gap(4); this.text(s, { size, bold: true, color: '0.06 0.15 0.25' }); this.y -= size * 1.5; }
  // cols: [{label, w, align}], rows: [[...]]
  table(cols, rows, { size = 9 } = {}) {
    const lh = size * 1.45, total = cols.reduce((t, c) => t + c.w, 0), scale = (W - 2 * M) / total;
    const drawRow = (cells, bold, shade) => {
      const lines = cells.map((c, i) => wrap(c, size, cols[i].w * scale - 8));
      const h = Math.max(...lines.map(l => l.length)) * lh + 4;
      this.ensure(h + 2);
      if (shade) this.box(M, this.y - h + lh - 2, W - 2 * M, h, shade);
      let x = M;
      lines.forEach((ls, i) => { const y0 = this.y; ls.forEach((l, k) => { this.y = y0 - k * lh; this.text(l, { x: x + 4, size, bold, align: cols[i].align || 'left', maxW: cols[i].w * scale - 8 }); }); this.y = y0; x += cols[i].w * scale; });
      this.y -= h;
    };
    drawRow(cols.map(c => c.label), true, '0.93 0.95 0.98');
    rows.forEach((r, i) => drawRow(r.map(v => v == null ? '' : String(v)), false, i % 2 ? '0.98 0.985 0.99' : null));
    this.gap(4);
  }
  footer(s) { this.pages.forEach((ops, i) => ops.push(`BT 0.45 0.5 0.55 rg /F1 8 Tf ${M} 30 Td (${esc(`${s}  -  Page ${i + 1} of ${this.pages.length}`)}) Tj ET`)); }
  toBuffer() {
    const objs = [];
    const add = s => { objs.push(s); return objs.length; };
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pagesId = objs.length + 1; objs.push(null);
    const kids = [];
    for (const ops of this.pages) {
      const content = Buffer.from(ops.join('\n'), 'latin1');
      const cid = add(`<< /Length ${content.length} >>\nstream\n${content.toString('latin1')}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cid} 0 R >>`));
    }
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
    const cat = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'; const offs = [];
    objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(out, 'latin1');
  }
}
module.exports = { Doc, wrap, W, H, M };
