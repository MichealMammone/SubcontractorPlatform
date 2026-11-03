// Login, logout, current user, password change / forgot / reset, own sessions.
import { Router } from 'express';
import { query, one } from '../db.js';
import { config } from '../config.js';
import { ah, str, badRequest, HttpError, clientIp, notFound } from '../lib/http.js';
import { verifyPassword, burnPasswordCheck, hashPassword, passwordProblems, randomToken, sha256 } from '../lib/security.js';
import { createSession, destroySession, requireAuth, rateLimit } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { sendMail, mailEnabled, resetLink } from '../services/mailer.js';

const router = Router();
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, key: (req) => 'auth:' + clientIp(req) });

export function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, role: u.roleKey, roleName: u.roleName, level: u.level,
    organisation: { id: u.orgId, name: u.orgName }, permissions: [...u.permissions].sort(), mustChangePassword: u.mustChangePassword
  };
}

router.post('/login', authLimiter, ah(async (req, res) => {
  const email = str(req.body.email, { max: 254, required: true, name: 'Email' }).toLowerCase();
  const password = String(req.body.password || '');
  if (!password) throw badRequest('Password is required.');
  const u = await one(
    `SELECT u.*, o.status AS org_status FROM users u JOIN organisations o ON o.id = u.organisation_id
      WHERE lower(u.email) = $1 AND u.deleted_at IS NULL`, [email]);
  const fail = async (reason, user) => {
    await audit(req, 'auth.login_failed', { orgId: user ? user.organisation_id : null, email, entityType: 'user', entityId: user ? user.id : '', summary: 'Failed login: ' + reason, actor: null });
    throw new HttpError(401, 'Email or password is incorrect, or the account is locked or disabled.');
  };
  if (!u) { await burnPasswordCheck(password); return fail('unknown email'); }
  if (u.locked_until && new Date(u.locked_until) > new Date()) { await burnPasswordCheck(password); return fail('account locked', u); }
  const ok = await verifyPassword(password, u.password_hash);
  if (!ok) {
    const n = u.failed_login_count + 1;
    const lock = n >= config.loginMaxFailures;
    await query(`UPDATE users SET failed_login_count = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id = $1`,
      [u.id, lock ? 0 : n, lock, config.loginLockMinutes]);
    if (lock) await audit(req, 'auth.account_locked', { orgId: u.organisation_id, email, entityType: 'user', entityId: u.id, summary: `Locked for ${config.loginLockMinutes} minutes after ${n} failed attempts`, actor: null });
    return fail('wrong password', u);
  }
  if (u.status !== 'active' || u.org_status !== 'active') return fail('account disabled', u);

  await query('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now(), last_login_ip = $2 WHERE id = $1', [u.id, clientIp(req)]);
  const csrfToken = await createSession(req, res, u);
  await audit(req, 'auth.login', { actor: { id: u.id, orgId: u.organisation_id, email: u.email }, entityType: 'user', entityId: u.id, summary: 'Signed in' });
  res.json({ ok: true, csrfToken, mustChangePassword: u.must_change_password });
}));

router.post('/logout', requireAuth, ah(async (req, res) => {
  await audit(req, 'auth.logout', { entityType: 'user', entityId: req.user.id, summary: 'Signed out' });
  await destroySession(req, res);
  res.json({ ok: true });
}));

router.get('/me', ah(async (req, res) => {
  if (!req.user) throw new HttpError(401, 'Please sign in.');
  res.json({ user: publicUser(req.user), csrfToken: req.session.csrf, mailEnabled: mailEnabled() });
}));

router.post('/password/change', requireAuth, ah(async (req, res) => {
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  const u = await one('SELECT id, email, password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await verifyPassword(current, u.password_hash))) throw badRequest('Your current password is incorrect.');
  const problems = passwordProblems(next, u.email);
  if (problems.length) throw badRequest('The new password needs ' + problems.join('; ') + '.');
  if (current === next) throw badRequest('Choose a password different from the current one.');
  await query('UPDATE users SET password_hash = $2, must_change_password = false, password_changed_at = now(), updated_at = now() WHERE id = $1', [u.id, await hashPassword(next)]);
  await query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [u.id, req.session.id]); // sign out other devices
  await audit(req, 'auth.password_changed', { entityType: 'user', entityId: u.id, summary: 'Changed own password' });
  res.json({ ok: true });
}));

// Always answers the same way, so it cannot be used to discover which emails have accounts.
router.post('/password/forgot', authLimiter, ah(async (req, res) => {
  const email = str(req.body.email, { max: 254, required: true, name: 'Email' }).toLowerCase();
  const u = await one(`SELECT id, organisation_id, email, name FROM users WHERE lower(email) = $1 AND deleted_at IS NULL AND status = 'active'`, [email]);
  if (u && mailEnabled()) {
    const token = randomToken(32);
    await query(`INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [sha256(token), u.id]);
    await sendMail({
      to: u.email,
      subject: 'Reset your Scale Point Group password',
      text: `Hello ${u.name},\n\nUse this link within 1 hour to choose a new password:\n${resetLink(token)}\n\nIf you did not ask for this, ignore this email.\n\nScale Point Group`
    });
    await audit(req, 'auth.password_reset_requested', { orgId: u.organisation_id, email, entityType: 'user', entityId: u.id, summary: 'Reset email sent', actor: null });
  }
  res.json({ ok: true, message: mailEnabled() ? 'If the address has an account, a reset link has been emailed.' : 'Ask your administrator for a password reset link.' });
}));

router.post('/password/reset', authLimiter, ah(async (req, res) => {
  const token = String(req.body.token || '');
  const next = String(req.body.newPassword || '');
  const row = token && await one(
    `SELECT t.token_hash, u.id, u.email, u.organisation_id FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now() AND u.deleted_at IS NULL`, [sha256(token)]);
  if (!row) throw badRequest('This reset link is invalid or has expired. Ask for a new one.');
  const problems = passwordProblems(next, row.email);
  if (problems.length) throw badRequest('The new password needs ' + problems.join('; ') + '.');
  await query('UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1', [row.token_hash]);
  await query(`UPDATE users SET password_hash = $2, must_change_password = false, password_changed_at = now(), failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
    [row.id, await hashPassword(next)]);
  await query('DELETE FROM sessions WHERE user_id = $1', [row.id]);
  await audit(req, 'auth.password_reset', { orgId: row.organisation_id, email: row.email, entityType: 'user', entityId: row.id, summary: 'Password reset with link', actor: null });
  res.json({ ok: true });
}));

router.get('/sessions', requireAuth, ah(async (req, res) => {
  const r = await query('SELECT id, ip, user_agent, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = $1 ORDER BY last_seen_at DESC', [req.user.id]);
  res.json({ sessions: r.rows.map((s) => ({ id: s.id.slice(0, 16), current: s.id === req.session.id, ip: s.ip, userAgent: s.user_agent, createdAt: s.created_at, lastSeenAt: s.last_seen_at })) });
}));

router.delete('/sessions/:id', requireAuth, ah(async (req, res) => {
  const r = await query('DELETE FROM sessions WHERE user_id = $1 AND left(id, 16) = $2 AND id <> $3', [req.user.id, String(req.params.id), req.session.id]);
  if (!r.rowCount) throw notFound('Session');
  await audit(req, 'auth.session_revoked', { entityType: 'user', entityId: req.user.id, summary: 'Signed out another device' });
  res.json({ ok: true });
}));

export default router;
