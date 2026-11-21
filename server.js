const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cfg = require('./db/config');

const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('JWT_SECRET not set: using a random secret, so logins reset on restart.');

const pool = mysql.createPool({ ...cfg, decimalNumbers: true, dateStrings: true, connectionLimit: 10 });
const app = express();

const FRONTEND_ORIGIN = 'https://uniolx.yashvats20-29.workers.dev';

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', FRONTEND_ORIGIN);
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Uploaded listing photos live in ./uploads (outside public/) and are served read-only
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', setHeaders: r => r.set('X-Content-Type-Options', 'nosniff') }));

/* ---------- Helpers ---------- */
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

const h = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error(e.code || '', e.sqlMessage || e.message);
    const userErr = e.sqlState === '45000'
      || /^ER_(DUP_ENTRY|CHECK|NO_REFERENCED|ROW_IS_REFERENCED|BAD_NULL|DATA_TOO_LONG|TRUNCATED|WARN_DATA|DATA_OUT_OF_RANGE|WRONG_VALUE)/.test(e.code || '');
    // Never expose SQL text or table names to the browser: map errors to friendly messages
    let msg = 'Invalid input';
    if (e.sqlState === '45000') msg = e.sqlMessage;               // our own trigger rules, written for users
    else if (e.code === 'ER_NO_REFERENCED_ROW_2') msg = 'Referenced user, item or category does not exist';
    else if (e.code === 'ER_DUP_ENTRY') msg = /email/.test(e.sqlMessage) ? 'That email is already registered' : /roll/.test(e.sqlMessage) ? 'That roll number is already registered' : 'That value already exists';
    else if (/^ER_CHECK/.test(e.code || '')) msg = 'One of the values is not allowed (for example a negative price)';
    else if (e.code === 'ER_DATA_TOO_LONG') msg = 'One of the fields is too long';
    res.status(userErr ? 400 : 500).json({ error: userErr ? msg : 'Internal server error' });
  }
};
const q = async (sql, p = []) => (await pool.query(sql, p))[0];
const PAYMENT_MODES = { cash: 'Cash', upi: 'UPI', card: 'Card' };
const CONDITIONS = { 'new': 'New', 'like new': 'Like New', good: 'Good', fair: 'Fair' };
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const imageOk = v => !v || /^(https?:\/\/\S{3,480}|\/uploads\/[a-f0-9]{32}\.(jpg|png|gif|webp))$/i.test(v);

/* ---------- Auth (bcrypt + JWT in an httpOnly cookie) ---------- */
const getCookie = (req, name) => (req.headers.cookie || '').split(';').map(c => c.trim().split('='))
  .filter(([k]) => k === name).map(([, ...v]) => decodeURIComponent(v.join('=')))[0];

const startSession = (res, id) => res.cookie(
  'token',
  jwt.sign({ id }, SECRET, { expiresIn: '7d' }),
  {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    maxAge: 7 * 864e5
  }
);

const attempts = new Map(); // tiny in-memory login rate limiter: 10 tries / 15 min / IP
const limited = ip => {
  const now = Date.now(), a = attempts.get(ip);
  if (!a || a.reset < now) { attempts.set(ip, { n: 1, reset: now + 15 * 60e3 }); return false; }
  return ++a.n > 10;
};

const USER_COLS = 'user_id,name,email,roll_no,phone,hostel,role';

app.post('/api/auth/signup', h(async (req, res) => {
  const name = str(req.body.name, 100), email = str(req.body.email, 120).toLowerCase(), roll_no = str(req.body.roll_no, 20);
  const { password } = req.body;
  if (!name || !email || !roll_no || !password) throw new HttpError(400, 'name, email, roll number and password are required');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
  if (String(password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const hash = await bcrypt.hash(String(password), 10);
  const r = await q('INSERT INTO users (name,email,roll_no,phone,hostel,password_hash) VALUES (?,?,?,?,?,?)',
                    [name, email, roll_no, str(req.body.phone, 15) || null, str(req.body.hostel, 50) || null, hash]);
  startSession(res, r.insertId);
  res.status(201).json({ user: (await q(`SELECT ${USER_COLS} FROM users WHERE user_id = ?`, [r.insertId]))[0] });
}));

app.post('/api/auth/login', h(async (req, res) => {
  if (limited(req.ip)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  const email = str(req.body.email, 120).toLowerCase(), password = String(req.body.password || '');
  const rows = await q('SELECT * FROM users WHERE email = ?', [email]);
  const ok = rows.length && rows[0].password_hash && await bcrypt.compare(password, rows[0].password_hash);
  if (!ok) throw new HttpError(401, 'Incorrect email or password');
  startSession(res, rows[0].user_id);
  const { password_hash, ...user } = rows[0];
  res.json({ user });
}));

app.post('/api/auth/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

// Everything below this line requires a logged-in user
app.use('/api', async (req, res, next) => {
  try {
    const t = getCookie(req, 'token');
    if (!t) throw new HttpError(401, 'Please log in');
    let p; try { p = jwt.verify(t, SECRET); } catch { throw new HttpError(401, 'Session expired, please log in again'); }
    const rows = await q(`SELECT ${USER_COLS} FROM users WHERE user_id = ?`, [p.id]);
    if (!rows.length) throw new HttpError(401, 'Account not found');
    req.user = rows[0]; req.userId = rows[0].user_id;
    next();
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});
const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' });

app.get('/api/auth/me', (req, res) => res.json({ user: req.user }));

/* ---------- Profile ---------- */
app.put('/api/me', h(async (req, res) => {
  const name = str(req.body.name, 100);
  if (!name) throw new HttpError(400, 'Name cannot be empty');
  await q('UPDATE users SET name=?, phone=?, hostel=? WHERE user_id=?',
          [name, str(req.body.phone, 15) || null, str(req.body.hostel, 50) || null, req.userId]);
  res.json({ user: (await q(`SELECT ${USER_COLS} FROM users WHERE user_id = ?`, [req.userId]))[0] });
}));

app.put('/api/me/password', h(async (req, res) => {
  const { current, next } = req.body;
  if (!next || String(next).length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
  const [u] = await q('SELECT password_hash FROM users WHERE user_id = ?', [req.userId]);
  if (!u.password_hash || !(await bcrypt.compare(String(current || ''), u.password_hash))) throw new HttpError(400, 'Current password is incorrect');
  await q('UPDATE users SET password_hash = ? WHERE user_id = ?', [await bcrypt.hash(String(next), 10), req.userId]);
  res.json({ updated: true });
}));

app.get('/api/me/stats', h(async (req, res) => {
  const [s] = await q('SELECT items_listed, items_sold, revenue, avg_rating FROM v_seller_stats WHERE user_id = ?', [req.userId]);
  const [b] = await q('SELECT COUNT(*) AS purchases FROM transactions WHERE buyer_id = ?', [req.userId]);
  res.json({ ...s, purchases: b.purchases });
}));

/* ---------- Categories ---------- */
app.get('/api/categories', h(async (req, res) => res.json(await q('SELECT * FROM categories ORDER BY name'))));

/* ---------- Photo upload (logged-in users, images only, max 3 MB) ---------- */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1 } });
// Decide the real file type from its first bytes, never from the filename or client-sent type
function sniffImage(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpg';
  if (b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47]))) return 'png';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
app.post('/api/upload',
  (req, res, next) => upload.single('photo')(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Image must be 3 MB or smaller' : 'Upload failed' });
    next();
  }),
  h(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Choose an image to upload');
    const ext = sniffImage(req.file.buffer);
    if (!ext) throw new HttpError(400, 'Only JPG, PNG, WEBP or GIF images are allowed');
    const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
    await fs.promises.writeFile(path.join(UPLOAD_DIR, name), req.file.buffer);
    res.status(201).json({ url: '/uploads/' + name });
  }));

/* ---------- Items (CRUD) ---------- */
const SORTS = { newest: 'listed_at DESC, item_id DESC', price_asc: 'price ASC, item_id DESC', price_desc: 'price DESC, item_id DESC' };

app.get('/api/items', h(async (req, res) => {
  const { q: search, category, maxPrice, status = 'Available', seller, sort = 'newest' } = req.query;
  let sql = 'SELECT * FROM v_item_details WHERE 1=1';
  const p = [];
  if (status !== 'All') { sql += ' AND status = ?'; p.push(status); }
  if (search) { const like = `%${String(search).replace(/[%_\\]/g, '\\$&')}%`; sql += ' AND (title LIKE ? OR description LIKE ?)'; p.push(like, like); }
  if (category) { sql += ' AND category_id = ?'; p.push(category); }
  if (maxPrice) { sql += ' AND price <= ?'; p.push(maxPrice); }
  if (seller)   { sql += ' AND seller_id = ?'; p.push(seller); }
  res.json(await q(`${sql} ORDER BY ${SORTS[sort] || SORTS.newest}`, p));
}));

app.get('/api/items/:id', h(async (req, res) => {
  const rows = await q(`SELECT v.*, s.avg_rating AS seller_rating, s.items_sold AS seller_sold
    FROM v_item_details v JOIN v_seller_stats s ON s.user_id = v.seller_id WHERE v.item_id = ?`, [req.params.id]);
  if (!rows.length) throw new HttpError(404, 'Item not found');
  res.json(rows[0]);
}));

app.post('/api/items', h(async (req, res) => {
  const { category_id, title, description, price, condition, image_url } = req.body;
  if (!category_id || !str(title, 150) || price === undefined || price === '' || isNaN(Number(price)) || Number(price) < 0)
    throw new HttpError(400, 'category, title and a valid price are required');
  const cond = condition ? CONDITIONS[String(condition).toLowerCase()] : 'Good';
  if (!cond) throw new HttpError(400, 'condition must be New, Like New, Good or Fair');
  if (!imageOk(image_url)) throw new HttpError(400, 'Invalid image');
  const r = await q('INSERT INTO items (seller_id,category_id,title,description,price,`condition`,image_url) VALUES (?,?,?,?,?,?,?)',
                    [req.userId, category_id, str(title, 150), description || null, Number(price), cond, image_url || null]);
  res.status(201).json({ item_id: r.insertId });
}));

async function explainItemFailure(itemId, user) {
  const rows = await q('SELECT seller_id, status FROM items WHERE item_id = ?', [itemId]);
  if (!rows.length) throw new HttpError(404, 'Item not found');
  if (rows[0].seller_id !== user.user_id && user.role !== 'admin') throw new HttpError(403, 'You can only change your own listings');
  throw new HttpError(409, `Item is ${rows[0].status.toLowerCase()} and can no longer be changed`);
}

app.put('/api/items/:id', h(async (req, res) => {
  const body = req.body || {}, sets = [], p = [];
  if ('title' in body) { if (!str(body.title, 150)) throw new HttpError(400, 'title cannot be empty'); sets.push('title = ?'); p.push(str(body.title, 150)); }
  if ('description' in body) { sets.push('description = ?'); p.push(body.description || null); }
  if ('price' in body) {
    if (body.price === null || body.price === '' || isNaN(Number(body.price)) || Number(body.price) < 0) throw new HttpError(400, 'price must be a number >= 0');
    sets.push('price = ?'); p.push(Number(body.price));
  }
  if ('condition' in body) {
    const cond = CONDITIONS[String(body.condition).toLowerCase()];
    if (!cond) throw new HttpError(400, 'condition must be New, Like New, Good or Fair');
    sets.push('`condition` = ?'); p.push(cond);
  }
  if ('category_id' in body) { if (!body.category_id) throw new HttpError(400, 'category cannot be empty'); sets.push('category_id = ?'); p.push(body.category_id); }
  if ('image_url' in body) { if (!imageOk(body.image_url)) throw new HttpError(400, 'Invalid image'); sets.push('image_url = ?'); p.push(body.image_url || null); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  const r = await q(`UPDATE items SET ${sets.join(', ')} WHERE item_id = ? AND seller_id = ? AND status = 'Available'`, [...p, req.params.id, req.userId]);
  if (!r.affectedRows) await explainItemFailure(req.params.id, { ...req.user, role: 'student' });
  res.json({ updated: true });
}));

app.delete('/api/items/:id', h(async (req, res) => {
  const admin = req.user.role === 'admin';
  const r = await q(`UPDATE items SET status='Removed' WHERE item_id = ? AND status='Available'${admin ? '' : ' AND seller_id = ?'}`,
                    admin ? [req.params.id] : [req.params.id, req.userId]);
  if (!r.affectedRows) await explainItemFailure(req.params.id, req.user);
  res.json({ removed: true });
}));

/* ---------- Transactions (history shows only your own deals; admins see all) ---------- */
app.get('/api/transactions', h(async (req, res) => {
  const admin = req.user.role === 'admin';
  res.json(await q(`
    SELECT t.txn_id, t.txn_date, t.price_paid, t.payment_mode, i.title, i.seller_id, t.buyer_id,
           s.name AS seller, b.name AS buyer, r.rating, r.comment
    FROM transactions t
    JOIN items i ON i.item_id = t.item_id
    JOIN users s ON s.user_id = i.seller_id
    JOIN users b ON b.user_id = t.buyer_id
    LEFT JOIN reviews r ON r.txn_id = t.txn_id
    ${admin ? '' : 'WHERE t.buyer_id = ? OR i.seller_id = ?'}
    ORDER BY t.txn_date DESC, t.txn_id DESC`, admin ? [] : [req.userId, req.userId]));
}));

app.post('/api/transactions', h(async (req, res) => {
  const { item_id, payment_mode } = req.body;
  if (!item_id || !payment_mode) throw new HttpError(400, 'item_id, payment_mode required');
  const mode = PAYMENT_MODES[String(payment_mode).trim().toLowerCase()];
  if (!mode) throw new HttpError(400, 'payment_mode must be Cash, UPI or Card');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT price, status, seller_id FROM items WHERE item_id = ? FOR UPDATE', [item_id]);
    if (!rows.length) throw new HttpError(404, 'Item does not exist');
    if (rows[0].status !== 'Available') throw new HttpError(409, 'Item is not available for sale');
    if (rows[0].seller_id === req.userId) throw new HttpError(400, 'Seller cannot buy their own item');
    const [r] = await conn.query('INSERT INTO transactions (item_id,buyer_id,price_paid,payment_mode) VALUES (?,?,?,?)',
                                 [item_id, req.userId, rows[0].price, mode]);
    await conn.commit();
    res.status(201).json({ txn_id: r.insertId });
  } catch (e) { await conn.rollback(); throw e; }
  finally { conn.release(); }
}));

/* ---------- Reviews ---------- */
app.post('/api/reviews', h(async (req, res) => {
  const { txn_id, rating, comment } = req.body, n = Number(rating);
  if (!txn_id || !Number.isInteger(n) || n < 1 || n > 5) throw new HttpError(400, 'txn_id and integer rating 1-5 required');
  const t = await q('SELECT buyer_id FROM transactions WHERE txn_id = ?', [txn_id]);
  if (!t.length) throw new HttpError(404, 'Transaction not found');
  if (t[0].buyer_id !== req.userId) throw new HttpError(403, 'Only the buyer can review this transaction');
  const r = await q('INSERT INTO reviews (txn_id,rating,comment) VALUES (?,?,?)', [txn_id, n, str(comment, 300) || null]);
  res.status(201).json({ review_id: r.insertId });
}));

/* ---------- Wishlist (always the logged-in user's own) ---------- */
app.get('/api/wishlist', h(async (req, res) =>
  res.json(await q('SELECT v.* FROM wishlist w JOIN v_item_details v ON v.item_id = w.item_id WHERE w.user_id = ? ORDER BY w.added_at DESC', [req.userId]))));
app.post('/api/wishlist', h(async (req, res) => {
  if (!req.body.item_id) throw new HttpError(400, 'item_id required');
  await q('INSERT IGNORE INTO wishlist (user_id,item_id) VALUES (?,?)', [req.userId, req.body.item_id]);
  res.status(201).json({ added: true });
}));
app.delete('/api/wishlist/:itemId', h(async (req, res) => {
  await q('DELETE FROM wishlist WHERE user_id = ? AND item_id = ?', [req.userId, req.params.itemId]);
  res.json({ removed: true });
}));

/* ---------- Messages (buyer <-> seller, per listing) ---------- */
app.get('/api/messages', h(async (req, res) => {
  res.json(await q(`
    SELECT m.message_id, m.item_id, i.title, m.sender_id, s.name AS sender, m.receiver_id, r.name AS receiver, m.body, m.created_at
    FROM messages m JOIN items i ON i.item_id = m.item_id
    JOIN users s ON s.user_id = m.sender_id JOIN users r ON r.user_id = m.receiver_id
    WHERE m.sender_id = ? OR m.receiver_id = ? ORDER BY m.message_id`, [req.userId, req.userId]));
}));

app.post('/api/messages', h(async (req, res) => {
  const { item_id, to_user_id } = req.body, body = str(req.body.body, 500);
  if (!item_id || !body) throw new HttpError(400, 'item_id and a message are required');
  const items = await q('SELECT seller_id FROM items WHERE item_id = ?', [item_id]);
  if (!items.length) throw new HttpError(404, 'Item not found');
  let to = items[0].seller_id;
  if (to === req.userId) { // seller replying: only to someone who already wrote about this item
    to = Number(to_user_id);
    const prior = await q('SELECT 1 FROM messages WHERE item_id = ? AND sender_id = ? AND receiver_id = ? LIMIT 1', [item_id, to, req.userId]);
    if (!prior.length) throw new HttpError(400, 'You can only reply to buyers who contacted you');
  }
  const r = await q('INSERT INTO messages (item_id,sender_id,receiver_id,body) VALUES (?,?,?,?)', [item_id, req.userId, to, body]);
  res.status(201).json({ message_id: r.insertId });
}));

/* ---------- Admin ---------- */
app.get('/api/admin/users', adminOnly, h(async (req, res) => res.json(await q(`
  SELECT u.user_id, u.name, u.email, u.roll_no, u.hostel, u.role, u.created_at,
         (SELECT COUNT(*) FROM items i WHERE i.seller_id = u.user_id) AS listings
  FROM users u ORDER BY u.user_id`))));

/* ---------- Dashboard stats ---------- */
app.get('/api/stats', h(async (req, res) => {
  const rows = await q(`SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM items WHERE status='Available') AS available_items,
      (SELECT COUNT(*) FROM transactions) AS transactions,
      (SELECT COALESCE(SUM(price_paid),0) FROM transactions) AS total_volume`);
  res.json(rows[0]);
}));

/* ---------- Reports: showcase SQL concepts ---------- */
const reports = {
  'seller-stats': {
    title: 'Seller leaderboard (VIEW + LEFT JOINs + GROUP BY + AVG)',
    sql: 'SELECT * FROM v_seller_stats ORDER BY revenue DESC, items_listed DESC'
  },
  'category-summary': {
    title: 'Category summary (GROUP BY + HAVING + aggregates)',
    sql: `SELECT c.name AS category, COUNT(i.item_id) AS total_items,
                 ROUND(AVG(i.price),2) AS avg_price, MIN(i.price) AS min_price, MAX(i.price) AS max_price
          FROM categories c JOIN items i ON i.category_id = c.category_id
          GROUP BY c.category_id, c.name HAVING COUNT(i.item_id) >= 1
          ORDER BY total_items DESC`
  },
  'above-average': {
    title: 'Items priced above their category average (correlated subquery)',
    sql: `SELECT i.title, c.name AS category, i.price
          FROM items i JOIN categories c ON c.category_id = i.category_id
          WHERE i.price > (SELECT AVG(price) FROM items WHERE category_id = i.category_id)
          ORDER BY i.price DESC`
  },
  'ranked-items': {
    title: 'Price rank within each category (window function RANK)',
    sql: `SELECT c.name AS category, i.title, i.price,
                 RANK() OVER (PARTITION BY c.category_id ORDER BY i.price DESC) AS price_rank
          FROM items i JOIN categories c ON c.category_id = i.category_id
          ORDER BY c.name, price_rank`
  },
  'no-sales': {
    title: 'Users who never sold anything (NOT EXISTS)',
    sql: `SELECT u.name, u.hostel FROM users u
          WHERE NOT EXISTS (SELECT 1 FROM items i JOIN transactions t ON t.item_id = i.item_id
                            WHERE i.seller_id = u.user_id)`
  },
  'payment-modes': {
    title: 'Revenue by payment mode (GROUP BY)',
    sql: `SELECT payment_mode, COUNT(*) AS txns, SUM(price_paid) AS revenue
          FROM transactions GROUP BY payment_mode ORDER BY revenue DESC`
  },
  'top-wishlisted': {
    title: 'Most wishlisted available items (JOIN + GROUP BY)',
    sql: `SELECT i.title, i.price, COUNT(w.user_id) AS wishlisted_by
          FROM wishlist w JOIN items i ON i.item_id = w.item_id
          GROUP BY i.item_id, i.title, i.price ORDER BY wishlisted_by DESC, i.title`
  }
};
const cleanTitle = x => x.replace(/\s*\(.*\)\s*$/, '');   // hide technique notes like "(GROUP BY + HAVING)"
app.get('/api/reports', adminOnly, h(async (req, res) =>
  res.json(Object.entries(reports).map(([key, r]) => ({ key, title: cleanTitle(r.title) })))));
app.get('/api/reports/:key', adminOnly, h(async (req, res) => {
  const r = reports[req.params.key];
  if (!r) throw new HttpError(404, 'Unknown report');
  res.json({ title: cleanTitle(r.title), rows: await q(r.sql) });
}));

// Unknown API routes -> JSON 404
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Malformed JSON bodies -> clean 400 instead of an HTML stack trace
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`UniOlx running at http://localhost:${PORT}`));
