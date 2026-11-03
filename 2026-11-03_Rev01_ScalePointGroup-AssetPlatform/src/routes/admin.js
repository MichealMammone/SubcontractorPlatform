// Audit log viewer/export, settings, analytics, role-aware dashboard and global search.
import { Router } from 'express';
import { query, one } from '../db.js';
import { ah, paging, likeTerm, isoDate, uuidParam, badRequest, todayISO } from '../lib/http.js';
import { requirePerm, requireAuth } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { getSettings, saveSetting, SETTING_DEFAULTS } from '../services/settings.js';
import { can } from '../services/rbac.js';
import { csvLine } from '../services/exports.js';

const router = Router();

/* ---------- audit ---------- */
function auditFilter(req) {
  const params = [req.user.orgId];
  let where = 'l.organisation_id = $1';
  const add = (v, sql) => { params.push(v); where += ' AND ' + sql.replace('?', '$' + params.length); };
  if (req.query.q) add(likeTerm(req.query.q), `(l.summary || ' ' || l.user_email || ' ' || l.action) ILIKE ?`);
  if (req.query.action) add(String(req.query.action) + '%', 'l.action LIKE ?');
  if (req.query.user) add(uuidParam(req.query.user, 'User'), 'l.user_id = ?');
  if (req.query.from) add(isoDate(req.query.from, 'From'), 'l.created_at >= ?::date');
  if (req.query.to) add(isoDate(req.query.to, 'To'), 'l.created_at < ?::date + 1');
  if (req.query.entity) add(String(req.query.entity), 'l.entity_type = ?');
  return { where, params };
}

router.get('/audit', requirePerm('audit.view'), ah(async (req, res) => {
  const { limit, offset, page, pageSize } = paging(req.query, 50, 200);
  const { where, params } = auditFilter(req);
  const total = (await one(`SELECT count(*)::int AS n FROM audit_logs l WHERE ${where}`, params)).n;
  params.push(limit, offset);
  const r = await query(`SELECT l.id, l.action, l.entity_type, l.entity_id, l.summary, l.details, l.user_email, u.name AS user_name, l.ip, l.created_at
    FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id WHERE ${where} ORDER BY l.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const actions = await query(`SELECT DISTINCT split_part(action, '.', 1) AS a FROM audit_logs WHERE organisation_id = $1 ORDER BY 1`, [req.user.orgId]);
  res.json({ logs: r.rows, total, page, pageSize, actionGroups: actions.rows.map((x) => x.a) });
}));

router.get('/audit/export', requirePerm('audit.view'), ah(async (req, res) => {
  const { where, params } = auditFilter(req);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${todayISO()}_Rev01_AuditLog.csv"`);
  res.write('﻿' + csvLine(['Date', 'Time', 'User', 'Email', 'Action', 'Entity', 'Entity ID', 'Summary', 'Details', 'IP']));
  let before = null;
  for (let i = 0; i < 200; i++) { // up to 200 x 1,000 rows
    const p = [...params];
    let w = where;
    if (before) { p.push(before); w += ` AND l.id < $${p.length}`; }
    const r = await query(`SELECT l.id, l.created_at, u.name, l.user_email, l.action, l.entity_type, l.entity_id, l.summary, l.details, l.ip
      FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id WHERE ${w} ORDER BY l.id DESC LIMIT 1000`, p);
    for (const x of r.rows) {
      const d = new Date(x.created_at);
      res.write(csvLine([d.toLocaleDateString('en-AU'), d.toLocaleTimeString('en-AU'), x.name || '', x.user_email, x.action, x.entity_type, x.entity_id, x.summary, JSON.stringify(x.details), x.ip || '']));
    }
    if (r.rows.length < 1000) break;
    before = r.rows[r.rows.length - 1].id;
  }
  await audit(req, 'audit.export', { summary: 'Exported the audit log' });
  res.end();
}));

/* ---------- settings ---------- */
router.get('/settings', requireAuth, ah(async (req, res) => {
  const s = await getSettings(req.user.orgId);
  // Everyone may read report defaults and thresholds (used by the UI); only settings.manage may write.
  res.json({ settings: s, defaults: SETTING_DEFAULTS, canManage: can(req.user, 'settings.manage') });
}));

router.put('/settings/:key', requirePerm('settings.manage'), ah(async (req, res) => {
  const key = String(req.params.key);
  if (!Object.keys(SETTING_DEFAULTS).includes(key)) throw badRequest('Unknown settings group.');
  const before = (await getSettings(req.user.orgId))[key];
  let saved;
  try { saved = await saveSetting(req.user.orgId, key, req.body || {}, req.user.id); } catch (err) { throw badRequest(err.message); }
  await audit(req, 'settings.update', { entityType: 'settings', entityId: key, summary: `Updated ${key} settings`, details: { before, after: saved } });
  res.json({ settings: saved });
}));

/* ---------- analytics ---------- */
router.get('/analytics', requirePerm('analytics.view'), ah(async (req, res) => {
  const org = req.user.orgId;
  const months = Math.min(24, Math.max(3, parseInt(req.query.months, 10) || 12));
  const totals = await one(`SELECT
      (SELECT coalesce(sum(v.asset_count), 0) FROM asset_registers g JOIN register_versions v ON v.id = g.active_version_id WHERE g.organisation_id = $1)::int AS total_assets,
      (SELECT count(*) FROM generated_reports WHERE organisation_id = $1)::int AS reports_generated,
      (SELECT count(*) FROM inspection_reports WHERE organisation_id = $1 AND status = 'processed')::int AS inspections_processed,
      (SELECT count(*) FROM inspection_findings WHERE organisation_id = $1)::int AS findings,
      (SELECT count(*) FROM users WHERE organisation_id = $1 AND deleted_at IS NULL AND last_login_at > now() - interval '30 days')::int AS active_users,
      (SELECT count(*) FROM register_versions WHERE organisation_id = $1 AND published_at IS NOT NULL)::int AS register_updates`, [org]);
  const series = await query(`
    WITH m AS (SELECT generate_series(date_trunc('month', now()) - make_interval(months => $2 - 1), date_trunc('month', now()), interval '1 month') AS month)
    SELECT to_char(m.month, 'YYYY-MM') AS month,
      (SELECT count(*) FROM inspection_reports r WHERE r.organisation_id = $1 AND date_trunc('month', r.uploaded_at) = m.month)::int AS inspections,
      (SELECT count(*) FROM generated_reports g WHERE g.organisation_id = $1 AND date_trunc('month', g.generated_at) = m.month)::int AS reports,
      (SELECT count(*) FROM register_versions v WHERE v.organisation_id = $1 AND date_trunc('month', v.published_at) = m.month)::int AS register_updates,
      (SELECT count(DISTINCT l.user_id) FROM audit_logs l WHERE l.organisation_id = $1 AND l.action = 'auth.login' AND date_trunc('month', l.created_at) = m.month)::int AS active_users
    FROM m ORDER BY m.month`, [org, months]);
  const growth = await query(`SELECT v.version_no, v.published_at, v.asset_count FROM register_versions v WHERE v.organisation_id = $1 AND v.published_at IS NOT NULL ORDER BY v.published_at`, [org]);
  const mostViewed = await query(`SELECT id, name, view_count, generated_at FROM generated_reports WHERE organisation_id = $1 AND view_count > 0 ORDER BY view_count DESC LIMIT 5`, [org]);
  const usage = await query(`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS events FROM audit_logs
    WHERE organisation_id = $1 AND created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`, [org]);
  const conditions = await query(`SELECT f.condition, count(*)::int AS n FROM inspection_findings f JOIN inspection_reports r ON r.id = f.report_id
    WHERE f.organisation_id = $1 AND r.uploaded_at > now() - interval '12 months' GROUP BY f.condition ORDER BY f.condition NULLS LAST`, [org]);
  res.json({ totals, series: series.rows, growth: growth.rows, mostViewed: mostViewed.rows, usage: usage.rows, conditions: conditions.rows });
}));

/* ---------- dashboard (every signed-in user) ---------- */
router.get('/dashboard', requirePerm('dashboard.view'), ah(async (req, res) => {
  const org = req.user.orgId;
  const d = await one(`SELECT
      (SELECT coalesce(sum(v.asset_count), 0) FROM asset_registers g JOIN register_versions v ON v.id = g.active_version_id WHERE g.organisation_id = $1)::int AS total_assets,
      (SELECT max(v.version_no) FROM asset_registers g JOIN register_versions v ON v.id = g.active_version_id WHERE g.organisation_id = $1) AS active_version,
      (SELECT max(v.published_at) FROM register_versions v WHERE v.organisation_id = $1) AS last_register_update,
      (SELECT count(*) FROM register_versions v WHERE v.organisation_id = $1 AND v.status = 'pending_approval')::int AS pending_registers,
      (SELECT count(*) FROM inspection_reports WHERE organisation_id = $1)::int AS inspections,
      (SELECT count(*) FROM inspection_reports WHERE organisation_id = $1 AND uploaded_at > now() - interval '30 days')::int AS inspections_30d,
      (SELECT coalesce(sum(review_count), 0) FROM inspection_reports WHERE organisation_id = $1)::int AS open_reviews,
      (SELECT count(*) FROM generated_reports WHERE organisation_id = $1)::int AS reports,
      (SELECT count(*) FROM generated_reports WHERE organisation_id = $1 AND status = 'draft')::int AS draft_reports`, [org]);
  const recentInspections = await query(`SELECT r.id, r.file_name, r.report_ref, r.assessment_date, r.finding_count, r.review_count, r.uploaded_at, u.name AS uploaded_by_name
    FROM inspection_reports r LEFT JOIN users u ON u.id = r.uploaded_by WHERE r.organisation_id = $1 ORDER BY r.uploaded_at DESC LIMIT 6`, [org]);
  const recentReports = await query(`SELECT g.id, g.name, g.status, g.generated_at, u.name AS generated_by_name FROM generated_reports g LEFT JOIN users u ON u.id = g.generated_by
    WHERE g.organisation_id = $1 ORDER BY g.generated_at DESC LIMIT 6`, [org]);
  const conditions = await query(`SELECT f.condition, count(*)::int AS n FROM inspection_findings f WHERE f.organisation_id = $1 GROUP BY f.condition ORDER BY f.condition NULLS LAST`, [org]);
  res.json({ summary: d, recentInspections: recentInspections.rows, recentReports: recentReports.rows, conditions: conditions.rows });
}));

/* ---------- global search ---------- */
router.get('/search', requireAuth, ah(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (q.length < 2) return res.json({ q, assets: [], reports: [], inspections: [], findings: [], users: [] });
  const org = req.user.orgId;
  const like = likeTerm(q);
  const out = { q, assets: [], reports: [], inspections: [], findings: [], users: [] };
  if (can(req.user, 'assets.view')) {
    out.assets = (await query(`SELECT a.id, av.asset_code, av.description, av.category, av.location, av.status FROM asset_registers g
      JOIN asset_versions av ON av.version_id = g.active_version_id JOIN assets a ON a.id = av.asset_id
      WHERE g.organisation_id = $1 AND av.is_primary AND (av.asset_code || ' ' || av.description || ' ' || av.location) ILIKE $2 ORDER BY av.asset_code LIMIT 20`, [org, like])).rows;
  }
  if (can(req.user, 'reports.view')) {
    out.reports = (await query(`SELECT g.id, g.name, g.status, g.generated_at, u.name AS generated_by_name FROM generated_reports g LEFT JOIN users u ON u.id = g.generated_by
      WHERE g.organisation_id = $1 AND (g.name ILIKE $2 OR u.name ILIKE $2) ORDER BY g.generated_at DESC LIMIT 10`, [org, like])).rows;
  }
  if (can(req.user, 'inspections.view')) {
    out.inspections = (await query(`SELECT r.id, r.file_name, r.report_ref, r.assessment_date, r.uploaded_at FROM inspection_reports r
      WHERE r.organisation_id = $1 AND (r.file_name || ' ' || r.report_ref || ' ' || r.site) ILIKE $2 ORDER BY r.uploaded_at DESC LIMIT 10`, [org, like])).rows;
    out.findings = (await query(`SELECT f.id, f.report_id, f.report_asset_text, f.asset_code_snapshot, f.condition, f.match_status, r.file_name, r.assessment_date
      FROM inspection_findings f JOIN inspection_reports r ON r.id = f.report_id
      WHERE f.organisation_id = $1 AND (f.report_asset_text ILIKE $2 OR f.asset_code_snapshot ILIKE $2) ORDER BY r.uploaded_at DESC LIMIT 20`, [org, like])).rows;
  }
  if (can(req.user, 'users.view')) {
    out.users = (await query(`SELECT u.id, u.name, u.email, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.organisation_id = $1 AND u.deleted_at IS NULL AND (u.name ILIKE $2 OR u.email ILIKE $2) ORDER BY u.name LIMIT 10`, [org, like])).rows;
  }
  res.json(out);
}));

export default router;
