'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { db, UPLOAD_DIR, hashPassword, verifyPassword, bootstrapAdmin } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 25;
// When false, an approver cannot approve a document they uploaded themselves (four-eyes rule).
const ALLOW_SELF_APPROVAL = (process.env.ALLOW_SELF_APPROVAL ?? 'true') !== 'false';
const SESSION_DAYS = 7;
const COOKIE = 'numsa_session';

const CATEGORIES = [
  'Media Statements',
  'Reports & Speeches',
  'Policies',
  'Agreements & Wage Settlements',
  'Constitution & Governance',
  'Newsletters',
  'Careers',
  'Tenders',
];
// Categories from the earlier NUMSA build, mapped onto the NUM ones.
const RENAMED_CATEGORIES = { 'Press Statements': 'Media Statements', Reports: 'Reports & Speeches', Vacancies: 'Careers', 'Procurement & Tenders': 'Tenders' };
for (const [from, to] of Object.entries(RENAMED_CATEGORIES)) {
  db.prepare('UPDATE documents SET category = ? WHERE category = ?').run(to, from);
}

// Allowed file types. The Content-Type we serve comes from this table, never from the upload.
const FILE_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};
const INLINE_TYPES = new Set(['pdf', 'txt', 'jpg', 'jpeg', 'png']);

bootstrapAdmin();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

// ---------------------------------------------------------------- helpers
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((p) => p.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}

function setSessionCookie(res, token, maxAgeSec) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.set('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`);
}

function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, s.expires_at FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(token));
  if (!row || row.expires_at < Date.now()) return null;
  const { expires_at, ...user } = row;
  return user;
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  // Cheap CSRF defence on top of SameSite=Strict: state-changing calls must come from our own fetch().
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'fetch') {
    return res.status(403).json({ error: 'Missing request header.' });
  }
  req.user = user;
  next();
}

function requireApprover(req, res, next) {
  if (req.user.role !== 'approver') return res.status(403).json({ error: 'Only approvers can do this.' });
  next();
}

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

function publicDoc(d) {
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    category: d.category,
    ext: d.ext,
    size: d.size,
    published_at: d.published_at,
    url: `/documents/${d.id}/download`,
    view_url: INLINE_TYPES.has(d.ext) ? `/documents/${d.id}/download?inline=1` : null,
  };
}

function sendFile(res, doc, inline) {
  const file = path.join(UPLOAD_DIR, doc.stored_name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'File missing on server.' });
  const asciiName = doc.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  const disp = inline && INLINE_TYPES.has(doc.ext) ? 'inline' : 'attachment';
  res.set('Content-Type', FILE_TYPES[doc.ext] || 'application/octet-stream');
  res.set('Content-Disposition', `${disp}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`);
  // Lock the response down; Chrome's PDF viewer will not render inside a sandboxed document, so skip that for PDFs.
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" + (doc.ext === 'pdf' ? '' : '; sandbox'));
  res.sendFile(file);
}

// ---------------------------------------------------------------- public API
app.get('/api/categories', (req, res) => res.json(CATEGORIES));

// Approved documents only - this is what the home page reads.
app.get('/api/documents', (req, res) => {
  const where = ["status = 'approved'"];
  const args = [];
  if (req.query.category && CATEGORIES.includes(req.query.category)) {
    where.push('category = ?');
    args.push(req.query.category);
  }
  if (req.query.q) {
    where.push('(title LIKE ? OR description LIKE ?)');
    const like = `%${clean(req.query.q, 100).replace(/[%_]/g, '')}%`;
    args.push(like, like);
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 50);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const sqlWhere = where.join(' AND ');
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM documents WHERE ${sqlWhere}`).get(...args);
  const rows = db.prepare(`SELECT * FROM documents WHERE ${sqlWhere} ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset);
  res.json({ total, items: rows.map(publicDoc) });
});

app.get('/documents/:id/download', (req, res) => {
  const doc = db.prepare("SELECT * FROM documents WHERE id = ? AND status = 'approved'").get(Number(req.params.id));
  if (!doc) return res.status(404).send('Document not found.');
  sendFile(res, doc, req.query.inline === '1');
});

// "Get In Touch" form. Rate-limited per IP; a hidden "website" field catches simple bots.
const contactHits = new Map(); // ip -> [timestamps]
app.post('/api/contact', (req, res) => {
  const b = req.body || {};
  if (b.website) return res.status(201).json({ ok: true }); // honeypot: pretend success
  const now = Date.now();
  const recent = (contactHits.get(req.ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= 5) return res.status(429).json({ error: 'Too many messages. Please try again later.' });
  const name = clean(b.name, 100);
  const surname = clean(b.surname, 100);
  const email = clean(b.email, 200);
  const message = clean(b.message, 5000);
  if (!name || !surname) return res.status(400).json({ error: 'Please enter your name and surname.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  db.prepare('INSERT INTO messages (name, surname, email, message) VALUES (?, ?, ?, ?)').run(name, surname, email, message);
  contactHits.set(req.ip, [...recent, now]);
  res.status(201).json({ ok: true });
});

// ---------------------------------------------------------------- auth
const loginAttempts = new Map(); // ip -> { count, until }
app.post('/api/auth/login', (req, res) => {
  const ip = req.ip;
  const a = loginAttempts.get(ip);
  if (a && a.count >= 5 && a.until > Date.now()) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  const email = clean(req.body?.email, 200);
  const password = String(req.body?.password ?? '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    const next = { count: (a && a.until > Date.now() ? a.count : 0) + 1, until: Date.now() + 10 * 60 * 1000 };
    loginAttempts.set(ip, next);
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), user.id, Date.now() + SESSION_DAYS * 864e5);
  setSessionCookie(res, token, SESSION_DAYS * 86400);
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  res.json({ ...user, allowSelfApproval: ALLOW_SELF_APPROVAL });
});

// ---------------------------------------------------------------- admin: documents
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(1).toLowerCase();
      cb(null, `${crypto.randomUUID()}.${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(1).toLowerCase();
    if (!FILE_TYPES[ext]) return cb(new Error(`File type .${ext || '?'} is not allowed.`));
    cb(null, true);
  },
});

const ADMIN_DOC_SQL = `
  SELECT d.*, up.name AS uploaded_by_name, rv.name AS reviewed_by_name
  FROM documents d
  LEFT JOIN users up ON up.id = d.uploaded_by
  LEFT JOIN users rv ON rv.id = d.reviewed_by`;

const getDoc = (id) => db.prepare(`${ADMIN_DOC_SQL} WHERE d.id = ?`).get(Number(id));

app.get('/api/admin/stats', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM documents GROUP BY status').all();
  const stats = { pending: 0, approved: 0, rejected: 0, archived: 0 };
  for (const r of rows) stats[r.status] = r.n;
  stats.unread = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE is_read = 0').get().n;
  res.json(stats);
});

app.get('/api/admin/documents', requireAuth, (req, res) => {
  const status = ['pending', 'approved', 'rejected', 'archived'].includes(req.query.status) ? req.query.status : null;
  const rows = status
    ? db.prepare(`${ADMIN_DOC_SQL} WHERE d.status = ? ORDER BY d.uploaded_at DESC, d.id DESC`).all(status)
    : db.prepare(`${ADMIN_DOC_SQL} ORDER BY d.uploaded_at DESC, d.id DESC`).all();
  res.json(rows.map(({ stored_name, ...d }) => d));
});

app.post('/api/admin/documents', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${MAX_UPLOAD_MB} MB.` : err.message;
      return res.status(400).json({ error: msg });
    }
    const discard = () => req.file && fs.rm(req.file.path, { force: true }, () => {});
    if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' });
    const title = clean(req.body.title, 200);
    const description = clean(req.body.description, 1000);
    const category = clean(req.body.category, 100);
    if (!title) { discard(); return res.status(400).json({ error: 'Title is required.' }); }
    if (!CATEGORIES.includes(category)) { discard(); return res.status(400).json({ error: 'Choose a valid category.' }); }
    const ext = path.extname(req.file.originalname).slice(1).toLowerCase();
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO documents (title, description, category, original_name, stored_name, ext, size, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(title, description, category, clean(req.file.originalname, 255), req.file.filename, ext, req.file.size, req.user.id);
    const { stored_name, ...doc } = getDoc(lastInsertRowid);
    res.status(201).json(doc);
  });
});

// Preview any document (incl. pending) for signed-in staff.
app.get('/api/admin/documents/:id/file', requireAuth, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
  if (!doc) return res.status(404).json({ error: 'Not found.' });
  sendFile(res, doc, req.query.inline === '1');
});

app.patch('/api/admin/documents/:id', requireAuth, (req, res) => {
  const doc = getDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found.' });
  const isOwner = doc.uploaded_by === req.user.id;
  if (req.user.role !== 'approver' && !(isOwner && doc.status !== 'approved')) {
    return res.status(403).json({ error: 'You can only edit your own documents before they are published.' });
  }
  const title = req.body.title !== undefined ? clean(req.body.title, 200) : doc.title;
  const description = req.body.description !== undefined ? clean(req.body.description, 1000) : doc.description;
  const category = req.body.category !== undefined ? clean(req.body.category, 100) : doc.category;
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Choose a valid category.' });
  // An editor changing a rejected document sends it back to the review queue.
  const status = doc.status === 'rejected' && req.user.role !== 'approver' ? 'pending' : doc.status;
  db.prepare('UPDATE documents SET title = ?, description = ?, category = ?, status = ? WHERE id = ?')
    .run(title, description, category, status, doc.id);
  const { stored_name, ...updated } = getDoc(doc.id);
  res.json(updated);
});

function review(action) {
  return (req, res) => {
    const doc = getDoc(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found.' });
    const note = clean(req.body?.note, 500) || null;
    const allowedFrom = {
      approve: ['pending', 'rejected', 'archived'],
      reject: ['pending'],
      unpublish: ['approved'],
      resubmit: ['rejected'],
    }[action];
    if (!allowedFrom.includes(doc.status)) {
      return res.status(409).json({ error: `Cannot ${action} a document that is ${doc.status}.` });
    }
    if (action === 'approve' && !ALLOW_SELF_APPROVAL && doc.uploaded_by === req.user.id) {
      return res.status(403).json({ error: 'Another approver must approve documents you uploaded.' });
    }
    if (action === 'reject' && !note) return res.status(400).json({ error: 'Give a reason for rejecting.' });

    if (action === 'approve') {
      // Approval is the publish step: the public API only ever lists status = 'approved'.
      db.prepare(`UPDATE documents SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now'),
                  review_note = ?, published_at = datetime('now') WHERE id = ?`).run(req.user.id, note, doc.id);
    } else if (action === 'reject') {
      db.prepare(`UPDATE documents SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'),
                  review_note = ? WHERE id = ?`).run(req.user.id, note, doc.id);
    } else if (action === 'unpublish') {
      db.prepare(`UPDATE documents SET status = 'archived', reviewed_by = ?, reviewed_at = datetime('now'),
                  review_note = COALESCE(?, review_note) WHERE id = ?`).run(req.user.id, note, doc.id);
    } else if (action === 'resubmit') {
      db.prepare(`UPDATE documents SET status = 'pending' WHERE id = ?`).run(doc.id);
    }
    const { stored_name, ...updated } = getDoc(doc.id);
    res.json(updated);
  };
}
app.post('/api/admin/documents/:id/approve', requireAuth, requireApprover, review('approve'));
app.post('/api/admin/documents/:id/reject', requireAuth, requireApprover, review('reject'));
app.post('/api/admin/documents/:id/unpublish', requireAuth, requireApprover, review('unpublish'));
app.post('/api/admin/documents/:id/resubmit', requireAuth, (req, res, next) => {
  const doc = getDoc(req.params.id);
  if (doc && req.user.role !== 'approver' && doc.uploaded_by !== req.user.id) {
    return res.status(403).json({ error: 'You can only resubmit your own documents.' });
  }
  next();
}, review('resubmit'));

app.delete('/api/admin/documents/:id', requireAuth, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
  if (!doc) return res.status(404).json({ error: 'Not found.' });
  const isOwner = doc.uploaded_by === req.user.id;
  if (req.user.role !== 'approver' && !(isOwner && doc.status !== 'approved')) {
    return res.status(403).json({ error: 'You can only delete your own unpublished documents.' });
  }
  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  fs.rm(path.join(UPLOAD_DIR, doc.stored_name), { force: true }, () => {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------- admin: contact messages (approvers only)
app.get('/api/admin/messages', requireAuth, requireApprover, (req, res) => {
  res.json(db.prepare('SELECT * FROM messages ORDER BY created_at DESC, id DESC LIMIT 500').all());
});
app.post('/api/admin/messages/:id/read', requireAuth, requireApprover, (req, res) => {
  const r = db.prepare('UPDATE messages SET is_read = ? WHERE id = ?').run(req.body?.read === false ? 0 : 1, Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
});
app.delete('/api/admin/messages/:id', requireAuth, requireApprover, (req, res) => {
  const r = db.prepare('DELETE FROM messages WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- admin: users (approvers only)
app.get('/api/admin/users', requireAuth, requireApprover, (req, res) => {
  res.json(db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY name').all());
});

app.post('/api/admin/users', requireAuth, requireApprover, (req, res) => {
  const name = clean(req.body.name, 100);
  const email = clean(req.body.email, 200);
  const role = req.body.role === 'approver' ? 'approver' : 'editor';
  const password = String(req.body.password ?? '');
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Name and a valid email are required.' });
  if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
  try {
    const { lastInsertRowid } = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(name, email, hashPassword(password), role);
    res.status(201).json(db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'A user with that email already exists.' });
    throw e;
  }
});

app.post('/api/admin/users/:id/password', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (req.user.role !== 'approver' && req.user.id !== id) return res.status(403).json({ error: 'Not allowed.' });
  const password = String(req.body.password ?? '');
  if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
  const r = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
  if (!r.changes) return res.status(404).json({ error: 'Not found.' });
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND user_id != ?').run(id, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAuth, requireApprover, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete your own account." });
  const r = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  if (!r.changes) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- pages
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`NUM site running at http://localhost:${PORT}`);
  console.log(`Admin portal:          http://localhost:${PORT}/admin`);
});
