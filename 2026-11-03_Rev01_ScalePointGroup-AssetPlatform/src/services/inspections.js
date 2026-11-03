// Inspection report processing: store, match every finding against the active register, corrections, rematch.
import crypto from 'node:crypto';
import { query, one, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { getSettings } from './settings.js';
import { activeVersion } from './registers.js';
import { matchContext, matchFinding, mapLimit, scoreSpecific, decisionFields } from './matching.js';
import { ACCEPTED_STATUSES, explainMatch, autoStatus } from '../../shared/engine.js';

const MAX_FINDINGS = 20000;
const s = (v, max = 2000) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);
const ints = (a, max = 2000) => (Array.isArray(a) ? a.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 100000).slice(0, max) : []);

// Normalises the browser-extracted payload; nothing from the client is trusted as-is.
export function sanitisePayload(payload) {
  if (!payload || typeof payload !== 'object') throw badRequest('The report data is missing.');
  const recs = Array.isArray(payload.findings) ? payload.findings : [];
  if (!recs.length) throw badRequest('No assets were found in this report, so there is nothing to match.');
  if (recs.length > MAX_FINDINGS) throw badRequest(`This report lists more than ${MAX_FINDINGS} assets.`);
  const meta = payload.meta || {};
  const date = /^\d{4}-\d{2}-\d{2}$/.test(meta.dateISO || '') ? meta.dateISO : null;
  return {
    meta: {
      reportRef: s(meta.reportRef, 120), site: s(meta.site, 200), date: s(meta.date, 120), dateISO: date,
      dateSource: date ? (['report', 'first_date'].includes(meta.dateSource) ? meta.dateSource : 'report') : 'not_found',
      taskRef: s(meta.taskRef, 120), taskName: s(meta.taskName, 300)
    },
    warnings: (Array.isArray(payload.warnings) ? payload.warnings : []).map((w) => s(w, 300)).slice(0, 20),
    pageCount: Number.isInteger(payload.pageCount) ? Math.min(payload.pageCount, 100000) : 0,
    mergeDuplicates: payload.mergeDuplicates !== false,
    findings: recs.map((r, i) => ({
      seq: i + 1,
      header: s(r.header, 500) || 'Unnamed asset', prefix: s(r.prefix, 300), description: s(r.description, 500), subloc: s(r.subloc, 300),
      result: s(r.result, 30), condition: Number.isInteger(r.condition) && r.condition >= 0 && r.condition <= 10 ? r.condition : null,
      conditionPages: ints(r.conditionPages), pages: ints(r.pages), sections: (Array.isArray(r.sections) ? r.sections : []).map((x) => s(x, 200)).slice(0, 20),
      checks: (Array.isArray(r.checks) ? r.checks : []).slice(0, 300).map((c) => ({ section: s(c.section, 200), code: s(c.code, 20), title: s(c.title, 300), detail: s(c.detail, 500), result: s(c.result, 10) })),
      defects: (Array.isArray(r.defects) ? r.defects : []).slice(0, 50).map((d) => ({ type: s(d.type, 40), id: s(d.id, 30), age: Number.isInteger(d.age) ? d.age : null, reported: s(d.reported, 1500), repairs: s(d.repairs, 1500) })),
      comments: s(r.comments, 4000), inspectionNotes: s(r.inspectionNotes, 4000), findingsSummary: s(r.findingsSummary, 500)
    }))
  };
}

const FINDINGS_SQL = `
  INSERT INTO inspection_findings (organisation_id, report_id, seq, report_asset_text, description, sub_location, prefix, result, condition,
    condition_pages, pages, sections, checks, defects, comments, inspection_notes, findings_summary, match_status, auto_status, confidence,
    match_explanation, candidates, matched_asset_id, matched_asset_version_id, asset_code_snapshot, asset_description_snapshot, asset_location_snapshot)
  SELECT $1, $2, x.seq, x.header, x.description, x.subloc, x.prefix, x.result, x.condition,
    ARRAY(SELECT jsonb_array_elements_text(x.condition_pages)::int), ARRAY(SELECT jsonb_array_elements_text(x.pages)::int),
    ARRAY(SELECT jsonb_array_elements_text(x.sections)), x.checks, x.defects, x.comments, x.inspection_notes, x.findings_summary,
    x.match_status, x.match_status, x.confidence, x.match_explanation, x.candidates, x.matched_asset_id, x.matched_asset_version_id,
    x.asset_code_snapshot, x.asset_description_snapshot, x.asset_location_snapshot
  FROM jsonb_to_recordset($3::jsonb) AS x(seq int, header text, description text, subloc text, prefix text, result text, condition smallint,
    condition_pages jsonb, pages jsonb, sections jsonb, checks jsonb, defects jsonb, comments text, inspection_notes text, findings_summary text,
    match_status text, confidence numeric, match_explanation text, candidates jsonb, matched_asset_id bigint, matched_asset_version_id bigint,
    asset_code_snapshot text, asset_description_snapshot text, asset_location_snapshot text)`;

export async function processInspection(user, file, rawPayload) {
  const version = await activeVersion(user.orgId);
  if (!version) throw conflict('There is no active asset register yet. A Super Admin must upload and publish the master register first.');
  const p = sanitisePayload(rawPayload);
  const settings = await getSettings(user.orgId);
  const ctx = matchContext(settings.matching);

  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const dup = await one(`SELECT id, uploaded_at FROM inspection_reports WHERE organisation_id = $1 AND file_sha256 = $2 AND status = 'processed' ORDER BY uploaded_at DESC LIMIT 1`, [user.orgId, sha]);

  // 1. Report row (+ original PDF) first, so a failure part-way is still visible in the history.
  const report = await tx(async (client) => {
    let fileId = null;
    if (settings.inspections.storeOriginalFiles) {
      fileId = (await client.query(`INSERT INTO stored_files (organisation_id, kind, file_name, mime_type, size_bytes, sha256, data, uploaded_by)
        VALUES ($1, 'inspection', $2, 'application/pdf', $3, $4, $5, $6) RETURNING id`, [user.orgId, s(file.originalname, 255), file.size, sha, file.buffer, user.id])).rows[0].id;
    }
    return (await client.query(`INSERT INTO inspection_reports (organisation_id, register_id, register_version_id, file_id, file_name, file_size, file_sha256,
        page_count, report_ref, site, assessment_date, assessment_date_source, assessment_date_text, meta, warnings, merge_duplicates, uploaded_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
      [user.orgId, version.register_id, version.id, fileId, s(file.originalname, 255), file.size, sha, p.pageCount, p.meta.reportRef, p.meta.site,
        p.meta.dateISO, p.meta.dateSource, p.meta.date, JSON.stringify(p.meta), p.warnings, p.mergeDuplicates, user.id])).rows[0];
  });

  // 2. Match every finding, then store them in one statement.
  try {
    const results = await mapLimit(p.findings, 4, (rec) => matchFinding(version, rec, ctx));
    const rows = p.findings.map((rec, i) => {
      const m = results[i];
      return {
        seq: rec.seq, header: rec.header, description: rec.description, subloc: rec.subloc, prefix: rec.prefix, result: rec.result, condition: rec.condition,
        condition_pages: rec.conditionPages, pages: rec.pages, sections: rec.sections, checks: rec.checks, defects: rec.defects, comments: rec.comments,
        inspection_notes: rec.inspectionNotes, findings_summary: rec.findingsSummary, candidates: m.candidates,
        ...decisionFields(m.status, m.candidates, m.explanation)
      };
    });
    await tx(async (client) => {
      await client.query(FINDINGS_SQL, [user.orgId, report.id, JSON.stringify(rows)]);
      await refreshCounts(client, report.id);
      await client.query(`UPDATE inspection_reports SET status = 'processed', processed_at = now() WHERE id = $1`, [report.id]);
    });
  } catch (err) {
    await query(`UPDATE inspection_reports SET status = 'failed', error = $2 WHERE id = $1`, [report.id, String(err.message).slice(0, 1000)]);
    throw err;
  }
  return { report: await getReport(user.orgId, report.id), duplicateOf: dup ? dup.id : null, versionNo: version.version_no };
}

export async function refreshCounts(client, reportId) {
  await client.query(`UPDATE inspection_reports r SET
      finding_count = c.total, matched_count = c.matched, review_count = c.review, unmatched_count = c.unmatched
    FROM (SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE match_status IN ('match', 'likely', 'confirmed', 'manual'))::int AS matched,
                 count(*) FILTER (WHERE match_status = 'review')::int AS review,
                 count(*) FILTER (WHERE match_status IN ('nomatch', 'rejected'))::int AS unmatched
            FROM inspection_findings WHERE report_id = $1) c
   WHERE r.id = $1`, [reportId]);
}

export async function getReport(orgId, id) {
  const r = await one(`SELECT r.*, u.name AS uploaded_by_name, v.version_no, v.status AS version_status
    FROM inspection_reports r LEFT JOIN users u ON u.id = r.uploaded_by LEFT JOIN register_versions v ON v.id = r.register_version_id
    WHERE r.id = $1 AND r.organisation_id = $2`, [id, orgId]);
  if (!r) throw notFound('Inspection report');
  return r;
}

export async function getFinding(orgId, id) {
  const f = await one(`SELECT f.*, r.register_version_id FROM inspection_findings f JOIN inspection_reports r ON r.id = f.report_id
    WHERE f.id = $1 AND f.organisation_id = $2`, [id, orgId]);
  if (!f) throw notFound('Finding');
  return f;
}

const recOf = (f) => ({ header: f.report_asset_text, prefix: f.prefix, description: f.description, subloc: f.sub_location });

/**
 * Manual correction of a finding. action: confirm | assign | reject | reset
 * Returns { before, after } for the audit trail.
 */
export async function correctFinding(user, findingId, body) {
  const f = await getFinding(user.orgId, findingId);
  const settings = await getSettings(user.orgId);
  const ctx = matchContext(settings.matching);
  const cands = Array.isArray(f.candidates) ? f.candidates : [];
  const note = s(body.note, 1000);
  let fields;
  if (body.action === 'confirm') {
    const chosen = f.matched_asset_version_id ? cands.find((c) => c.assetVersionId === f.matched_asset_version_id) || cands[0] : cands[0];
    if (!chosen) throw badRequest('There is no proposed asset to confirm. Assign one instead.');
    fields = decisionFields('confirmed', cands, 'Match confirmed by ' + user.name + '.', chosen);
  } else if (body.action === 'assign') {
    const av = await one(`SELECT id, asset_id, asset_code, description, location, status, match_tokens FROM asset_versions
      WHERE id = $1 AND organisation_id = $2 AND version_id = $3 AND is_primary`, [Number(body.assetVersionId), user.orgId, f.register_version_id]);
    if (!av) throw badRequest('Choose an asset from the register version used for this report.');
    const chosen = scoreSpecific(recOf(f), av, ctx);
    fields = decisionFields(cands[0] && cands[0].assetVersionId === av.id ? 'confirmed' : 'manual', cands, 'Asset assigned by ' + user.name + '.', chosen);
  } else if (body.action === 'reject') {
    fields = decisionFields('rejected', cands, 'Marked as not in the register by ' + user.name + '.');
  } else if (body.action === 'reset') {
    const st = autoStatus(cands, ctx.S);
    fields = decisionFields(st, cands, explainMatch(st, cands, ctx.S));
  } else throw badRequest('Unknown action.');

  const before = { status: f.match_status, assetCode: f.asset_code_snapshot, confidence: f.confidence == null ? null : Number(f.confidence) };
  await tx(async (client) => {
    await client.query(`UPDATE inspection_findings SET match_status = $2, confidence = $3, match_explanation = $4, matched_asset_id = $5, matched_asset_version_id = $6,
        asset_code_snapshot = $7, asset_description_snapshot = $8, asset_location_snapshot = $9,
        reviewed_by = $10, reviewed_at = now(), review_note = CASE WHEN $11 <> '' THEN $11 ELSE review_note END WHERE id = $1`,
      [f.id, fields.match_status, fields.confidence, fields.match_explanation, fields.matched_asset_id, fields.matched_asset_version_id,
        fields.asset_code_snapshot, fields.asset_description_snapshot, fields.asset_location_snapshot, body.action === 'reset' ? null : user.id, note]);
    await refreshCounts(client, f.report_id);
  });
  return { finding: f, before, after: { status: fields.match_status, assetCode: fields.asset_code_snapshot, confidence: fields.confidence } };
}

// Re-runs automatic matching against the current active register. Reviewer decisions are kept and re-linked by Asset ID.
export async function rematch(user, reportId) {
  const report = await getReport(user.orgId, reportId);
  const version = await activeVersion(user.orgId);
  if (!version) throw conflict('There is no active asset register.');
  const settings = await getSettings(user.orgId);
  const ctx = matchContext(settings.matching);
  const findings = (await query('SELECT * FROM inspection_findings WHERE report_id = $1 ORDER BY seq', [report.id])).rows;
  let relinked = 0; let lost = 0;
  const updates = await mapLimit(findings, 4, async (f) => {
    const m = await matchFinding(version, recOf(f), ctx);
    if (['confirmed', 'manual'].includes(f.match_status) && f.asset_code_snapshot) {
      const av = await one(`SELECT id, asset_id, asset_code, description, location, status, match_tokens FROM asset_versions
        WHERE version_id = $1 AND is_primary AND upper(asset_code) = upper($2)`, [version.id, f.asset_code_snapshot]);
      if (av) { relinked++; return { f, m, fields: decisionFields(f.match_status, m.candidates, f.match_explanation, scoreSpecific(recOf(f), av, ctx)) }; }
      lost++;
      return { f, m, fields: decisionFields('review', m.candidates, `Previously matched to ${f.asset_code_snapshot}, which is not in register version ${version.version_no}. ` + m.explanation) };
    }
    if (f.match_status === 'rejected') return { f, m, fields: decisionFields('rejected', m.candidates, f.match_explanation) };
    return { f, m, fields: decisionFields(m.status, m.candidates, m.explanation) };
  });
  await tx(async (client) => {
    for (const { f, m, fields } of updates) {
      await client.query(`UPDATE inspection_findings SET match_status = $2, auto_status = $3, confidence = $4, match_explanation = $5, candidates = $6,
          matched_asset_id = $7, matched_asset_version_id = $8, asset_code_snapshot = $9, asset_description_snapshot = $10, asset_location_snapshot = $11 WHERE id = $1`,
        [f.id, fields.match_status, m.status, fields.confidence, fields.match_explanation, JSON.stringify(m.candidates), fields.matched_asset_id,
          fields.matched_asset_version_id, fields.asset_code_snapshot, fields.asset_description_snapshot, fields.asset_location_snapshot]);
    }
    await client.query('UPDATE inspection_reports SET register_id = $2, register_version_id = $3 WHERE id = $1', [report.id, version.register_id, version.id]);
    await refreshCounts(client, report.id);
  });
  return { versionNo: version.version_no, findings: findings.length, relinked, lost };
}

export const isAccepted = (st) => ACCEPTED_STATUSES.has(st);
