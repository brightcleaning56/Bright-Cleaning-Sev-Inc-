// Creates admin sign-in settings.
//   node scripts/create-admin.js admin@company.com "a-long-password-14-chars-min"
// Prints ADMIN_EMAIL and ADMIN_PASSWORD_HASH to paste into the hosting provider's environment settings.
// When no .env file exists yet (local setup), it also writes one with a random JWT_SECRET.
// An existing .env is never overwritten.
const bcrypt = require('bcryptjs');
const fs = require('fs');
const crypto = require('crypto');
const { isEmail } = require('../ops');

(async () => {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  const password = process.argv[3] || '';
  if (!isEmail(email) || password.length < 14) {
    console.error('Usage: node scripts/create-admin.js admin@company.com "A-long-password-14-chars-min"');
    console.error('The email must be valid and the password at least 14 characters.');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 12);
  console.log('\nAdd these to your hosting environment settings:\n');
  console.log('ADMIN_EMAIL=' + email);
  console.log('ADMIN_PASSWORD_HASH=' + hash + '\n');
  if (fs.existsSync('.env')) {
    console.log('.env already exists and was not changed.');
  } else {
    const secret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync('.env', `PORT=3000\nJWT_SECRET=${secret}\nADMIN_EMAIL=${email}\nADMIN_PASSWORD_HASH=${hash}\nPUBLIC_BASE_URL=http://localhost:3000\n`, { flag: 'wx' });
    console.log('.env created for local use. Do not commit it.');
  }
})().catch(e => { console.error(e.message); process.exit(1); });
