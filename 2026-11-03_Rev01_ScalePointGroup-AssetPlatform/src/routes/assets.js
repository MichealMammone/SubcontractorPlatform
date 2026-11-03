// Asset Management: search, detail with version + inspection history, add, edit, archive, restore, bulk import/update.
import { Router } from 'express';
import { query, one, tx } from '../db.js';
import { ah, str, text, paging, likeTerm, idParam, badRequest, conflict, notFound } from '../lib/http.js';
import { requirePerm } from '../middleware/auth.js';
import { audit, diffFields } from '../services/audit.js';
import { getSetting } from '../services/settings.js';
import { activeVersion, finishRow, rowRecord, insertRows } from '../services/registers.js';
import { parseSynonyms } from '../../shared/engine.js';

const router = Router();
const EDITABLE = ['description', 'category', 'location', 'locationDescription', 'status', 'site', 'criticality', 'parentAsset', 'altId'];
const COL = { description: 'description', category: 'category', location: 'location', locationDescription: 'location_description', status: 'status', site: 'site', criticality: 'criticality', parentAsset: 'parent_asset', altId: 'alt_id' };

async function requireActive(orgId) {
  const v = await activeVersion(orgId);
  if (!v) throw conflict('There is no active asset register yet.');
  return v;
}

const LIST_COLS = `a.id, a.asset_code, a.state, a.notes, a.date_added, a.archived_at, a.archived_reason,
  av.id AS asset_version_id, av.description, av.category, av.location, av.location_description, av.status, av.site, av.criticality, av.last_modified_at, av.is_archived`;

router.get('/', requirePerm('assets.view'), ah(async (req, res) => {
  const v = await activeVersion(req.user.orgId);
  if (!v) return res.json({ assets: [], total: 0, page: 1, pageSize: 50, version: null });
  const { limit, offset, page, pageSize } = paging(req.query, 50);
  const state = ['active', 'archived', 'all'].includes(req.query.state) ? req.query.state : 'active';
  const params = [v.id, v.register_id];
  // Active assets come from the active version; archived ones show their last known snapshot.
  let from = state === 'active'
    ? `FROM asset_versions av JOIN assets a ON a.id = av.asset_id WHERE av.version_id = $1 AND av.register_id = $2 AND av.is_primary AND NOT av.is_archived`
    : `FROM assets a JOIN asset_versions av ON av.asset_id = a.id AND av.version_id = a.last_seen_version_id
       WHERE a.register_id = $2 ${state === 'archived' ? `AND a.state = 'archived'` : ''} AND ($1::uuid IS NOT NULL)`;
  if (req.query.q) { params.push(likeTerm(req.query.q)); from += ` AND (av.asset_code || ' ' || av.description || ' ' || av.location) ILIKE $${params.length}`; }
  if (req.query.category) { params.push(String(req.query.category)); from += ` AND av.category = $${params.length}`; }
  if (req.query.status) { params.push(String(req.query.status)); from += ` AND av.status = $${params.length}`; }
  if (req.query.location) { params.push(likeTerm(req.query.location)); from += ` AND av.location ILIKE $${params.length}`; }
  const total = (await one(`SELECT count(*)::int AS n ${from}`, params)).n;
  const sort = { code: 'a.asset_code', description: 'av.description', modified: 'av.last_modified_at DESC', added: 'a.date_added DESC' }[req.query.sort] || 'av.row_no';
  params.push(limit, offset);
  const r = await query(`SELECT ${LIST_COLS} ${from} ORDER BY ${sort} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ assets: r.rows, total, page, pageSize, version: { id: v.id, versionNo: v.version_no } });
}));

router.get('/categories', requirePerm('assets.view'), ah(async (req, res) => {
  const v = await activeVersion(req.user.orgId);
  if (!v) return res.json({ categories: [], statuses: [] });
  const c = await query(`SELECT category AS name, count(*)::int AS n FROM asset_versions WHERE version_id = $1 AND is_primary AND category <> '' GROUP BY category ORDER BY category`, [v.id]);
  const s = await query(`SELECT status AS name, count(*)::int AS n FROM asset_versions WHERE version_id = $1 AND is_primary AND status <> '' GROUP BY status ORDER BY n DESC`, [v.id]);
  res.json({ categories: c.rows, statuses: s.rows });
}));

router.get('/:id', requirePerm('assets.view'), ah(async (req, res) => {
  const id = idParam(req.params.id, 'Asset');
  const a = await one('SELECT a.*, u.name AS created_by_name FROM assets a LEFT JOIN users u ON u.id = a.created_by WHERE a.id = $1 AND a.organisation_id = $2', [id, req.user.orgId]);
  if (!a) throw notFound('Asset');
  const history = await query(`SELECT av.id, av.version_id, v.version_no, v.status AS version_status, v.published_at, av.change_type, av.description, av.category, av.location,
      av.location_description, av.status, av.site, av.criticality, av.parent_asset, av.alt_id, av.attributes, av.is_archived, av.last_modified_at
    FROM asset_versions av JOIN register_versions v ON v.id = av.version_id WHERE av.asset_id = $1 ORDER BY v.version_no DESC`, [id]);
  const inspections = await query(`SELECT f.id, f.report_id, f.condition, f.result, f.match_status, f.confidence, f.inspection_notes, f.condition_pages, f.pages,
      r.file_name, r.report_ref, r.assessment_date, r.uploaded_at
    FROM inspection_findings f JOIN inspection_reports r ON r.id = f.report_id
    WHERE f.organisation_id = $1 AND f.matched_asset_id = $2 ORDER BY r.assessment_date DESC NULLS LAST, r.uploaded_at DESC LIMIT 100`, [req.user.orgId, id]);
  res.json({ asset: a, current: history.rows[0] || null, history: history.rows, inspections: inspections.rows });
}));

function readFields(body, partial) {
  const out = {};
  EDITABLE.forEach((k) => { if (!partial || body[k] !== undefined) out[k] = str(body[k], { max: 1000, name: k }); });
  if (!partial && !out.description) throw badRequest('Asset Description is required.');
  if (partial && out.description === '') throw badRequest('Asset Description cannot be empty.');
  return out;
}

router.post('/', requirePerm('assets.edit'), ah(async (req, res) => {
  const v = await requireActive(req.user.orgId);
  const assetCode = str(req.body.assetCode, { max: 120, required: true, name: 'Asset ID' });
  const fields = readFields(req.body, false);
  const syn = parseSynonyms((await getSetting(req.user.orgId, 'matching')).synonyms);
  const out = await tx(async (client) => {
    if ((await client.query('SELECT 1 FROM asset_versions WHERE version_id = $1 AND is_primary AND upper(asset_code) = upper($2)', [v.id, assetCode])).rowCount) throw conflict('An asset with that Asset ID already exists.');
    const rowNo = (await client.query('SELECT coalesce(max(row_no), 0) + 1 AS n FROM asset_versions WHERE version_id = $1', [v.id])).rows[0].n;
    const r = finishRow({ assetCode, ...fields }, {}, syn);
    const [avId] = await insertRows(client, v, [rowRecord(r, rowNo, 'added')], req.user.id);
    const a = (await client.query(`INSERT INTO assets (organisation_id, register_id, asset_code, notes, first_version_id, last_seen_version_id, created_by)
      VALUES ($1, $2, $3, $4, $5, $5, $6)
      ON CONFLICT (register_id, (upper(asset_code))) DO UPDATE SET state = 'active', archived_at = NULL, archived_reason = NULL, last_seen_version_id = EXCLUDED.last_seen_version_id
      RETURNING id`, [req.user.orgId, v.register_id, assetCode, text(req.body.notes, { max: 4000 }), v.id, req.user.id])).rows[0];
    await client.query('UPDATE asset_versions SET asset_id = $2 WHERE id = $1', [avId, a.id]);
    await client.query('UPDATE register_versions SET asset_count = asset_count + 1 WHERE id = $1', [v.id]);
    return a;
  });
  await audit(req, 'asset.create', { entityType: 'asset', entityId: out.id, summary: `Added asset ${assetCode}`, details: { assetCode, ...fields } });
  res.status(201).json({ id: out.id });
}));

async function loadCurrent(req, id) {
  const v = await requireActive(req.user.orgId);
  // av.* first: later columns win in the row object, so a.id (not the asset_versions id) ends up in row.id.
  const row = await one(`SELECT av.*, av.id AS av_id, a.id, a.asset_code, a.notes, a.state FROM assets a
    JOIN asset_versions av ON av.asset_id = a.id AND av.version_id = $3 WHERE a.id = $1 AND a.organisation_id = $2`, [id, req.user.orgId, v.id]);
  if (!row) throw notFound('Asset in the active register version');
  return { v, row };
}
const snapshotOf = (row) => ({ description: row.description, category: row.category, location: row.location, locationDescription: row.location_description, status: row.status, site: row.site, criticality: row.criticality, parentAsset: row.parent_asset, altId: row.alt_id });

async function applyEdit(client, row, next, attributes, userId, syn) {
  const r = finishRow({ assetCode: row.asset_code, ...next }, attributes, syn);
  await client.query(`UPDATE asset_versions SET description = $2, category = $3, location = $4, location_description = $5, status = $6, site = $7, criticality = $8,
      parent_asset = $9, alt_id = $10, content_hash = $11, match_tokens = $12, issues = $13, attributes = $14,
      change_type = CASE WHEN change_type = 'added' THEN 'added' ELSE 'modified' END, last_modified_at = now(), last_modified_by = $15 WHERE id = $1`,
    [row.av_id, r.description, r.category, r.location, r.locationDescription, r.status, r.site, r.criticality, r.parentAsset, r.altId, r.contentHash, r.tokens, r.issues, JSON.stringify(attributes), userId]);
}

router.patch('/:id', requirePerm('assets.edit'), ah(async (req, res) => {
  const { row } = await loadCurrent(req, idParam(req.params.id, 'Asset'));
  const before = snapshotOf(row);
  const next = { ...before, ...readFields(req.body, true) };
  const notes = req.body.notes !== undefined ? text(req.body.notes, { max: 4000 }) : row.notes;
  const syn = parseSynonyms((await getSetting(req.user.orgId, 'matching')).synonyms);
  await tx(async (client) => {
    await applyEdit(client, row, next, row.attributes || {}, req.user.id, syn);
    if (notes !== row.notes) await client.query('UPDATE assets SET notes = $2 WHERE id = $1', [row.id, notes]);
  });
  const changes = diffFields({ ...before, notes: row.notes }, { ...next, notes });
  await audit(req, 'asset.update', { entityType: 'asset', entityId: row.id, summary: `Edited asset ${row.asset_code}: ${Object.keys(changes).join(', ') || 'no changes'}`, details: { changes } });
  res.json({ ok: true, changes });
}));

async function setArchived(req, res, archived) {
  const { row } = await loadCurrent(req, idParam(req.params.id, 'Asset'));
  const reason = str(req.body && req.body.reason, { max: 500 });
  await tx(async (client) => {
    await client.query('UPDATE asset_versions SET is_archived = $2, last_modified_at = now(), last_modified_by = $3 WHERE id = $1', [row.av_id, archived, req.user.id]);
    await client.query(`UPDATE assets SET state = $2, archived_at = CASE WHEN $3 THEN now() ELSE NULL END, archived_reason = CASE WHEN $3 THEN $4 ELSE NULL END WHERE id = $1`,
      [row.id, archived ? 'archived' : 'active', archived, reason || 'Manually archived']);
  });
  await audit(req, archived ? 'asset.archive' : 'asset.restore', { entityType: 'asset', entityId: row.id, summary: `${archived ? 'Archived' : 'Restored'} asset ${row.asset_code}${reason ? ': ' + reason : ''}` });
  res.json({ ok: true });
}
router.post('/:id/archive', requirePerm('assets.edit'), ah((req, res) => setArchived(req, res, true)));
router.post('/:id/restore', requirePerm('assets.edit'), ah((req, res) => setArchived(req, res, false)));

// Bulk import / update into the active version. rows: [{ assetCode, description, ... }] (max 2,000 per request).
router.post('/bulk', requirePerm('assets.edit'), ah(async (req, res) => {
  const v = await requireActive(req.user.orgId);
  const mode = req.body.mode === 'update' ? 'update' : 'upsert';
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) throw badRequest('No rows received.');
  if (rows.length > 2000) throw badRequest('Send at most 2,000 rows per request.');
  const syn = parseSynonyms((await getSetting(req.user.orgId, 'matching')).synonyms);
  const result = { added: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
  await tx(async (client) => {
    let rowNo = (await client.query('SELECT coalesce(max(row_no), 0) AS n FROM asset_versions WHERE version_id = $1', [v.id])).rows[0].n;
    for (const [i, input] of rows.entries()) {
      const code = String(input.assetCode || '').trim().slice(0, 120);
      if (!code) { result.skipped++; result.errors.push({ row: i + 1, error: 'Missing Asset ID' }); continue; }
      const cur = (await client.query(`SELECT av.*, av.id AS av_id, a.id, a.asset_code, a.notes FROM asset_versions av JOIN assets a ON a.id = av.asset_id
        WHERE av.version_id = $1 AND av.is_primary AND upper(av.asset_code) = upper($2)`, [v.id, code])).rows[0];
      if (cur) {
        const before = snapshotOf(cur);
        const next = { ...before };
        EDITABLE.forEach((k) => { if (input[k] != null && String(input[k]).trim() !== '') next[k] = String(input[k]).replace(/\s+/g, ' ').trim().slice(0, 1000); });
        if (JSON.stringify(before) === JSON.stringify(next)) { result.unchanged++; continue; }
        await applyEdit(client, cur, next, cur.attributes || {}, req.user.id, syn);
        result.updated++;
      } else if (mode === 'upsert') {
        const fields = {};
        EDITABLE.forEach((k) => { fields[k] = String(input[k] == null ? '' : input[k]).replace(/\s+/g, ' ').trim().slice(0, 1000); });
        if (!fields.description) { result.skipped++; result.errors.push({ row: i + 1, error: 'Missing description for new asset ' + code }); continue; }
        const r = finishRow({ assetCode: code, ...fields }, {}, syn);
        const [avId] = await insertRows(client, v, [rowRecord(r, ++rowNo, 'added')], req.user.id);
        const a = (await client.query(`INSERT INTO assets (organisation_id, register_id, asset_code, first_version_id, last_seen_version_id, created_by)
          VALUES ($1, $2, $3, $4, $4, $5) ON CONFLICT (register_id, (upper(asset_code))) DO UPDATE SET state = 'active', archived_at = NULL, last_seen_version_id = EXCLUDED.last_seen_version_id RETURNING id`,
          [req.user.orgId, v.register_id, code, v.id, req.user.id])).rows[0];
        await client.query('UPDATE asset_versions SET asset_id = $2 WHERE id = $1', [avId, a.id]);
        result.added++;
      } else { result.skipped++; result.errors.push({ row: i + 1, error: 'Asset ' + code + ' is not in the register (update mode)' }); }
    }
    if (result.added) await client.query('UPDATE register_versions SET asset_count = asset_count + $2 WHERE id = $1', [v.id, result.added]);
  });
  result.errors = result.errors.slice(0, 100);
  await audit(req, mode === 'update' ? 'asset.bulk_update' : 'asset.bulk_import', { entityType: 'register_version', entityId: v.id,
    summary: `Bulk ${mode === 'update' ? 'update' : 'import'}: ${result.added} added, ${result.updated} updated, ${result.unchanged} unchanged, ${result.skipped} skipped`, details: { result: { ...result, errors: result.errors.slice(0, 20) } } });
  res.json(result);
}));

export default router;
