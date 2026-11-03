// Generated inspection registers. A report freezes its rows (snapshot) so every re-download is identical.
import { query, one } from '../db.js';
import { notFound, conflict } from '../lib/http.js';
import { getSettings } from './settings.js';
import { getReport } from './inspections.js';
import { ACCEPTED_STATUSES, COND_LABELS } from '../../shared/engine.js';
import { pageList, fmtDate } from '../../shared/report-parser.js';

export function buildRows(findings) {
  return findings.map((f, i) => {
    const accepted = ACCEPTED_STATUSES.has(f.match_status);
    const cands = Array.isArray(f.candidates) ? f.candidates : [];
    const proposed = f.match_status === 'review' ? cands[0] : null;
    const kind = accepted ? 'matched' : f.match_status === 'review' ? 'review' : 'unmatched';
    const conf = f.confidence == null ? null : Math.round(Number(f.confidence));
    const pages = f.condition_pages && f.condition_pages.length ? f.condition_pages : (f.pages || []).slice(0, 1);
    return {
      item: i + 1,
      findingId: f.id,
      kind,
      assetId: accepted ? f.asset_code_snapshot : proposed ? proposed.assetCode : '',
      assetDescription: accepted ? f.asset_description_snapshot : proposed ? proposed.description : f.report_asset_text,
      reportDescription: f.report_asset_text + (f.sub_location ? ' / ' + f.sub_location : ''),
      condition: f.condition,
      conditionText: f.condition == null ? 'Not rated' : f.condition + (COND_LABELS[f.condition] ? ' - ' + COND_LABELS[f.condition] : ''),
      inspectionNotes: f.inspection_notes || '',
      findings: f.findings_summary || '',
      page: pageList(pages),
      confidence: conf,
      statusText: accepted ? (['confirmed', 'manual'].includes(f.match_status) ? 'Confirmed' : 'Matched')
        : kind === 'review' ? 'Review required' : f.match_status === 'rejected' ? 'Not in register (confirmed)' : 'Not in register',
      reason: f.match_explanation || '',
      closestAssetId: kind === 'unmatched' && f.match_status !== 'rejected' && cands[0] ? cands[0].assetCode : ''
    };
  });
}

export function countRows(rows, minCondition) {
  const c = { total: rows.length, matched: 0, review: 0, unmatched: 0, breaches: 0, cond: [0, 0, 0, 0, 0, 0] };
  rows.forEach((r) => {
    c[r.kind]++;
    if (r.condition != null && r.condition > minCondition) c.breaches++;
    if (r.condition >= 1 && r.condition <= 5) c.cond[r.condition - 1]++; else c.cond[5]++;
  });
  return c;
}

export async function generateReport(user, inspectionId, input) {
  const insp = await getReport(user.orgId, inspectionId);
  if (insp.status !== 'processed') throw conflict('This inspection has not finished processing.');
  const settings = await getSettings(user.orgId);
  const rs = settings.reports;
  const findings = (await query('SELECT * FROM inspection_findings WHERE report_id = $1 ORDER BY seq', [insp.id])).rows;
  const rows = buildRows(findings);
  const counts = countRows(rows, rs.minAcceptableCondition);
  const version = insp.register_version_id ? await one(`SELECT v.version_no, v.source_filename, v.asset_count, g.name FROM register_versions v JOIN asset_registers g ON g.id = v.register_id WHERE v.id = $1`, [insp.register_version_id]) : null;
  const title = String(input.title || rs.defaultTitle).slice(0, 200);
  const preparedFor = String(input.preparedFor || '').slice(0, 200);
  const preparedBy = String(input.preparedBy || rs.defaultPreparedBy).slice(0, 200);
  const snapshot = {
    title, preparedFor, preparedBy, footerText: rs.footerText,
    reportRef: insp.report_ref, site: insp.site, fileName: insp.file_name, pageCount: insp.page_count,
    assessmentDate: insp.assessment_date, assessmentDateText: insp.assessment_date ? fmtDate(insp.assessment_date) : 'Not stated',
    register: version ? { name: version.name, versionNo: version.version_no, assetCount: version.asset_count, fileName: version.source_filename } : null,
    minCondition: rs.minAcceptableCondition, generatedByName: user.name, generatedAt: new Date().toISOString(), counts, rows
  };
  const autoApprove = !rs.requireApproval || user.permissions.has('reports.approve');
  const name = [insp.report_ref || insp.file_name.replace(/\.pdf$/i, ''), title].filter(Boolean).join(' - ').slice(0, 250);
  return one(`INSERT INTO generated_reports (organisation_id, inspection_report_id, register_version_id, name, title, prepared_for, prepared_by_text,
      status, asset_count, flagged_count, snapshot, generated_by, approved_by, approved_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id, name, status`,
    [user.orgId, insp.id, insp.register_version_id, name, title, preparedFor, preparedBy, autoApprove ? 'approved' : 'draft',
      counts.total, counts.review + counts.unmatched, JSON.stringify(snapshot), user.id, autoApprove ? user.id : null, autoApprove ? new Date() : null]);
}

export async function getGenerated(orgId, id, { withSnapshot = true } = {}) {
  const r = await one(`SELECT g.${withSnapshot ? '*' : 'id, g.organisation_id, g.inspection_report_id, g.register_version_id, g.name, g.title, g.prepared_for, g.prepared_by_text, g.status, g.asset_count, g.flagged_count, g.generated_by, g.generated_at, g.approved_by, g.approved_at, g.view_count'},
      gu.name AS generated_by_name, au.name AS approved_by_name, i.file_name, i.report_ref, i.assessment_date, i.uploaded_at, v.version_no
    FROM generated_reports g JOIN inspection_reports i ON i.id = g.inspection_report_id
    LEFT JOIN users gu ON gu.id = g.generated_by LEFT JOIN users au ON au.id = g.approved_by LEFT JOIN register_versions v ON v.id = g.register_version_id
    WHERE g.id = $1 AND g.organisation_id = $2`, [id, orgId]);
  if (!r) throw notFound('Report');
  return r;
}
