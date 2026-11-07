// AI drawing extraction accuracy harness.
// Usage: ANTHROPIC_API_KEY=... node scripts/ai-accuracy.mjs <folder>
// The folder holds pairs: <name>.pdf and <name>.truth.json  →  { "rooms": [ { "number": "101", "name": "LOBBY", "areaSqFt": 2450 }, ... ] }
// (areaSqFt null when the sheet does not print an area). Writes docs/ai-accuracy-report.json and prints a summary.
import fs from 'node:fs';
import path from 'node:path';
import { readDrawing, scoreReading } from '../src/ai.js';
import { config } from '../src/config.js';

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) { console.error('usage: node scripts/ai-accuracy.mjs <folder with *.pdf + *.truth.json>'); process.exit(2); }
if (!config.anthropicKey) { console.error('ANTHROPIC_API_KEY is not set: no accuracy can be measured.'); process.exit(2); }
const pairs = fs.readdirSync(dir).filter(f => f.endsWith('.pdf') && fs.existsSync(path.join(dir, f.replace(/\.pdf$/, '.truth.json'))));
if (!pairs.length) { console.error('no PDF + truth pairs found'); process.exit(2); }
const sheets = [];
for (const f of pairs) {
  const truth = JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.pdf$/, '.truth.json')), 'utf8'));
  const r = await readDrawing(fs.readFileSync(path.join(dir, f)), f);
  sheets.push(r.ok ? { file: f, ...scoreReading(r.result, truth) } : { file: f, error: r.error });
  console.log(f, r.ok ? JSON.stringify(sheets.at(-1)) : 'ERROR ' + r.error);
}
const ok = sheets.filter(s => !s.error), sum = k => ok.reduce((n, s) => n + s[k], 0);
const report = { measuredAt: new Date().toISOString(), model: config.anthropicModel, sheets: sheets.length, failed: sheets.length - ok.length,
  roomRecall: sum('truthRooms') ? sum('roomsFound') / sum('truthRooms') : null,
  areaAccuracy: sum('printedAreas') ? sum('areasExact') / sum('printedAreas') : null,
  inventedAreas: sum('inventedAreas'), perSheet: sheets };
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/ai-accuracy-report.json', JSON.stringify(report, null, 2));
console.log(`\nRoom recall ${(100 * report.roomRecall).toFixed(1)}% · printed-area accuracy ${(100 * report.areaAccuracy).toFixed(1)}% · invented areas ${report.inventedAreas} (must be 0)`);
