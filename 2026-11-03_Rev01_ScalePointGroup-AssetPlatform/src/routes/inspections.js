// Inspection reports: upload (PDF + browser-extracted data), history, findings review, corrections, rematch, report generation.
import { Router } from 'express';
import multer from 'multer';
import { query, one } from '../db.js';
import { config } from '../config.js';
import { ah, uuidParam, idParam, paging, likeTerm, badRequest, isoDate, notFound, str } from '../lib/http.js';
import { requirePerm } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { processInspection, getReport, correctFinding, rematch } from '../services/inspections.js';
import { generateReport } from '../services/reports.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1, fieldSize: 40 * 1024 * 1024 } });

router.post('/', requirePerm('inspections.upload'), upload.single('file'), ah(async (req, res) => {
  if (!req.file) throw badRequest('Attach the inspection report PDF.');
  if (req.file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw badRequest('That file is not a PDF.');
  let payload;
  try { payload = JSON.parse(req.body.payload || '{}'); } catch { throw badRequest('The extracted report data could not be read.'); }
  const out = await processInspection(req.user, req.file, payload);
  const r = out.report;
  await audit(req, 'inspection.upload', { entityType: 'inspection_report', entityId: r.id,
    summary: `Uploaded ${r.file_name}: ${r.finding_count} assets, ${r.matched_count} matched, ${r.review_count} to review, ${r.unmatched_count} not in register (register v${out.versionNo})`,
    details: { reportRef: r.report_ref, assessmentDate: r.assessment_date, duplicateOf: out.duplicateOf } });
  res.status(201).json({ id: r.id, duplicateOf: out.duplicateOf });
}));

router.get('/', requirePerm('inspections.view'), ah(async (req, res) => {
  const { limit, offset, page, pageSize } = paging(req.query, 25);
  const params = [req.user.orgId];
  let where = 'r.organisation_id = $1';
  if (req.query.q) { params.push(likeTerm(req.query.q)); where += ` AND (r.file_name || ' ' || r.report_ref || ' ' || r.site) ILIKE $${params.length}`; }
  if (req.query.from) { params.push(isoDate(req.query.from, 'From')); where += ` AND r.uploaded_at >= $${params.length}::date`; }
  if (req.query.to) { params.push(isoDate(req.query.to, 'To')); where += ` AND r.uploaded_at < $${params.length}::date + 1`; }
  if (req.query.user) { params.push(uuidParam(req.query.user, 'User')); where += ` AND r.uploaded_by = $${params.length}`; }
  if (req.query.status) { params.push(String(req.query.status)); where += ` AND r.status = $${params.length}`; }
  const total = (await one(`SELECT count(*)::int AS n FROM inspection_reports r WHERE ${where}`, params)).n;
  params.push(limit, offset);
  const r = await query(`SELECT r.id, r.file_name, r.report_ref, r.site, r.assessment_date, r.assessment_date_source, r.status, r.page_count, r.finding_count, r.matched_count,
      r.review_count, r.unmatched_count, r.uploaded_at, r.processed_at, u.name AS uploaded_by_name, v.version_no,
      (SELECT count(*)::int FROM generated_reports g WHERE g.inspection_report_id = r.id) AS generated_count
    FROM inspection_reports r LEFT JOIN users u ON u.id = r.uploaded_by LEFT JOIN register_versions v ON v.id = r.register_version_id
    WHERE ${where} ORDER BY r.uploaded_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ inspections: r.rows, total, page, pageSize });
}));

router.patch('/findings/:fid', requirePerm('inspections.review'), ah(async (req, res) => {
  const out = await correctFinding(req.user, idParam(req.params.fid, 'Finding'), req.body || {});
  await audit(req, 'finding.correct', { entityType: 'inspection_finding', entityId: out.finding.id,
    summary: `${req.body.action} on "${out.finding.report_asset_text}": ${out.before.status}${out.before.assetCode ? ' ' + out.before.assetCode : ''} -> ${out.after.status}${out.after.assetCode ? ' ' + out.after.assetCode : ''}`,
    details: { reportId: out.finding.report_id, before: out.before, after: out.after, note: req.body.note || '' } });
  res.json({ ok: true, after: out.after });
}));

router.get('/:id', requirePerm('inspections.view'), ah(async (req, res) => {
  const r = await getReport(req.user.orgId, uuidParam(req.params.id, 'Inspection report'));
  const reports = await query(`SELECT g.id, g.name, g.status, g.asset_count, g.flagged_count, g.generated_at, u.name AS generated_by_name
    FROM generated_reports g LEFT JOIN users u ON u.id = g.generated_by WHERE g.inspection_report_id = $1 ORDER BY g.generated_at DESC`, [r.id]);
  const history = await query(`SELECT action, summary, user_email, created_at FROM audit_logs
    WHERE organisation_id = $1 AND ((entity_type = 'inspection_report' AND entity_id = $2) OR (entity_type = 'inspection_finding' AND details->>'reportId' = $2))
    ORDER BY created_at DESC LIMIT 100`, [req.user.orgId, r.id]);
  const breakdown = await query(`SELECT condition, count(*)::int AS n FROM inspection_findings WHERE report_id = $1 GROUP BY condition`, [r.id]);
  delete r.file_sha256;
  res.json({ inspection: r, reports: reports.rows, history: history.rows, conditions: breakdown.rows });
}));

router.get('/:id/findings', requirePerm('inspections.view'), ah(async (req, res) => {
  const r = await getReport(req.user.orgId, uuidParam(req.params.id, 'Inspection report'));
  const { limit, offset, page, pageSize } = paging(req.query, 100, 500);
  const params = [r.id];
  let where = 'f.report_id = $1';
  const groups = { matched: `('match', 'likely', 'confirmed', 'manual')`, review: `('review')`, unmatched: `('nomatch', 'rejected')` };
  if (groups[req.query.status]) where += ` AND f.match_status IN ${groups[req.query.status]}`;
  if (req.query.q) { params.push(likeTerm(req.query.q)); where += ` AND (f.report_asset_text || ' ' || f.asset_code_snapshot || ' ' || f.asset_description_snapshot) ILIKE $${params.length}`; }
  if (req.query.condition) { params.push(parseInt(req.query.condition, 10)); where += ` AND f.condition >= $${params.length}`; }
  const total = (await one(`SELECT count(*)::int AS n FROM inspection_findings f WHERE ${where}`, params)).n;
  params.push(limit, offset);
  const f = await query(`SELECT f.*, ru.name AS reviewed_by_name FROM inspection_findings f LEFT JOIN users ru ON ru.id = f.reviewed_by
    WHERE ${where} ORDER BY f.seq LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ findings: f.rows, total, page, pageSize });
}));

router.get('/:id/file', requirePerm('inspections.view'), ah(async (req, res) => {
  const r = await getReport(req.user.orgId, uuidParam(req.params.id, 'Inspection report'));
  const f = r.file_id && await one('SELECT file_name, mime_type, data FROM stored_files WHERE id = $1 AND organisation_id = $2', [r.file_id, req.user.orgId]);
  if (!f) throw notFound('Original file');
  await audit(req, 'inspection.download', { entityType: 'inspection_report', entityId: r.id, summary: `Downloaded original ${f.file_name}` });
  res.setHeader('Content-Type', f.mime_type);
  res.setHeader('Content-Disposition', `attachment; filename="${String(f.file_name).replace(/[^\w.-]+/g, '_')}"`);
  res.end(f.data);
}));

router.patch('/:id', requirePerm('inspections.review'), ah(async (req, res) => {
  const r = await getReport(req.user.orgId, uuidParam(req.params.id, 'Inspection report'));
  const date = isoDate(req.body.assessmentDate, 'Assessment date');
  if (!date) throw badRequest('Enter the assessment date.');
  await query(`UPDATE inspection_reports SET assessment_date = $2, assessment_date_source = 'manual' WHERE id = $1`, [r.id, date]);
  await audit(req, 'inspection.update', { entityType: 'inspection_report', entityId: r.id, summary: `Assessment date set to ${date}`, details: { before: r.assessment_date, after: date } });
  res.json({ ok: true });
}));

router.post('/:id/rematch', requirePerm('inspections.review'), ah(async (req, res) => {
  const id = uuidParam(req.params.id, 'Inspection report');
  const out = await rematch(req.user, id);
  await audit(req, 'inspection.rematch', { entityType: 'inspection_report', entityId: id, summary: `Re-matched ${out.findings} assets against register v${out.versionNo} (${out.relinked} reviewer decisions kept, ${out.lost} need review)`, details: out });
  res.json(out);
}));

// Register assets for manual assignment, searched within the version the report was matched against.
router.get('/:id/asset-search', requirePerm('inspections.review'), ah(async (req, res) => {
  const r = await getReport(req.user.orgId, uuidParam(req.params.id, 'Inspection report'));
  const q = str(req.query.q, { max: 120 });
  if (q.length < 2) return res.json({ assets: [] });
  const rows = await query(`SELECT id, asset_code, description, location, status FROM asset_versions
    WHERE version_id = $1 AND is_primary AND (asset_code || ' ' || description || ' ' || location) ILIKE $2 ORDER BY asset_code LIMIT 25`, [r.register_version_id, likeTerm(q)]);
  res.json({ assets: rows.rows });
}));

router.post('/:id/reports', requirePerm('reports.generate'), ah(async (req, res) => {
  const id = uuidParam(req.params.id, 'Inspection report');
  const g = await generateReport(req.user, id, req.body || {});
  await audit(req, 'report.generate', { entityType: 'generated_report', entityId: g.id, summary: `Generated "${g.name}" (${g.status})`, details: { inspectionId: id } });
  res.status(201).json(g);
}));

export default router;
