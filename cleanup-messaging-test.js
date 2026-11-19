// One-off cleanup of the 2026-11-19 messaging test records. Dry run by default; deletes only with CONFIRM=yes.
// Run from the app folder on the server: node cleanup-messaging-test.js   (then CONFIRM=yes node cleanup-messaging-test.js)
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(process.env.DATA_DIR || '.', 'brightclean.db'));
const DAY = '2026-11-19';
const count = (sql, ...a) => db.prepare(sql).get(...a).n;
const plan = {
  crew_messages_today: count(`SELECT COUNT(*) n FROM crew_messages WHERE employee_id=1 AND created_at >= ?`, DAY),
  conversation_crew_today: count(`SELECT COUNT(*) n FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.kind='crew' AND c.employee_id=1 AND m.created_at >= ?`, DAY),
  portal_message_3: count(`SELECT COUNT(*) n FROM portal_messages WHERE id=3 AND subject='TEST messaging check 2: client to office'`),
  portal_replies_15_16: count(`SELECT COUNT(*) n FROM portal_message_replies WHERE message_id=3 AND id IN (15,16)`),
  conversation_portal_test: count(`SELECT COUNT(*) n FROM conversation_messages WHERE legacy_ref IN ('portal:3','portal_reply:15','portal_reply:16')`),
};
console.log(JSON.stringify(plan, null, 2));
if (process.env.CONFIRM !== 'yes') { console.log('Dry run only. Run again with CONFIRM=yes to delete.'); process.exit(0); }
db.transaction(() => {
  db.prepare(`DELETE FROM conversation_messages WHERE id IN (SELECT m.id FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.kind='crew' AND c.employee_id=1 AND m.created_at >= ?)`).run(DAY);
  db.prepare(`DELETE FROM crew_messages WHERE employee_id=1 AND created_at >= ?`).run(DAY);
  db.prepare(`DELETE FROM conversation_messages WHERE legacy_ref IN ('portal:3','portal_reply:15','portal_reply:16')`).run();
  db.prepare(`DELETE FROM portal_message_replies WHERE message_id=3 AND id IN (15,16)`).run();
  db.prepare(`DELETE FROM portal_messages WHERE id=3 AND subject='TEST messaging check 2: client to office'`).run();
  db.prepare(`DELETE FROM conversations WHERE kind='crew' AND employee_id=1 AND id NOT IN (SELECT conversation_id FROM conversation_messages)`).run();
})();
console.log('Deleted.');
