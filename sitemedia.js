// Website photos and videos. Admins change them in Website; the public projects page reads the visible gallery and
// the page video from /api/site/gallery. Uploaded files are served only when registered here, so other uploads
// (documents, customer files) stay private. Seeded items are added once; later admin edits are never overwritten.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), multer = require('multer');
const { verifyUploads } = require('./filecheck');

const IMAGE = /\.(jpe?g|png|webp)$/i, VIDEO = /\.(mp4|m4v|mov|webm)$/i;
const kindOf = name => (IMAGE.test(String(name)) ? 'image' : VIDEO.test(String(name)) ? 'video' : null);
const SHIPPED = [
  { key: 'commercial-showroom', slot: 'gallery', kind: 'image', url: '/assets/projects/commercial-showroom.jpg', title: 'Commercial showroom', location: 'Des Moines, Iowa', alt: 'Commercial showroom interior in Des Moines' },
  { key: 'multifamily-community', slot: 'gallery', kind: 'image', url: '/assets/projects/multifamily-community.jpg', title: 'Multifamily community', location: 'Des Moines, Iowa', alt: 'Multifamily apartment community in Des Moines' },
  { key: 'apartment-interiors', slot: 'gallery', kind: 'image', url: '/assets/projects/apartment-interiors.jpg', title: 'Apartment interiors', location: 'Des Moines, Iowa', alt: 'Apartment unit kitchen and living area' },
  { key: 'apartment-kitchen', slot: 'gallery', kind: 'image', url: '/assets/projects/apartment-kitchen.jpg', title: 'Apartment kitchen', location: '', alt: 'Apartment kitchen with dark wood cabinets, white counters and stainless appliances' },
  { key: 'fitness-center', slot: 'gallery', kind: 'image', url: '/assets/projects/fitness-center.jpg', title: 'Fitness center', location: '', alt: 'Fitness center with treadmills, bikes and wall-mounted televisions' },
  { key: 'clubroom', slot: 'gallery', kind: 'image', url: '/assets/projects/clubroom.jpg', title: 'Clubroom', location: '', alt: 'Clubroom with a kitchenette, bar seating and high-top tables' },
  { key: 'lounge-seating', slot: 'gallery', kind: 'image', url: '/assets/projects/lounge-seating.jpg', title: 'Lounge seating', location: '', alt: 'Lounge with leather sofas, armchairs and a brick accent wall' },
  { key: 'lobby-lounge', slot: 'gallery', kind: 'image', url: '/assets/projects/lobby-lounge.jpg', title: 'Lobby lounge', location: '', alt: 'Lobby lounge with leather armchairs and a brick wall' },
  { key: 'automotive-service-floor', slot: 'gallery', kind: 'image', url: '/assets/projects/automotive-service-floor.webp', title: 'Automotive service floor', location: '', alt: 'Vehicle service bays with lifts in a new automotive facility' },
  { key: 'dealership-exterior', slot: 'gallery', kind: 'image', url: '/assets/projects/dealership-exterior.webp', title: 'Dealership exterior', location: '', alt: 'Exterior of a newly built automotive dealership' },
  { key: 'dealership-showroom', slot: 'gallery', kind: 'image', url: '/assets/projects/dealership-showroom.webp', title: 'Dealership showroom lobby', location: '', alt: 'Showroom lobby of a newly built automotive dealership' },
  { key: 'des-moines-video', slot: 'hero_video', kind: 'video', url: '/assets/projects/des-moines-projects.mp4', poster: '/assets/projects/des-moines-projects.jpg', title: 'Des Moines projects', location: '', alt: 'Des Moines projects video' }
];

module.exports = function (app, { db, auth, logAction, clean, uploadDir }) {
  db.exec(`CREATE TABLE IF NOT EXISTS site_media(
    id INTEGER PRIMARY KEY AUTOINCREMENT, slot TEXT NOT NULL DEFAULT 'gallery', kind TEXT NOT NULL, url TEXT NOT NULL, file TEXT,
    title TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', alt TEXT NOT NULL DEFAULT '', poster TEXT,
    visible INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS site_media_seeded(key TEXT PRIMARY KEY);`);
  const now = () => new Date().toISOString();
  const seenKey = db.prepare('SELECT 1 FROM site_media_seeded WHERE key=?'), markSeen = db.prepare('INSERT OR IGNORE INTO site_media_seeded(key) VALUES(?)');
  const addRow = db.prepare('INSERT INTO site_media(slot,kind,url,file,title,location,alt,poster,visible,sort,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?,?)');
  // Seed the shipped photos once. Each seed key is recorded, so an item an admin deletes is never re-added on restart.
  SHIPPED.forEach((s, i) => { if (seenKey.get(s.key)) return; const t = now(); addRow.run(s.slot, s.kind, s.url, null, s.title, s.location, s.alt, s.poster || null, i + 1, t, t); markSeen.run(s.key); });

  const dropFile = f => { if (!f) return; try { fs.unlinkSync(path.join(uploadDir, path.basename(String(f)))); } catch { /* already gone */ } };
  const flag = v => !(v === false || v === 'false' || v === '0' || v === 0);
  const nextSort = () => ((db.prepare("SELECT COALESCE(MAX(sort),0)+1 AS n FROM site_media WHERE slot='gallery'").get() || {}).n) || 1;
  const pub = r => ({ id: r.id, kind: r.kind, url: r.url, poster: r.poster || null, title: r.title, location: r.location, alt: r.alt });

  // Public: the visible gallery and the page video.
  app.get('/api/site/gallery', (req, res) => {
    const gallery = db.prepare("SELECT * FROM site_media WHERE slot='gallery' AND visible=1 ORDER BY sort, id").all().map(pub);
    const hero = db.prepare("SELECT * FROM site_media WHERE slot='hero_video' AND visible=1 ORDER BY id DESC LIMIT 1").get();
    res.set('Cache-Control', 'no-cache'); res.json({ gallery, hero: hero ? pub(hero) : null });
  });
  // Public: uploaded website files, only when registered here.
  app.get('/site-media/:name', (req, res) => {
    const name = path.basename(req.params.name);
    if (!db.prepare('SELECT 1 FROM site_media WHERE file=?').get(name)) return res.status(404).end();
    const p = path.join(uploadDir, name); if (!fs.existsSync(p)) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=3600'); res.sendFile(p);
  });

  // Admin upload: one file, type-checked by content and size-limited.
  const upload = multer({
    storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, uploadDir), filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).slice(0, 10).toLowerCase()) }),
    limits: { fileSize: 200 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => { const ok = !!kindOf(file.originalname); cb(ok ? null : new Error('Choose a JPG, PNG or WEBP photo, or an MP4, MOV or WEBM video.'), ok); }
  }).single('file');
  const receive = (req, res, next) => upload(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than 200 MB.' : (err.message || 'Upload failed.') });
    verifyUploads(req, res, next);
  });

  app.get('/api/admin/site-media', auth, (req, res) => res.json({ items: db.prepare('SELECT * FROM site_media ORDER BY slot, sort, id').all() }));

  app.post('/api/admin/site-media', auth, receive, (req, res) => {
    const b = req.body || {}, f = req.file, slot = b.slot === 'hero_video' ? 'hero_video' : 'gallery';
    if (!f) return res.status(400).json({ error: 'Choose a photo or video to upload.' });
    const kind = kindOf(f.originalname);
    if (slot === 'hero_video' && kind !== 'video') { dropFile(f.filename); return res.status(400).json({ error: 'The page video must be an MP4, MOV or WEBM file.' }); }
    const title = clean(b.title, 120) || (slot === 'hero_video' ? 'Page video' : path.parse(f.originalname).name.slice(0, 120));
    const location = clean(b.location, 120), alt = clean(b.alt, 240) || title, url = '/site-media/' + f.filename, t = now();
    let id;
    const old = slot === 'hero_video' ? db.prepare("SELECT * FROM site_media WHERE slot='hero_video' ORDER BY id DESC LIMIT 1").get() : null;
    if (old) {
      db.prepare('UPDATE site_media SET kind=?,url=?,file=?,title=?,location=?,alt=?,poster=NULL,visible=1,updated_at=? WHERE id=?').run(kind, url, f.filename, title, location, alt, t, old.id);
      dropFile(old.file); id = old.id;
    } else {
      id = addRow.run(slot, kind, url, f.filename, title, location, alt, null, slot === 'gallery' ? nextSort() : 0, t, t).lastInsertRowid;
    }
    logAction(req, 'added website ' + (slot === 'hero_video' ? 'page video' : 'photo or video'), 'site_media', id, title);
    res.status(201).json({ ok: true, id });
  });

  app.patch('/api/admin/site-media/:id(\\d+)', auth, receive, (req, res) => {
    const row = db.prepare('SELECT * FROM site_media WHERE id=?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Item not found.' });
    const b = req.body || {}, f = req.file;
    let kind = row.kind, url = row.url, file = row.file, poster = row.poster, toDrop = null;
    if (f) {
      const k = kindOf(f.originalname);
      if (row.slot === 'hero_video' && k !== 'video') { dropFile(f.filename); return res.status(400).json({ error: 'The page video must be an MP4, MOV or WEBM file.' }); }
      kind = k; url = '/site-media/' + f.filename; file = f.filename; poster = null; if (row.file) toDrop = row.file;
    }
    const title = b.title !== undefined ? (clean(b.title, 120) || row.title) : row.title;
    const location = b.location !== undefined ? clean(b.location, 120) : row.location;
    const alt = b.alt !== undefined ? (clean(b.alt, 240) || row.alt) : row.alt;
    const visible = b.visible !== undefined ? (flag(b.visible) ? 1 : 0) : row.visible;
    db.prepare('UPDATE site_media SET kind=?,url=?,file=?,title=?,location=?,alt=?,poster=?,visible=?,updated_at=? WHERE id=?').run(kind, url, file, title, location, alt, poster, visible, now(), row.id);
    dropFile(toDrop);
    logAction(req, f ? 'replaced website file' : (visible !== row.visible ? (visible ? 'showed' : 'hid') + ' website item' : 'edited website item'), 'site_media', row.id, title);
    res.json({ ok: true });
  });

  app.post('/api/admin/site-media/reorder', auth, (req, res) => {
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) return res.status(400).json({ error: 'Nothing to reorder.' });
    const set = db.prepare("UPDATE site_media SET sort=? WHERE id=? AND slot='gallery'");
    db.transaction(() => ids.forEach((id, i) => set.run(i + 1, id)))();
    logAction(req, 'reordered website photos', 'site_media', 0, String(ids.length));
    res.json({ ok: true });
  });

  app.delete('/api/admin/site-media/:id(\\d+)', auth, (req, res) => {
    const row = db.prepare('SELECT * FROM site_media WHERE id=?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Item not found.' });
    db.prepare('DELETE FROM site_media WHERE id=?').run(row.id); dropFile(row.file);
    logAction(req, 'removed website item', 'site_media', row.id, row.title);
    res.json({ ok: true });
  });
};
