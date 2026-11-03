// Server-side sessions, CSRF protection, route protection and login rate limiting.
import { query, one } from '../db.js';
import { config } from '../config.js';
import { randomToken, sha256 } from '../lib/security.js';
import { HttpError, clientIp, forbidden } from '../lib/http.js';
import { roleById } from '../services/rbac.js';

export const COOKIE = config.isProd ? '__Host-spg_sid' : 'spg_sid';

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setCookie(res, value, maxAgeSeconds) {
  const attrs = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (config.isProd) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

export async function createSession(req, res, user) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const maxAge = config.sessionMaxHours * 3600;
  await query(
    `INSERT INTO sessions (id, user_id, organisation_id, csrf_token, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
    [sha256(token), user.id, user.organisation_id, csrf, clientIp(req), String(req.get('user-agent') || '').slice(0, 300), maxAge]
  );
  setCookie(res, token, maxAge);
  return csrf;
}

export async function destroySession(req, res) {
  if (req.session) await query('DELETE FROM sessions WHERE id = $1', [req.session.id]);
  setCookie(res, '', 0);
}

// Loads req.user / req.session when a valid session cookie is present. Never rejects by itself.
export async function loadSession(req, res, next) {
  try {
    const token = readCookie(req, COOKIE);
    if (!token) return next();
    const id = sha256(token);
    const row = await one(
      `SELECT s.id AS sid, s.csrf_token, s.last_seen_at, s.expires_at,
              u.id, u.organisation_id, u.email, u.name, u.role_id, u.status, u.must_change_password,
              o.name AS org_name, o.status AS org_status
         FROM sessions s
         JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
         JOIN organisations o ON o.id = u.organisation_id
        WHERE s.id = $1 AND s.expires_at > now()`,
      [id]
    );
    const idleMs = config.sessionIdleMinutes * 60 * 1000;
    if (!row || row.status !== 'active' || row.org_status !== 'active' || Date.now() - new Date(row.last_seen_at).getTime() > idleMs) {
      if (row) await query('DELETE FROM sessions WHERE id = $1', [id]);
      setCookie(res, '', 0);
      return next();
    }
    const role = await roleById(row.role_id);
    req.session = { id, csrf: row.csrf_token };
    req.user = {
      id: row.id, orgId: row.organisation_id, orgName: row.org_name, email: row.email, name: row.name,
      roleId: row.role_id, roleKey: role ? role.key : '', roleName: role ? role.name : '', level: role ? role.level : 0,
      permissions: role ? role.permissions : new Set(), mustChangePassword: row.must_change_password
    };
    // Sliding idle timeout, written at most once a minute to keep database traffic low.
    if (Date.now() - new Date(row.last_seen_at).getTime() > 60 * 1000) {
      query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [id]).catch(() => {});
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in.'));
  // Until a required password change is done, only the password and session endpoints are usable.
  if (req.user.mustChangePassword && !/^\/api\/auth\/(me|logout|password\/change)$/.test(req.originalUrl.split('?')[0])) {
    return next(new HttpError(403, 'You must change your password before continuing.', { code: 'password_change_required' }));
  }
  next();
}

export const requirePerm = (...perms) => (req, res, next) => {
  if (!req.user) return next(new HttpError(401, 'Please sign in.'));
  if (!perms.every((p) => req.user.permissions.has(p))) return next(forbidden());
  next();
};

// State-changing requests must carry the session's CSRF token (double defence with SameSite cookies).
export function csrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.session) return next(); // unauthenticated endpoints (login, forgot, reset) are rate limited instead
  const sent = req.get('x-csrf-token');
  if (!sent || sent !== req.session.csrf) return next(new HttpError(403, 'Your session token is out of date. Refresh the page and try again.'));
  next();
}

// Small in-memory sliding-window limiter (per instance). Account lockout in the database is the durable control.
export function rateLimit({ windowMs, max, key }) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, arr] of hits) { const kept = arr.filter((t) => t > cutoff); if (kept.length) hits.set(k, kept); else hits.delete(k); }
  }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => t > now - windowMs);
    arr.push(now);
    hits.set(k, arr);
    if (arr.length > max) return next(new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.'));
    next();
  };
}

export async function purgeExpiredSessions() {
  await query('DELETE FROM sessions WHERE expires_at < now() OR last_seen_at < now() - make_interval(mins => $1)', [config.sessionIdleMinutes]);
  await query('DELETE FROM password_reset_tokens WHERE expires_at < now() - interval \'7 days\'');
}
