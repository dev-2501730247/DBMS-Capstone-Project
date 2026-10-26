// Runs schema.sql + seed.sql against MySQL (handles DELIMITER blocks for triggers)
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const cfg = require('./config');

function splitSql(text) {
  const out = []; let delim = ';'; let buf = '';
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*DELIMITER\s+(\S+)/i);
    if (m) { delim = m[1]; continue; }
    if (/^\s*--/.test(line) && !buf.trim()) continue;
    buf += line + '\n';
    if (buf.trimEnd().endsWith(delim)) {
      out.push(buf.trimEnd().slice(0, -delim.length).trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

(async () => {
  const conn = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password });
  for (const f of ['schema.sql', 'seed.sql']) {
    for (const stmt of splitSql(fs.readFileSync(path.join(__dirname, f), 'utf8'))) await conn.query(stmt);
  }
  const [[r]] = await conn.query('SELECT COUNT(*) AS c FROM campus_marketplace.items');
  console.log(`Database "campus_marketplace" ready (${r.c} items seeded)`);
  await conn.end();
})().catch(e => { console.error('Setup failed:', e.message); process.exit(1); });
