// Email suppression and reply tracking, against a temporary database. No mail is sent and no live data is touched.
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const ES = require(path.join(ROOT, 'emailsuppress'));
const results = []; const assert = (c, m) => { if (!c) throw new Error(m); };
function check(name, fn) {
  try { const ev = fn(); results.push({ name, status: 'PASS', evidence: ev }); console.log('PASS  ' + name); }
  catch (e) { results.push({ name, status: 'FAIL', evidence: e.message }); console.log('FAIL  ' + name + '  -> ' + e.message); }
}

const file = path.join(os.tmpdir(), 'suppress-test-' + process.pid + '.db');
try { fs.unlinkSync(file); } catch {}
const db = new Database(file);
ES.ensure(db);

check('Reply wording: opt-outs, declines and ordinary replies are told apart', () => {
  assert(ES.classify('Please unsubscribe me from these') === 'opted_out', 'unsubscribe');
  assert(ES.classify('Stop emailing me') === 'opted_out', 'stop emailing');
  assert(ES.classify('Remove me from your list') === 'opted_out', 'remove me');
  assert(ES.classify('Thanks, but not interested right now') === 'declined', 'not interested');
  assert(ES.classify('No thanks, we went with another company') === 'declined', 'went with another');
  assert(ES.classify('Sounds good, can you call me Tuesday?') === 'replied', 'ordinary reply');
  return '6 wording cases classified';
});

check('Suppression: a stronger reason is kept, a weaker one never replaces it', () => {
  ES.suppress(db, 'Pat.Lead@Example.com', 'replied', 'reply', 'Re: quote', 'inbox');
  assert(ES.isSuppressed(db, 'pat.lead@example.com').reason === 'replied', 'first reason stored (case-insensitive)');
  ES.suppress(db, 'pat.lead@example.com', 'opted_out', 'reply', 'stop', 'inbox');
  assert(ES.isSuppressed(db, 'pat.lead@example.com').reason === 'opted_out', 'opt-out upgrades');
  ES.suppress(db, 'pat.lead@example.com', 'replied', 'reply', 'later reply', 'inbox');
  assert(ES.isSuppressed(db, 'pat.lead@example.com').reason === 'opted_out', 'later reply does not downgrade');
  return 'replied -> opted_out, stays opted_out';
});

check('Inbox: our own mailbox never suppresses anyone', () => {
  const r = ES.onInbound(db, 'info@brightclean.net', 'Re: your bid', 'Thanks');
  assert(r === null, 'own domain ignored');
  assert(!ES.isSuppressed(db, 'info@brightclean.net'), 'no row for own mailbox');
  return 'info@brightclean.net ignored';
});

check('Inbox: an opt-out reply blocks automated email to that person', () => {
  const r = ES.onInbound(db, 'casey@example.com', 'Re: Bright Clean follow-up', 'Please unsubscribe me, thank you');
  assert(r === 'opted_out', 'classified ' + r);
  const g = ES.gate(db, { to: 'casey@example.com', automated: true, subject: 'Reminder' });
  assert(g.blocked === true && g.reason === 'opted_out', 'automated send blocked: ' + JSON.stringify(g));
  return 'automated send to casey@example.com blocked';
});

check('Gate: only automated sends are blocked; a person-started email is not', () => {
  const g = ES.gate(db, { to: 'casey@example.com', subject: 'Hello' });
  assert(g.blocked === false, 'manual send must pass the gate');
  return 'manual send allowed (UI shows the flag instead)';
});

check('Gate: a multi-recipient send is blocked when any address is suppressed', () => {
  const g = ES.gate(db, { to: 'fine@example.com, casey@example.com', automated: true });
  assert(g.blocked === true && g.address === 'casey@example.com', 'blocked on the suppressed address');
  const ok = ES.gate(db, { to: 'fine@example.com', automated: true });
  assert(ok.blocked === false, 'clean address passes');
  return 'list checked address by address';
});

check('Bounce: a bounced address is suppressed and reported', () => {
  ES.suppress(db, 'gone@example.com', 'bounced', 'send', '550 mailbox not found', 'system');
  const s = ES.isSuppressed(db, 'gone@example.com');
  assert(s && s.reason === 'bounced', 'bounced stored');
  assert(ES.gate(db, { to: 'gone@example.com', automated: true }).blocked === true, 'automated send blocked');
  return 'bounced address blocked from automation';
});

check('Staff block: a manually recorded opt-out is enforced the same way', () => {
  ES.suppress(db, 'phone.optout@example.com', 'opted_out', 'staff', 'Asked on the phone', 'sales');
  assert(ES.gate(db, { to: 'phone.optout@example.com', automated: true }).blocked === true, 'blocked');
  return 'phone opt-out enforced';
});

check('Invalid input is refused and leaves no row', () => {
  assert(ES.suppress(db, '', 'opted_out', 'x', '', 'x') === false, 'empty address');
  assert(ES.suppress(db, 'x@example.com', 'bogus', 'x', '', 'x') === false, 'unknown reason');
  assert(!ES.isSuppressed(db, 'x@example.com'), 'no row created');
  return 'empty address and unknown reason refused';
});

db.close();
try { fs.unlinkSync(file); } catch {}
try { fs.unlinkSync(file + '-wal'); } catch {}
try { fs.unlinkSync(file + '-shm'); } catch {}
const failed = results.filter(r => r.status === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
