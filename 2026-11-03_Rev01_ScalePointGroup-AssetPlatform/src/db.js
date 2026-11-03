// PostgreSQL pool and helpers. Keep the pool small: Render's smallest databases allow ~100 connections in total.
import pg from 'pg';
import { config } from './config.js';

if (!config.databaseUrl) {
  console.error('DATABASE_URL is not set. See .env.example.');
  process.exit(1);
}

// Return DATE columns as 'YYYY-MM-DD' strings instead of local-midnight Date objects.
pg.types.setTypeParser(1082, (v) => v);
// bigint ids fit comfortably in JS numbers for this application.
pg.types.setTypeParser(20, (v) => (v == null ? v : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
  max: config.dbPoolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 60000
});

pool.on('error', (err) => console.error('db: idle client error:', err.message));

export const query = (text, params) => pool.query(text, params);

export async function one(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

// Runs fn(client) inside BEGIN/COMMIT, rolling back on any error.
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
