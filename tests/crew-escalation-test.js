// Crew messages: an unanswered crew message becomes one urgent task after the limit; an answered one does not.
// Run: node tests/crew-escalation-test.js
const Database = require('better-sqlite3');
const conv = require('../conversations');

const db = new Database(':memory:');
db.exec(`CREATE TABLE employees(id INTEGER PRIMARY KEY, name TEXT, role TEXT);
  CREATE TABLE customer_issues(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, type TEXT NOT NULL, category TEXT, title TEXT NOT NULL,
    description TEXT, property TEXT, priority TEXT NOT NULL DEFAULT 'Normal', status TEXT NOT NULL DEFAULT 'Open', assigned_to TEXT, due_date TEXT,
    required_action TEXT, resolution TEXT, customer_comms TEXT NOT NULL DEFAULT 'Not needed', created_by TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT);`);
conv.ensureTables(db);
db.prepare("INSERT INTO employees(id, name, role) VALUES (1, 'Eric Moore test', 'Cleaner'), (2, 'Answered Crew', 'Cleaner'), (3, 'Recent Crew', 'Cleaner')").run();

const T0 = Date.parse('2026-11-19T10:00:00Z');
const at = minutesAfterT0 => new Date(T0 + minutesAfterT0 * 60000).toISOString();
const addCrew = (empId, body, when) => conv.addMessage(db, { kind: 'crew', employeeId: empId, role: 'crew', senderRef: 'crew', body, legacyRef: null })
  && db.prepare("UPDATE conversation_messages SET created_at=? WHERE id=(SELECT MAX(id) FROM conversation_messages)").run(when);
const addOffice = (empId, body, when) => conv.addMessage(db, { kind: 'crew', employeeId: empId, role: 'office', senderRef: 'office', body, legacyRef: null })
  && db.prepare("UPDATE conversation_messages SET created_at=? WHERE id=(SELECT MAX(id) FROM conversation_messages)").run(when);

addCrew(1, 'Hello, no reply yet', at(0));       // unanswered, 2 hours old
addCrew(2, 'Can I leave early?', at(0));        // answered below
addOffice(2, 'Yes, go ahead', at(10));
addCrew(3, 'Recent question', at(100));         // unanswered but only 20 minutes old at the check time

const NOW = T0 + 120 * 60000;                   // check time: 2 hours after the first messages
let failed = 0;
const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(extra || {}))); if (!cond) failed++; };

const threads = conv.crewThreads(db, NOW);
const byId = Object.fromEntries(threads.map(t => [t.id, t]));
ok('unanswered crew message past the limit is flagged', byId[1].waiting_over_hour === true && byId[1].needs_reply === true, byId[1]);
ok('answered thread is not flagged', byId[2].waiting_over_hour === false && byId[2].needs_reply === false, byId[2]);
ok('recent unanswered thread is not flagged yet', byId[3].waiting_over_hour === false && byId[3].needs_reply === true, byId[3]);

const first = conv.crewEscalationSweep(db, NOW);
ok('sweep escalates exactly the one overdue message', first === 1, { first });
const tasks = db.prepare('SELECT * FROM customer_issues').all();
ok('one urgent unassigned task created', tasks.length === 1 && tasks[0].priority === 'Urgent' && tasks[0].assigned_to === null && tasks[0].category === 'Crew message', tasks);
ok('task names the crew member', tasks[0] && /Eric Moore test/.test(tasks[0].title), tasks[0]);

const again = conv.crewEscalationSweep(db, NOW + 5 * 60000);
ok('a second sweep does not duplicate the task', again === 0 && db.prepare('SELECT COUNT(*) n FROM customer_issues').get().n === 1);

const later = conv.crewEscalationSweep(db, NOW + 90 * 60000);
ok('recent message escalates later, once it is past the limit', later === 1 && db.prepare('SELECT COUNT(*) n FROM customer_issues').get().n === 2, { later });

// A later message in the same unanswered run does not restart the hour or make a second task.
const firstId = db.prepare("SELECT MIN(m.id) id FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.employee_id=1 AND c.kind='crew'").get().id;
addCrew(1, 'Still waiting, second message', at(115));
const run = Object.fromEntries(conv.crewThreads(db, NOW + 10 * 60000).map(t => [t.id, t]));
ok('the hour counts from the first unanswered message', run[1].waiting_id === firstId && run[1].waiting_over_hour === true, run[1]);
const afterSecond = conv.crewEscalationSweep(db, NOW + 10 * 60000);
ok('a second message in the same run creates no second task', afterSecond === 0, { afterSecond });
// The office replies: the run ends and nothing is waiting.
addOffice(1, 'On it', at(130));
ok('after an office reply nothing is waiting', conv.crewThreads(db, NOW + 200 * 60000).find(t => t.id === 1).waiting_over_hour === false);

console.log(`\n${failed ? failed + ' failed' : 'all passed'}`);
process.exit(failed ? 1 : 0);
