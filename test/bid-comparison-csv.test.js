import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { levelingCsv } from '../src/prequal.js';

test('the bid comparison exports as CSV, with formulas neutralised and commas and quotes escaped', () => {
  const csv = levelingCsv({
    request: { addendumCount: 1 },
    rows: [{ company: '=HYPERLINK("http://x","click")', total: 12500, recurring: null, pctAboveLow: 0, revision: 2, submittedAt: '2026-11-01T00:00:00Z', receiptId: 'R-1',
      addendaAcknowledged: 1, insuranceCheck: { required: true, met: false, shortfalls: ['no general liability certificate on file'] },
      scope: 'Rough-in, trim and "final" test', exclusions: '', documentUrl: 'https://example.com/b.pdf', prequal: { flags: [] } }],
  });
  const [head, row] = csv.trim().split('\r\n');
  assert.match(head, /^Company,Bid,Recurring/);
  assert.match(row, /^"'=HYPERLINK/, 'a formula is neutralised');
  assert.match(row, /"Rough-in, trim and ""final"" test"/, 'commas and quotes are escaped');
  assert.match(row, /,no,no general liability certificate on file,/, 'the insurance result is shown');
});
