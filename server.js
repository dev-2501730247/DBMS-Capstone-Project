const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');
const cfg = require('./db/config');

const pool = mysql.createPool({ ...cfg, decimalNumbers: true, dateStrings: true, connectionLimit: 10 });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Async wrapper: DB errors (CHECK, UNIQUE, FK, trigger SIGNAL) become clean JSON
const h = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    console.error(e.code || '', e.sqlMessage || e.message);
    const userErr = e.sqlState === '45000' || /^ER_(DUP_ENTRY|CHECK|NO_REFERENCED|BAD_NULL|DATA_TOO_LONG|TRUNCATED|WARN_DATA)/.test(e.code || '') || /CONSTRAINT/.test(e.code || '');
    let msg = e.sqlMessage || e.message;
    if (e.code === 'ER_NO_REFERENCED_ROW_2') msg = 'Referenced user/item/category does not exist';
    res.status(userErr ? 400 : 500).json({ error: msg });
  }
};
const q = async (sql, p = []) => (await pool.query(sql, p))[0];

/* ---------- Users ---------- */
app.get('/api/users', h(async (req, res) => res.json(await q('SELECT * FROM users ORDER BY name'))));

app.post('/api/users', h(async (req, res) => {
  const { name, email, roll_no, phone, hostel } = req.body;
  if (!name || !email || !roll_no) return res.status(400).json({ error: 'name, email, roll_no required' });
  const r = await q('INSERT INTO users (name,email,roll_no,phone,hostel) VALUES (?,?,?,?,?)',
                    [name, email, roll_no, phone || null, hostel || null]);
  res.status(201).json({ user_id: r.insertId });
}));

/* ---------- Categories ---------- */
app.get('/api/categories', h(async (req, res) => res.json(await q('SELECT * FROM categories ORDER BY name'))));

/* ---------- Items (CRUD) ---------- */
app.get('/api/items', h(async (req, res) => {
  const { q: search, category, maxPrice, status = 'Available', seller } = req.query;
  let sql = 'SELECT * FROM v_item_details WHERE 1=1';
  const p = [];
  if (status !== 'All') { sql += ' AND status = ?'; p.push(status); }
  if (search)   { sql += ' AND (title LIKE ? OR description LIKE ?)'; p.push(`%${search}%`, `%${search}%`); }
  if (category) { sql += ' AND category_id = ?'; p.push(category); }
  if (maxPrice) { sql += ' AND price <= ?'; p.push(maxPrice); }
  if (seller)   { sql += ' AND seller_id = ?'; p.push(seller); }
  sql += ' ORDER BY listed_at DESC, item_id DESC';
  res.json(await q(sql, p));
}));

app.get('/api/items/:id', h(async (req, res) => {
  const rows = await q('SELECT * FROM v_item_details WHERE item_id = ?', [req.params.id]);
  rows.length ? res.json(rows[0]) : res.status(404).json({ error: 'Item not found' });
}));

app.post('/api/items', h(async (req, res) => {
  const { seller_id, category_id, title, description, price, condition } = req.body;
  if (!seller_id || !category_id || !title || price === undefined)
    return res.status(400).json({ error: 'seller_id, category_id, title, price required' });
  const r = await q('INSERT INTO items (seller_id,category_id,title,description,price,`condition`) VALUES (?,?,?,?,?,?)',
                    [seller_id, category_id, title, description || null, price, condition || 'Good']);
  res.status(201).json({ item_id: r.insertId });
}));

app.put('/api/items/:id', h(async (req, res) => {
  const { title, description, price, condition, category_id } = req.body;
  const r = await q(`UPDATE items SET
      title = COALESCE(?, title), description = COALESCE(?, description),
      price = COALESCE(?, price), \`condition\` = COALESCE(?, \`condition\`),
      category_id = COALESCE(?, category_id)
      WHERE item_id = ? AND status = 'Available'`,
    [title ?? null, description ?? null, price ?? null, condition ?? null, category_id ?? null, req.params.id]);
  r.affectedRows ? res.json({ updated: true }) : res.status(404).json({ error: 'Item not found or already sold' });
}));

app.delete('/api/items/:id', h(async (req, res) => {
  const r = await q("UPDATE items SET status='Removed' WHERE item_id = ? AND status='Available'", [req.params.id]);
  r.affectedRows ? res.json({ removed: true }) : res.status(404).json({ error: 'Item not found or already sold' });
}));

/* ---------- Transactions ---------- */
app.get('/api/transactions', h(async (req, res) => {
  res.json(await q(`
    SELECT t.txn_id, t.txn_date, t.price_paid, t.payment_mode,
           i.title, s.name AS seller, b.name AS buyer, r.rating, r.comment
    FROM transactions t
    JOIN items i ON i.item_id = t.item_id
    JOIN users s ON s.user_id = i.seller_id
    JOIN users b ON b.user_id = t.buyer_id
    LEFT JOIN reviews r ON r.txn_id = t.txn_id
    ORDER BY t.txn_date DESC`));
}));

app.post('/api/transactions', h(async (req, res) => {
  const { item_id, buyer_id, payment_mode } = req.body;
  if (!item_id || !buyer_id || !payment_mode)
    return res.status(400).json({ error: 'item_id, buyer_id, payment_mode required' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // lock the row so two buyers cannot grab the same item at once
    const [rows] = await conn.query('SELECT price FROM items WHERE item_id = ? FOR UPDATE', [item_id]);
    if (!rows.length) { await conn.rollback(); return res.status(400).json({ error: 'Item does not exist' }); }
    const [r] = await conn.query('INSERT INTO transactions (item_id,buyer_id,price_paid,payment_mode) VALUES (?,?,?,?)',
                                 [item_id, buyer_id, rows[0].price, payment_mode]); // triggers validate + mark sold
    await conn.commit();
    res.status(201).json({ txn_id: r.insertId });
  } catch (e) { await conn.rollback(); throw e; }
  finally { conn.release(); }
}));

/* ---------- Reviews ---------- */
app.post('/api/reviews', h(async (req, res) => {
  const { txn_id, rating, comment } = req.body;
  const r = await q('INSERT INTO reviews (txn_id,rating,comment) VALUES (?,?,?)', [txn_id, rating, comment || null]);
  res.status(201).json({ review_id: r.insertId });
}));

/* ---------- Wishlist ---------- */
app.get('/api/wishlist/:userId', h(async (req, res) =>
  res.json(await q(`SELECT v.* FROM wishlist w JOIN v_item_details v ON v.item_id = w.item_id WHERE w.user_id = ?`,
                   [req.params.userId]))));
app.post('/api/wishlist', h(async (req, res) => {
  await q('INSERT IGNORE INTO wishlist (user_id,item_id) VALUES (?,?)', [req.body.user_id, req.body.item_id]);
  res.status(201).json({ added: true });
}));

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
app.get('/api/reports', h(async (req, res) =>
  res.json(Object.entries(reports).map(([key, r]) => ({ key, title: r.title })))));
app.get('/api/reports/:key', h(async (req, res) => {
  const r = reports[req.params.key];
  if (!r) return res.status(404).json({ error: 'Unknown report' });
  res.json({ title: r.title, sql: r.sql.replace(/\s+/g, ' ').trim(), rows: await q(r.sql) });
}));

/* ---------- Schema viewer (SHOW CREATE ...) ---------- */
app.get('/api/schema', h(async (req, res) => {
  const out = [];
  const tables = await q("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
  for (const t of tables) {
    const name = Object.values(t)[0];
    const [row] = await q(`SHOW CREATE TABLE \`${name}\``);
    out.push({ type: 'table', name, sql: row['Create Table'] });
  }
  const views = await q("SHOW FULL TABLES WHERE Table_type = 'VIEW'");
  for (const v of views) {
    const name = Object.values(v)[0];
    const [row] = await q(`SHOW CREATE VIEW \`${name}\``);
    out.push({ type: 'view', name, sql: row['Create View'] });
  }
  const trg = await q('SHOW TRIGGERS');
  for (const t of trg) {
    const [row] = await q(`SHOW CREATE TRIGGER \`${t.Trigger}\``);
    out.push({ type: 'trigger', name: t.Trigger, sql: row['SQL Original Statement'] });
  }
  res.json(out);
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Campus Marketplace running at http://localhost:${PORT}`));
