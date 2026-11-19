// Shared conversation record for customer, crew and office messages.
// One conversation per thread (a customer thread, or a crew member's thread with the office).
// Every message belongs to exactly one conversation, so the office, the customer and the crew see the same history.
// Existing tables (portal_messages, crew_messages) are copied in by backfill(); the originals are left in place.
const NOW = () => new Date().toISOString();

function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS conversations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('customer','crew')),
    customer_email TEXT,
    employee_id INTEGER,
    subject TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    assigned_to TEXT,
    legacy_ref TEXT UNIQUE,
    created_at TEXT NOT NULL,
    last_message_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_messages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    sender_role TEXT NOT NULL CHECK (sender_role IN ('customer','crew','office')),
    sender_ref TEXT,
    body TEXT NOT NULL,
    subject TEXT,
    reply_to TEXT,
    visit_id INTEGER,
    project_id INTEGER,
    created_at TEXT NOT NULL,
    seen_by_office INTEGER NOT NULL DEFAULT 0,
    seen_by_other INTEGER NOT NULL DEFAULT 0,
    legacy_ref TEXT UNIQUE)`);
  db.exec('CREATE INDEX IF NOT EXISTS conv_msgs_by_conv ON conversation_messages(conversation_id, id)');
  db.exec('CREATE INDEX IF NOT EXISTS conv_by_customer ON conversations(customer_email, last_message_at)');
  db.exec('CREATE INDEX IF NOT EXISTS conv_by_employee ON conversations(employee_id, last_message_at)');
}

function conversationFor(db, { kind, customerEmail, employeeId, subject }) {
  const email = kind === 'customer' ? String(customerEmail || '').trim().toLowerCase() : null;
  const emp = kind === 'crew' ? Number(employeeId) : null;
  if (kind === 'customer' && !email) throw new Error('A customer conversation needs the customer email.');
  if (kind === 'crew' && !emp) throw new Error('A crew conversation needs the employee.');
  const found = kind === 'customer'
    ? db.prepare("SELECT id FROM conversations WHERE kind='customer' AND customer_email=? AND status!='closed' ORDER BY id DESC LIMIT 1").get(email)
    : db.prepare("SELECT id FROM conversations WHERE kind='crew' AND employee_id=? AND status!='closed' ORDER BY id DESC LIMIT 1").get(emp);
  if (found) return found.id;
  const t = NOW();
  return db.prepare('INSERT INTO conversations(kind,customer_email,employee_id,subject,status,created_at,last_message_at) VALUES(?,?,?,?,?,?,?)')
    .run(kind, email, emp, String(subject || '').slice(0, 200) || null, 'open', t, t).lastInsertRowid;
}

// Adds one message. role: 'customer' | 'crew' | 'office'. Returns the message id.
function addMessage(db, { kind, customerEmail, employeeId, subject, role, senderRef, body, visitId, projectId, legacyRef, replyTo }) {
  if (!['customer', 'crew', 'office'].includes(role)) throw new Error('Unknown sender.');
  const text = String(body || '').trim();
  if (!text) throw new Error('A message needs text.');
  if (legacyRef) {
    const dup = db.prepare('SELECT id FROM conversation_messages WHERE legacy_ref=?').get(legacyRef);
    if (dup) return dup.id; // idempotent: a repeated copy or retry never doubles a message
  }
  const convId = conversationFor(db, { kind, customerEmail, employeeId, subject });
  const t = NOW();
  const direction = role === 'office' ? 'out' : 'in';
  const id = db.prepare(`INSERT INTO conversation_messages(conversation_id,direction,sender_role,sender_ref,body,subject,reply_to,visit_id,project_id,created_at,seen_by_office,seen_by_other,legacy_ref)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(convId, direction, role, senderRef ? String(senderRef).slice(0, 200) : null, text.slice(0, 10000), subject ? String(subject).slice(0, 200) : null, replyTo || null,
    visitId || null, projectId || null, t, role === 'office' ? 1 : 0, role === 'office' ? 0 : 0, legacyRef || null).lastInsertRowid;
  db.prepare('UPDATE conversations SET last_message_at=? WHERE id=?').run(t, convId);
  return id;
}

// Full thread for one conversation, oldest first.
function thread(db, conversationId) {
  return db.prepare('SELECT id,direction,sender_role,sender_ref,body,visit_id,project_id,created_at,seen_by_office FROM conversation_messages WHERE conversation_id=? ORDER BY id').all(conversationId);
}

// Copies existing customer and crew messages into the shared record. Safe to run more than once.
function backfill(db) {
  const copied = { customer: 0, crew: 0 };
  const hasPortal = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='portal_messages'").get();
  if (hasPortal) {
    for (const m of db.prepare('SELECT id,email,subject,body,created_at FROM portal_messages ORDER BY id').all()) {
      const before = db.prepare('SELECT 1 FROM conversation_messages WHERE legacy_ref=?').get('portal:' + m.id);
      if (before) continue;
      addMessage(db, { kind: 'customer', customerEmail: m.email, subject: m.subject, role: 'customer', senderRef: m.email, body: m.body, legacyRef: 'portal:' + m.id });
      copied.customer++;
    }
    const hasReplies = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='portal_message_replies'").get();
    if (hasReplies) {
      for (const r of db.prepare('SELECT r.id,r.message_id,r.body,r.by_user,r.created_at,m.email FROM portal_message_replies r JOIN portal_messages m ON m.id=r.message_id ORDER BY r.id').all()) {
        if (db.prepare('SELECT 1 FROM conversation_messages WHERE legacy_ref=?').get('portal_reply:' + r.id)) continue;
        addMessage(db, { kind: 'customer', customerEmail: r.email, role: 'office', senderRef: r.by_user || 'office', body: r.body, replyTo: 'portal:' + r.message_id, legacyRef: 'portal_reply:' + r.id });
        copied.customer++;
      }
    }
  }
  const hasCrew = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='crew_messages'").get();
  if (hasCrew) {
    for (const m of db.prepare('SELECT id,employee_id,visit_id,direction,body FROM crew_messages ORDER BY id').all()) {
      if (db.prepare('SELECT 1 FROM conversation_messages WHERE legacy_ref=?').get('crew:' + m.id)) continue;
      addMessage(db, { kind: 'crew', employeeId: m.employee_id, role: m.direction === 'office' ? 'office' : 'crew', senderRef: String(m.employee_id), body: m.body, visitId: m.visit_id, legacyRef: 'crew:' + m.id });
      copied.crew++;
    }
  }
  return copied;
}

module.exports = { ensureTables, conversationFor, addMessage, thread, backfill };

// Used by the message write paths: records the shared copy and never blocks the legacy write.
// A failure here is logged; the original message row has already been saved.
function mirror(db, opts) {
  try { return addMessage(db, opts); }
  catch (err) { console.error('shared message not recorded:', err.message); return null; }
}
module.exports.mirror = mirror;

// ---- Reads for the crew screens. They return the same shape the screens already use. ----

// The last `limit` messages of one crew member's thread, oldest first, as { id, direction, body, visit_id, created_at }.
// direction is 'crew' for messages from the crew member and 'office' for messages from the office.
function crewThread(db, employeeId, limit = 100) {
  return db.prepare(`SELECT m.id, m.sender_role, m.body, m.visit_id, m.created_at
      FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.kind='crew' AND c.employee_id=? ORDER BY m.id DESC LIMIT ?`).all(Number(employeeId), limit)
    .reverse().map(r => ({ id: r.id, direction: r.sender_role === 'crew' ? 'crew' : 'office', body: r.body, visit_id: r.visit_id, created_at: r.created_at }));
}

// The crew member has read the office's messages.
function markReadByCrew(db, employeeId) {
  db.prepare(`UPDATE conversation_messages SET seen_by_other=1 WHERE sender_role='office' AND seen_by_other=0
    AND conversation_id IN (SELECT id FROM conversations WHERE kind='crew' AND employee_id=?)`).run(Number(employeeId));
}

// The office has read the crew member's messages.
function markReadByOffice(db, employeeId) {
  db.prepare(`UPDATE conversation_messages SET seen_by_office=1 WHERE sender_role='crew' AND seen_by_office=0
    AND conversation_id IN (SELECT id FROM conversations WHERE kind='crew' AND employee_id=?)`).run(Number(employeeId));
}

// One row per crew member who has a thread: name, role, last message, last time, and unread from the crew.
// A crew message with no office reply after this many minutes is escalated (a task, and a repeat alert in the office).
const CREW_ESCALATE_MIN = Number(process.env.CREW_MESSAGE_ESCALATE_MINUTES) || 60;

function crewThreads(db, nowMs = Date.now()) {
  return db.prepare(`SELECT e.id, e.name, e.role,
      (SELECT m.body FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.kind='crew' AND c.employee_id=e.id ORDER BY m.id DESC LIMIT 1) AS last_body,
      (SELECT m.created_at FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.kind='crew' AND c.employee_id=e.id ORDER BY m.id DESC LIMIT 1) AS last_at,
      (SELECT m.sender_role FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.kind='crew' AND c.employee_id=e.id ORDER BY m.id DESC LIMIT 1) AS last_role,
      (SELECT m.id FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.kind='crew' AND c.employee_id=e.id ORDER BY m.id DESC LIMIT 1) AS last_id,
      (SELECT COUNT(*) FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.kind='crew' AND c.employee_id=e.id AND m.sender_role='crew' AND m.seen_by_office=0) AS unread,
      (SELECT MIN(m.id) FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.kind='crew' AND c.employee_id=e.id AND m.sender_role='crew'
          AND m.id > COALESCE((SELECT MAX(m2.id) FROM conversation_messages m2 JOIN conversations c2 ON c2.id=m2.conversation_id WHERE c2.kind='crew' AND c2.employee_id=e.id AND m2.sender_role='office'), 0)) AS waiting_id
    FROM employees e WHERE e.id IN (SELECT employee_id FROM conversations WHERE kind='crew') ORDER BY last_at DESC`).all().map(r => {
    // The clock starts at the first crew message nobody in the office has answered (later messages in the same run do not restart it).
    const since = r.waiting_id ? db.prepare('SELECT created_at FROM conversation_messages WHERE id=?').get(r.waiting_id).created_at : null;
    return {
      ...r,
      // Opening the thread does not answer it; only an office reply does.
      needs_reply: r.last_role === 'crew',
      waiting_since: since,
      waiting_over_hour: !!since && Date.parse(since) < nowMs - CREW_ESCALATE_MIN * 60000
    };
  });
}

// Creates one urgent task per crew message that has gone unanswered past the limit. Each message is escalated once.
function crewEscalationSweep(db, nowMs = Date.now()) {
  db.exec('CREATE TABLE IF NOT EXISTS crew_escalations(message_id INTEGER PRIMARY KEY, task_id INTEGER, created_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT message_id FROM crew_escalations').all().map(r => r.message_id));
  const due = crewThreads(db, nowMs).filter(t => t.waiting_over_hour && !done.has(t.waiting_id));
  const today = require('./bizdate').today();
  for (const t of due) {
    const msg = db.prepare('SELECT body FROM conversation_messages WHERE id=?').get(t.waiting_id);
    const at = new Date(nowMs).toISOString();
    const task = db.prepare(`INSERT INTO customer_issues(customer_id, type, category, title, description, priority, status, assigned_to, due_date, created_by, created_at, updated_at)
      VALUES (NULL, 'Task', 'Crew message', ?, ?, 'Urgent', 'Open', NULL, ?, 'system', ?, ?)`)
      .run(`Reply to crew: ${t.name} (no reply after ${CREW_ESCALATE_MIN} minutes)`, String(msg && msg.body || '').slice(0, 500), today, at, at);
    db.prepare('INSERT INTO crew_escalations(message_id, task_id, created_at) VALUES(?,?,?)').run(t.waiting_id, task.lastInsertRowid, at);
  }
  return due.length;
}

module.exports.crewThread = crewThread;
module.exports.markReadByCrew = markReadByCrew;
module.exports.markReadByOffice = markReadByOffice;
module.exports.crewThreads = crewThreads;
module.exports.crewEscalationSweep = crewEscalationSweep;

// Customer messages in the shape the customer portal and the office Client messages screen already use:
// { id (the original portal message id), email, subject, body, created_at, replies: [{ body, by_user, created_at }] }.
// email: a customer's address, or null for every customer (newest first, at most `limit`).
function customerGroups(db, { email = null, limit = 100 } = {}) {
  const params = [];
  let where = "c.kind='customer'";
  if (email) { where += ' AND c.customer_email=?'; params.push(String(email).trim().toLowerCase()); }
  const rows = db.prepare(`SELECT m.id, m.sender_role, m.sender_ref, m.body, m.subject, m.reply_to, m.created_at, m.legacy_ref, c.customer_email
      FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE ${where} ORDER BY m.id`).all(...params);
  const groups = [];
  let open = null;
  for (const r of rows) {
    if (r.sender_role === 'customer') {
      const legacy = /^portal:(\d+)$/.exec(r.legacy_ref || '');
      open = { id: legacy ? Number(legacy[1]) : r.id, email: r.customer_email, subject: r.subject || '', body: r.body, created_at: r.created_at, replies: [] };
      groups.push(open);
    } else if (r.sender_role === 'office') {
      // A reply belongs to the message it answers; without a link it follows the latest customer message.
      const parent = String(r.reply_to || '').match(/^portal:([0-9]+)$/);
      const target = parent ? groups.find(g => g.id === Number(parent[1])) : open;
      if (target) target.replies.push({ id: r.id, body: r.body, by_user: r.sender_ref || 'office', created_at: r.created_at });
    }
  }
  return groups.reverse().slice(0, limit);
}

module.exports.customerGroups = customerGroups;
