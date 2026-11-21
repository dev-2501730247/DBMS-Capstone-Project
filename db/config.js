
module.exports = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 4000,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '1234',
  database: process.env.DB_NAME || 'campus_marketplace',

  // Required for TiDB Cloud secure connections
  ssl: {
    minVersion: 'TLSv1.2'
  }
};
