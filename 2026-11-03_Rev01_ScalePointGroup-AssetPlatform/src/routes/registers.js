// Asset Register Hub API: dashboard, upload centre (staging -> validate/compare -> approve -> publish), versions.
import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { query, one } from '../db.js';
import { config } from '../config.js';
import { ah, uuidParam, paging, badRequest, conflict, safeFileName, todayISO } from '../lib/http.js';
import { requirePerm } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { getSetting } from '../services/settings.js';
import * as reg from '../services/registers.js';
import { toXlsx, csvLine } from '../services/exports.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });
const VERSION_COLS = `v.id, v.version_no, v.status, v.source_filename, v.sheet_name, v.asset_count, v.rows_received, v.notes, v.change_summary, v.based_on_version_id,
  v.uploaded_at, v.submitted_at, v.approved_at, v.published_at, v.archived_at, v.rejected_at, v.rejection_reason, v.headers, v.mapping,
  u.name AS uploaded_by_name, a.name AS approved_by_name`;

router.get('/hub', requirePerm('registers.view'), ah(async (req, res) => {
  const org = req.user.orgId;
  const g = await one('SELECT * FROM asset_registers WHERE organisation_id = $1 ORDER BY created_at LIMIT 1', [org]);
  if (!g) return res.json({ register: null, active: null, pending: null, metrics: null, versions: [] });
  const active = g.active_version_id ? await one(`SELECT ${VERSION_COLS} FROM register_versions v LEFT JOIN users u ON u.id = v.uploaded_by LEFT JOIN users a ON a.id = v.approved_by WHERE v.id = $1`, [g.active_version_id]) : null;
  const pending = await one(`SELECT ${VERSION_COLS} FROM register_versions v LEFT JOIN users u ON u.id = v.uploaded_by LEFT JOIN users a ON a.id = v.approved_by
    WHERE v.register_id = $1 AND v.status IN ('staging', 'pending_approval') ORDER BY v.version_no DESC LIMIT 1`, [g.id]);
  const m = active ? await one(`SELECT
      count(*) FILTER (WHERE is_primary)::int AS total,
      count(*) FILTER (WHERE is_primary AND NOT is_archived)::int AS active,
      count(*) FILTER (WHERE is_primary AND change_type = 'added')::int AS added,
      count(*) FILTER (WHERE is_primary AND change_type = 'modified')::int AS modified
    FROM asset_versions WHERE version_id = $1`, [active.id]) : null;
  const archived = await one(`SELECT count(*)::int AS n FROM assets WHERE register_id = $1 AND state = 'archived'`, [g.id]);
  const versions = await query(`SELECT ${VERSION_COLS} FROM register_versions v LEFT JOIN users u ON u.id = v.uploaded_by LEFT JOIN users a ON a.id = v.approved_by
    WHERE v.register_id = $1 AND v.status <> 'staging' ORDER BY v.version_no DESC LIMIT 8`, [g.id]);
  res.json({
    register: { id: g.id, name: g.name },
    active, pending,
    metrics: m && {
      totalAssets: m.total, activeAssets: m.active, archivedAssets: archived.n, newAssets: m.added, modifiedAssets: m.modified,
      removedAssets: active.change_summary ? active.change_summary.removed || 0 : 0, lastUpdate: active.published_at, activeVersion: active.version_no
    },
    versions: versions.rows
  });
}));

router.get('/versions', requirePerm('registers.view'), ah(async (req, res) => {
  const { limit, offset, page, pageSize } = paging(req.query, 25);
  const params = [req.user.orgId];
  let where = `v.organisation_id = $1 AND v.status <> 'staging'`;
  if (req.query.status) { params.push(String(req.query.status)); where += ` AND v.status = $${params.length}`; }
  const total = (await one(`SELECT count(*)::int AS n FROM register_versions v WHERE ${where}`, params)).n;
  params.push(limit, offset);
  const r = await query(`SELECT ${VERSION_COLS} FROM register_versions v LEFT JOIN users u ON u.id = v.uploaded_by LEFT JOIN users a ON a.id = v.approved_by
    WHERE ${where} ORDER BY v.version_no DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ versions: r.rows, total, page, pageSize });
}));

// Headings + mapping of the active version, so the browser can carry the mapping onto a new upload.
router.get('/mapping-hint', requirePerm('registers.upload'), ah(async (req, res) => {
  const v = await reg.activeVersion(req.user.orgId);
  res.json({ previous: v ? { headers: v.headers, mapping: v.mapping, versionNo: v.version_no, assetCount: v.asset_count } : null });
}));

router.get('/versions/:id', requirePerm('registers.view'), ah(async (req, res) => {
  const v = await reg.getVersion(req.user.orgId, uuidParam(req.params.id, 'Register version'));
  delete v.token_stats;
  const based = v.based_on_version_id ? await one('SELECT version_no FROM register_versions WHERE id = $1', [v.based_on_version_id]) : null;
  res.json({ version: { ...v, based_on_version_no: based ? based.version_no : null } });
}));

router.post('/staging', requirePerm('registers.upload'), ah(async (req, res) => {
  const v = await reg.createStaging(req.user, req.body || {});
  res.status(201).json(v);
}));

router.post('/staging/:id/file', requirePerm('registers.upload'), upload.single('file'), ah(async (req, res) => {
  const v = await reg.getVersion(req.user.orgId, uuidParam(req.params.id, 'Register version'));
  if (v.status !== 'staging') throw conflict('This upload is closed.');
  if (!req.file) throw badRequest('No file received.');
  if (!(await getSetting(req.user.orgId, 'registers')).storeOriginalFiles) return res.json({ stored: false });
  const sha = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const f = await one(`INSERT INTO stored_files (organisation_id, kind, file_name, mime_type, size_bytes, sha256, data, uploaded_by)
    VALUES ($1, 'register', $2, $3, $4, $5, $6, $7) RETURNING id`, [req.user.orgId, String(req.file.originalname).slice(0, 255), req.file.mimetype || 'application/octet-stream', req.file.size, sha, req.file.buffer, req.user.id]);
  await query('UPDATE register_versions SET source_file_id = $2 WHERE id = $1', [v.id, f.id]);
  res.json({ stored: true });
}));

router.post('/staging/:id/rows', requirePerm('registers.upload'), ah(async (req, res) => {
  res.json(await reg.addStagingRows(req.user, uuidParam(req.params.id, 'Register version'), req.body || {}));
}));

router.post('/staging/:id/finalize', requirePerm('registers.upload'), ah(async (req, res) => {
  const id = uuidParam(req.params.id, 'Register version');
  const summary = await reg.finalizeStaging(req.user, id);
  const v = await reg.getVersion(req.user.orgId, id);
  await audit(req, 'register.upload', { entityType: 'register_version', entityId: id, summary: `Uploaded ${v.source_filename} as version ${v.version_no} (${summary.assets} assets): ${summary.added} added, ${summary.modified} modified, ${summary.removed} removed`, details: { summary } });
  res.json({ summary });
}));

router.get('/versions/:id/changes', requirePerm('registers.view'), ah(async (req, res) => {
  const v = await reg.getVersion(req.user.orgId, uuidParam(req.params.id, 'Register version'));
  const { limit, offset, page, pageSize } = paging(req.query, 50, 500);
  const items = await reg.compareList(v.based_on_version_id, v.id, String(req.query.type || 'added'), { limit, offset });
  res.json({ items, page, pageSize });
}));

router.get('/compare', requirePerm('registers.view'), ah(async (req, res) => {
  const from = await reg.getVersion(req.user.orgId, uuidParam(req.query.from, 'Register version'));
  const to = await reg.getVersion(req.user.orgId, uuidParam(req.query.to, 'Register version'));
  const { limit, offset, page, pageSize } = paging(req.query, 50, 500);
  const counts = await reg.compareCounts(from.id, to.id);
  const items = req.query.type ? await reg.compareList(from.id, to.id, String(req.query.type), { limit, offset }) : [];
  res.json({ from: { id: from.id, versionNo: from.version_no }, to: { id: to.id, versionNo: to.version_no }, counts, items, page, pageSize });
}));

router.post('/versions/:id/approve', requirePerm('registers.approve'), ah(async (req, res) => {
  const v = await reg.approveVersion(req.user, uuidParam(req.params.id, 'Register version'), String((req.body && req.body.notes) || '').slice(0, 1000));
  await audit(req, 'register.publish', { entityType: 'register_version', entityId: v.id, summary: `Approved and published register version ${v.version_no} (${v.asset_count} assets)`, details: { summary: v.change_summary, previousVersionId: v.based_on_version_id } });
  res.json({ ok: true });
}));

router.post('/versions/:id/reject', requirePerm('registers.approve'), ah(async (req, res) => {
  const reason = String((req.body && req.body.reason) || '').slice(0, 1000);
  const v = await reg.rejectVersion(req.user, uuidParam(req.params.id, 'Register version'), reason);
  await audit(req, 'register.reject', { entityType: 'register_version', entityId: v.id, summary: `Rejected register upload version ${v.version_no}`, details: { reason } });
  res.json({ ok: true });
}));

router.post('/versions/:id/restore', requirePerm('registers.rollback'), ah(async (req, res) => {
  const notes = String((req.body && req.body.notes) || '').slice(0, 1000);
  const { version, fromVersionId } = await reg.restoreVersion(req.user, uuidParam(req.params.id, 'Register version'), notes);
  await audit(req, 'register.rollback', { entityType: 'register_version', entityId: version.id, summary: `Rolled back to register version ${version.version_no}`, details: { fromVersionId, notes } });
  res.json({ ok: true });
}));

router.get('/versions/:id/export', requirePerm('registers.export'), ah(async (req, res) => {
  const v = await reg.getVersion(req.user.orgId, uuidParam(req.params.id, 'Register version'));
  if (['staging', 'rejected'].includes(v.status)) throw conflict('This version has no exportable data.');
  const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
  if (format === 'xlsx' && v.asset_count > 150000) throw badRequest('Registers over 150,000 assets export as CSV.');
  const base = `${todayISO()}_Rev${String(v.version_no).padStart(2, '0')}_AssetRegister`; // RevNN = register version
  await audit(req, 'register.export', { entityType: 'register_version', entityId: v.id, summary: `Exported register version ${v.version_no} as ${format.toUpperCase()}` });
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName(base)}.csv"`);
    res.write('﻿' + csvLine(reg.exportHeader(v)));
    for await (const row of reg.versionRows(v.id)) {
      if (!res.write(csvLine(reg.exportLine(v, row)))) await new Promise((r) => res.once('drain', r));
    }
    return res.end();
  }
  const aoa = [reg.exportHeader(v)];
  for await (const row of reg.versionRows(v.id)) aoa.push(reg.exportLine(v, row));
  const buf = toXlsx([{ name: `Register v${v.version_no}`, aoa, headerRow: 0 }]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFileName(base)}.xlsx"`);
  res.end(buf);
}));

export default router;
