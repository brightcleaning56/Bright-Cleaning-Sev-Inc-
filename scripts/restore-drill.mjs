// Restore drill: proves a backup file can be decrypted and read back with the current BACKUP_KEY, into an empty store.
// Usage: BACKUP_KEY=<64 hex> node scripts/restore-drill.mjs <path-to-.bak>
// Exits 0 only when the restored data matches the checksum recorded in the backup's sidecar (if present) and the
// record counts are printed for comparison with the live system. Run it on a copy of the backup, never on production.
import fs from 'node:fs';
import { readBackup } from '../src/backup.js';
import { config } from '../src/config.js';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('usage: BACKUP_KEY=<hex> node scripts/restore-drill.mjs <file.bak>'); process.exit(2); }
if (!/^[0-9a-fA-F]{64}$/.test(config.backupKey || '')) { console.error('BACKUP_KEY must be 64 hex characters'); process.exit(2); }
let restored;
try { restored = readBackup(file, config.backupKey); }
catch (e) { console.error(`RESTORE FAILED: ${e.message}. The key does not match this backup, or the file is damaged.`); process.exit(1); }
const counts = Object.fromEntries(Object.entries(restored.data).map(([k, v]) => [k, Array.isArray(v) ? v.length : Object.keys(v).length]));
const checksum = restored.checksum();
const sidecar = `${file}.sha256`;
const expected = fs.existsSync(sidecar) ? fs.readFileSync(sidecar, 'utf8').trim() : null;
console.log(JSON.stringify({ file, decrypted: true, checksum, expectedChecksum: expected, counts }, null, 2));
if (expected && expected !== checksum) { console.error('CHECKSUM MISMATCH: the restored data is not the data that was backed up.'); process.exit(1); }
console.log(expected ? 'RESTORE OK: checksum matches the backup record.' : 'RESTORE OK: decrypted and readable (no checksum sidecar to compare).');
