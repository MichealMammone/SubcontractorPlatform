// User management (Admin panel). Users can only manage accounts with a lower role level than their own.
import { Router } from 'express';
import { query, one } from '../db.js';
import { ah, str, badRequest, forbidden, notFound, conflict, uuidParam, paging, likeTerm } from '../lib/http.js';
import { hashPassword, passwordProblems, temporaryPassword, randomToken, sha256 } from '../lib/security.js';
import { requirePerm } from '../middleware/auth.js';
import { audit, diffFields } from '../services/audit.js';
import { listRoles, roleById } from '../services/rbac.js';
import { sendMail, mailEnabled, resetLink } from '../services/mailer.js';
import { config } from '../config.js';

const router = Router();

const USER_COLS = `u.id, u.email, u.name, u.status, u.role_id, r.key AS role, r.name AS role_name, r.level, u.must_change_password,
  u.last_login_at, u.last_login_ip, u.created_at, u.updated_at, (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked`;

async function loadTarget(req, id) {
  const t = await one(`SELECT ${USER_COLS} FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND u.organisation_id = $2 AND u.deleted_at IS NULL`, [uuidParam(id, 'User'), req.user.orgId]);
  if (!t) throw notFound('User');
  return t;
}
function assertCanManage(req, target) {
  if (target.id === req.user.id) throw badRequest('Use your profile page to change your own account.');
  if (req.user.roleKey === 'super_admin') return; // Super Admins manage all users, including other Super Admins
  if (target.level >= req.user.level) throw forbidden('You can only manage users with a lower role than your own.');
}
async function assertAssignableRole(req, roleId) {
  const role = await roleById(Number(roleId));
  if (!role) throw badRequest('Choose a valid role.');
  if (role.level >= req.user.level && req.user.roleKey !== 'super_admin') throw forbidden('You can only assign roles below your own.');
  return role;
}

router.get('/roles', requirePerm('users.view'), ah(async (req, res) => {
  res.json({ roles: await listRoles() });
}));

router.get('/metrics', requirePerm('users.view'), ah(async (req, res) => {
  const org = req.user.orgId;
  const m = await one(`
    SELECT
      (SELECT count(*) FROM users WHERE organisation_id = $1 AND deleted_at IS NULL)::int AS total_users,
      (SELECT count(*) FROM users WHERE organisation_id = $1 AND deleted_at IS NULL AND status = 'active')::int AS active_users,
      (SELECT count(*) FROM users WHERE organisation_id = $1 AND deleted_at IS NULL AND last_login_at > now() - interval '30 days')::int AS active_30d,
      (SELECT count(DISTINCT user_id) FROM sessions WHERE organisation_id = $1 AND expires_at > now())::int AS signed_in_now,
      (SELECT count(*) FROM generated_reports WHERE organisation_id = $1)::int AS reports_generated,
      (SELECT count(*) FROM inspection_reports WHERE organisation_id = $1)::int AS reports_uploaded,
      (SELECT coalesce(sum(v.asset_count), 0) FROM asset_registers g JOIN register_versions v ON v.id = g.active_version_id WHERE g.organisation_id = $1)::int AS total_assets,
      (SELECT count(*) FROM register_versions WHERE organisation_id = $1 AND status IN ('active', 'archived'))::int AS register_versions,
      (SELECT max(last_login_at) FROM users WHERE organisation_id = $1 AND deleted_at IS NULL) AS last_login_at`, [org]);
  const recent = await query(`SELECT u.name, u.email, r.name AS role_name, u.last_login_at FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.organisation_id = $1 AND u.deleted_at IS NULL AND u.last_login_at IS NOT NULL ORDER BY u.last_login_at DESC LIMIT 10`, [org]);
  res.json({ metrics: m, recentLogins: recent.rows });
}));

router.get('/', requirePerm('users.view'), ah(async (req, res) => {
  const { limit, offset, page, pageSize } = paging(req.query, 50);
  const params = [req.user.orgId];
  let where = 'u.organisation_id = $1 AND u.deleted_at IS NULL';
  if (req.query.q) { params.push(likeTerm(req.query.q)); where += ` AND (u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`; }
  if (req.query.role) { params.push(String(req.query.role)); where += ` AND r.key = $${params.length}`; }
  if (req.query.status) { params.push(String(req.query.status)); where += ` AND u.status = $${params.length}`; }
  const total = (await one(`SELECT count(*)::int AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE ${where}`, params)).n;
  params.push(limit, offset);
  const r = await query(`SELECT ${USER_COLS} FROM users u JOIN roles r ON r.id = u.role_id WHERE ${where} ORDER BY r.level DESC, u.name LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ users: r.rows, total, page, pageSize });
}));

router.get('/:id', requirePerm('users.view'), ah(async (req, res) => {
  const u = await loadTarget(req, req.params.id);
  const activity = await query(`SELECT action, summary, created_at, ip FROM audit_logs WHERE organisation_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 25`, [req.user.orgId, u.id]);
  res.json({ user: u, activity: activity.rows });
}));

router.post('/', requirePerm('users.manage'), ah(async (req, res) => {
  const email = str(req.body.email, { max: 254, required: true, name: 'Email' }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('Enter a valid email address.');
  const name = str(req.body.name, { max: 120, required: true, name: 'Name' });
  const role = await assertAssignableRole(req, req.body.roleId);
  let password = String(req.body.password || '');
  let generated = false;
  if (!password) { password = temporaryPassword(); generated = true; }
  const problems = passwordProblems(password, email);
  if (problems.length) throw badRequest('The password needs ' + problems.join('; ') + '.');
  if (await one('SELECT 1 FROM users WHERE lower(email) = $1 AND deleted_at IS NULL', [email])) throw conflict('A user with that email already exists.');
  const u = await one(
    `INSERT INTO users (organisation_id, email, name, password_hash, role_id, must_change_password, created_by, password_changed_at)
     VALUES ($1, $2, $3, $4, $5, true, $6, now()) RETURNING id`,
    [req.user.orgId, email, name, await hashPassword(password), role.id, req.user.id]);
  await audit(req, 'user.create', { entityType: 'user', entityId: u.id, summary: `Created ${email} as ${role.name}`, details: { email, name, role: role.key } });
  res.status(201).json({ id: u.id, temporaryPassword: generated ? password : undefined });
}));

router.patch('/:id', requirePerm('users.manage'), ah(async (req, res) => {
  const t = await loadTarget(req, req.params.id);
  assertCanManage(req, t);
  const next = {
    name: req.body.name != null ? str(req.body.name, { max: 120, required: true, name: 'Name' }) : t.name,
    email: req.body.email != null ? str(req.body.email, { max: 254, required: true, name: 'Email' }).toLowerCase() : t.email,
    role_id: req.body.roleId != null ? (await assertAssignableRole(req, req.body.roleId)).id : t.role_id
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) throw badRequest('Enter a valid email address.');
  if (next.email !== t.email && await one('SELECT 1 FROM users WHERE lower(email) = $1 AND deleted_at IS NULL AND id <> $2', [next.email, t.id])) throw conflict('A user with that email already exists.');
  await query('UPDATE users SET name = $2, email = $3, role_id = $4, updated_at = now() WHERE id = $1', [t.id, next.name, next.email, next.role_id]);
  if (next.role_id !== t.role_id) await query('DELETE FROM sessions WHERE user_id = $1', [t.id]); // new permissions apply at next sign-in
  const changes = diffFields({ name: t.name, email: t.email, role_id: t.role_id }, next);
  await audit(req, next.role_id !== t.role_id ? 'user.role_change' : 'user.update', { entityType: 'user', entityId: t.id, summary: `Updated ${t.email}`, details: { changes } });
  res.json({ ok: true });
}));

async function setStatus(req, res, status) {
  const t = await loadTarget(req, req.params.id);
  assertCanManage(req, t);
  await query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [t.id, status]);
  if (status === 'disabled') await query('DELETE FROM sessions WHERE user_id = $1', [t.id]);
  await audit(req, status === 'disabled' ? 'user.disable' : 'user.enable', { entityType: 'user', entityId: t.id, summary: `${status === 'disabled' ? 'Disabled' : 'Enabled'} ${t.email}` });
  res.json({ ok: true });
}
router.post('/:id/disable', requirePerm('users.manage'), ah((req, res) => setStatus(req, res, 'disabled')));
router.post('/:id/enable', requirePerm('users.manage'), ah((req, res) => setStatus(req, res, 'active')));

router.post('/:id/unlock', requirePerm('users.manage'), ah(async (req, res) => {
  const t = await loadTarget(req, req.params.id);
  assertCanManage(req, t);
  await query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [t.id]);
  await audit(req, 'user.unlock', { entityType: 'user', entityId: t.id, summary: `Unlocked ${t.email}` });
  res.json({ ok: true });
}));

// Issues a one-time reset link (emailed when SMTP is configured, and shown once to the admin).
router.post('/:id/reset-password', requirePerm('users.manage'), ah(async (req, res) => {
  const t = await loadTarget(req, req.params.id);
  assertCanManage(req, t);
  const token = randomToken(32);
  await query('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [t.id]);
  await query(`INSERT INTO password_reset_tokens (token_hash, user_id, created_by, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [sha256(token), t.id, req.user.id, config.resetTokenHours]);
  const link = resetLink(token);
  const emailed = mailEnabled() && await sendMail({ to: t.email, subject: 'Set your Scale Point Group password', text: `Hello ${t.name},\n\nAn administrator has issued a password reset. Use this link within ${config.resetTokenHours} hours:\n${link}\n\nScale Point Group` });
  await audit(req, 'user.password_reset_issued', { entityType: 'user', entityId: t.id, summary: `Issued a password reset link for ${t.email}${emailed ? ' (emailed)' : ''}` });
  res.json({ ok: true, link, emailed: !!emailed, expiresHours: config.resetTokenHours });
}));

// Soft delete: the account can no longer sign in and its email is freed; audit history is kept.
router.delete('/:id', requirePerm('users.delete'), ah(async (req, res) => {
  const t = await loadTarget(req, req.params.id);
  assertCanManage(req, t);
  await query(`UPDATE users SET deleted_at = now(), status = 'disabled', email = 'deleted-' || id || '@deleted.invalid', updated_at = now() WHERE id = $1`, [t.id]);
  await query('DELETE FROM sessions WHERE user_id = $1', [t.id]);
  await audit(req, 'user.delete', { entityType: 'user', entityId: t.id, summary: `Deleted ${t.email}`, details: { email: t.email, name: t.name } });
  res.json({ ok: true });
}));

export default router;
