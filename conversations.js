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
function addMessage(db, { kind, customerEmail, employeeId, subject, role, senderRef, body, visitId, projectId, legacyRef }) {
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
  const id = db.prepare(`INSERT INTO conversation_messages(conversation_id,direction,sender_role,sender_ref,body,visit_id,project_id,created_at,seen_by_office,seen_by_other,legacy_ref)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(convId, direction, role, senderRef ? String(senderRef).slice(0, 200) : null, text.slice(0, 10000),
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
      for (const r of db.prepare('SELECT r.id,r.body,r.by_user,r.created_at,m.email FROM portal_message_replies r JOIN portal_messages m ON m.id=r.message_id ORDER BY r.id').all()) {
        if (db.prepare('SELECT 1 FROM conversation_messages WHERE legacy_ref=?').get('portal_reply:' + r.id)) continue;
        addMessage(db, { kind: 'customer', customerEmail: r.email, role: 'office', senderRef: r.by_user || 'office', body: r.body, legacyRef: 'portal_reply:' + r.id });
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
