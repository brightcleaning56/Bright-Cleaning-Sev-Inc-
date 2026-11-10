// Decrypts an encrypted Bright Clean backup so it can be opened with SQLite.
// Usage: BACKUP_KEY="<the key used on Render>" node scripts/decrypt-backup.js <backup.db.enc> <output.db>
// Never run this against the live database file. Restore into a separate folder.
const fs = require('fs'), path = require('path');
const bc = require(path.join(__dirname, '..', 'backupcrypto'));
const [input, output] = process.argv.slice(2);
if (!input || !output) { console.error('Usage: BACKUP_KEY=... node scripts/decrypt-backup.js <backup.db.enc> <output.db>'); process.exit(2); }
const key = bc.keyFromEnv();
if (!key) { console.error('Set BACKUP_KEY to the key the backup was made with.'); process.exit(2); }
try {
  fs.writeFileSync(output, bc.decryptBuffer(fs.readFileSync(input), key));
  console.log('Decrypted to', output);
} catch (e) {
  console.error('Could not decrypt:', e.message); process.exit(1);
}
