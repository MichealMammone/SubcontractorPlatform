// Central configuration. Every value comes from environment variables (see .env.example).
import fs from 'node:fs';

// Local development convenience: load .env when present (Render sets real environment variables instead).
if (fs.existsSync('.env') && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile('.env'); } catch (err) { console.warn('config: could not read .env:', err.message); }
}

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

const env = process.env;

export const config = Object.freeze({
  env: env.NODE_ENV || 'development',
  isProd: (env.NODE_ENV || '') === 'production',
  port: int(env.PORT, 3000),
  baseUrl: (env.APP_BASE_URL || '').replace(/\/+$/, ''),

  databaseUrl: env.DATABASE_URL || '',
  databaseSsl: bool(env.DATABASE_SSL, false),
  dbPoolMax: int(env.DB_POOL_MAX, 8),

  sessionIdleMinutes: int(env.SESSION_IDLE_MINUTES, 60),
  sessionMaxHours: int(env.SESSION_MAX_HOURS, 12),
  loginMaxFailures: int(env.LOGIN_MAX_FAILURES, 5),
  loginLockMinutes: int(env.LOGIN_LOCK_MINUTES, 15),
  resetTokenHours: int(env.RESET_TOKEN_HOURS, 24),

  maxUploadBytes: int(env.MAX_UPLOAD_MB, 50) * 1024 * 1024,

  smtp: {
    host: env.SMTP_HOST || '',
    port: int(env.SMTP_PORT, 587),
    user: env.SMTP_USER || '',
    password: env.SMTP_PASSWORD || '',
    from: env.SMTP_FROM || 'Scale Point Group <no-reply@example.com>'
  },

  seed: {
    orgName: env.SEED_ORG_NAME || 'Scale Point Group',
    adminEmail: env.SEED_ADMIN_EMAIL || '',
    adminPassword: env.SEED_ADMIN_PASSWORD || '',
    demoUsers: bool(env.SEED_DEMO_USERS, false),
    demoPassword: env.SEED_DEMO_PASSWORD || '',
    demoDomain: env.SEED_DEMO_DOMAIN || 'demo.spg.local'
  }
});
