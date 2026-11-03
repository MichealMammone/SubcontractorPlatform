// Report history: search/filter, details, approval and export (Excel / CSV / PDF), with export history.
import { Router } from 'express';
import { query, one } from '../db.js';
import { ah, uuidParam, paging, likeTerm, isoDate, conflict, safeFileName, todayISO } from '../lib/http.js';
import { requirePerm } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { getGenerated } from '../services/reports.js';
import { reportXlsx, reportCsv, reportPdf } from '../services/exports.js';

const router = Router();

router.get('/', requirePerm('reports.view'), ah(async (req, res) => {
  const { limit, offset, page, pageSize } = paging(req.query, 25);
  const params = [req.user.orgId];
  let where = 'g.organisation_id = $1';
  const add = (v, sql) => { params.push(v); where += ' AND ' + sql.replace('?', '$' + params.length); };
  if (req.query.q) add(likeTerm(req.query.q), `(g.name || ' ' || i.file_name || ' ' || i.report_ref) ILIKE ?`);
  if (req.query.from) add(isoDate(req.query.from, 'From'), 'g.generated_at >= ?::date');
  if (req.query.to) add(isoDate(req.query.to, 'To'), 'g.generated_at < ?::date + 1');
  if (req.query.user) add(uuidParam(req.query.user, 'User'), 'g.generated_by = ?');
  if (req.query.status) add(String(req.query.status), 'g.status = ?');
  if (req.query.version) add(parseInt(req.query.version, 10) || 0, 'v.version_no = ?');
  if (req.query.condition) add(parseInt(req.query.condition, 10) || 0, 'EXISTS (SELECT 1 FROM inspection_findings f WHERE f.report_id = g.inspection_report_id AND f.condition >= ?)');
  if (req.query.asset) add(likeTerm(req.query.asset), 'EXISTS (SELECT 1 FROM inspection_findings f WHERE f.report_id = g.inspection_report_id AND f.asset_code_snapshot ILIKE ?)');
  const from = `FROM generated_reports g JOIN inspection_reports i ON i.id = g.inspection_report_id LEFT JOIN register_versions v ON v.id = g.register_version_id LEFT JOIN users u ON u.id = g.generated_by`;
  const total = (await one(`SELECT count(*)::int AS n ${from} WHERE ${where}`, params)).n;
  params.push(limit, offset);
  const r = await query(`SELECT g.id, g.name, g.status, g.asset_count, g.flagged_count, g.generated_at, g.view_count, i.uploaded_at, i.file_name, i.report_ref,
      i.assessment_date, v.version_no, u.name AS generated_by_name,
      (SELECT count(*)::int FROM report_exports e WHERE e.generated_report_id = g.id) AS export_count
    ${from} WHERE ${where} ORDER BY g.generated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ reports: r.rows, total, page, pageSize });
}));

router.get('/:id', requirePerm('reports.view'), ah(async (req, res) => {
  const g = await getGenerated(req.user.orgId, uuidParam(req.params.id, 'Report'));
  await query('UPDATE generated_reports SET view_count = view_count + 1, last_viewed_at = now() WHERE id = $1', [g.id]);
  const exportsList = await query(`SELECT e.format, e.file_name, e.exported_at, u.name AS exported_by_name FROM report_exports e LEFT JOIN users u ON u.id = e.exported_by
    WHERE e.generated_report_id = $1 ORDER BY e.exported_at DESC LIMIT 50`, [g.id]);
  res.json({ report: g, exports: exportsList.rows });
}));

router.post('/:id/approve', requirePerm('reports.approve'), ah(async (req, res) => {
  const g = await getGenerated(req.user.orgId, uuidParam(req.params.id, 'Report'), { withSnapshot: false });
  if (g.status === 'approved') throw conflict('This report is already approved.');
  await query(`UPDATE generated_reports SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [g.id, req.user.id]);
  await audit(req, 'report.approve', { entityType: 'generated_report', entityId: g.id, summary: `Approved "${g.name}" for client delivery` });
  res.json({ ok: true });
}));

router.get('/:id/export', requirePerm('reports.export'), ah(async (req, res) => {
  const g = await getGenerated(req.user.orgId, uuidParam(req.params.id, 'Report'));
  const format = ['xlsx', 'csv', 'pdf'].includes(req.query.format) ? req.query.format : 'pdf';
  // YYYY-MM-DD_RevNN_Name: the revision is this report's position among reports generated for the same inspection.
  const rev = (await one('SELECT count(*)::int AS n FROM generated_reports WHERE inspection_report_id = $1 AND generated_at <= $2', [g.inspection_report_id, g.generated_at])).n;
  const name = `${todayISO()}_Rev${String(rev).padStart(2, '0')}_InspectionRegister${g.report_ref ? '_' + g.report_ref : ''}`;
  const fileName = safeFileName(name) + '.' + format;
  let body; let type;
  if (format === 'xlsx') { body = reportXlsx(g); type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; }
  else if (format === 'csv') { body = reportCsv(g); type = 'text/csv; charset=utf-8'; }
  else { body = reportPdf(g); type = 'application/pdf'; }
  await query('INSERT INTO report_exports (organisation_id, generated_report_id, format, file_name, exported_by) VALUES ($1, $2, $3, $4, $5)', [req.user.orgId, g.id, format, fileName, req.user.id]);
  await audit(req, 'report.export', { entityType: 'generated_report', entityId: g.id, summary: `Exported "${g.name}" as ${format.toUpperCase()}${g.status !== 'approved' ? ' (draft)' : ''}` });
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.end(body);
}));

export default router;
