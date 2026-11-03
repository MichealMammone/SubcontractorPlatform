// Asset Register Hub: staging uploads, validation, comparison, approval, publishing, rollback and export.
import crypto from 'node:crypto';
import { query, one, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { REGISTER_FIELDS, FIELD_COLUMNS } from '../../shared/register-fields.js';
import { parseSynonyms, registerFeatures, featuresToTokens } from '../../shared/engine.js';
import { getSetting } from './settings.js';

const FIELD_KEYS = REGISTER_FIELDS.map((f) => f.key);
const MAX_VALUE = 1000;
const clean = (v) => {
  if (v == null) return '';
  const s = (v instanceof Date ? v.toISOString().slice(0, 10) : String(v)).replace(/\s+/g, ' ').trim();
  return s.length > MAX_VALUE ? s.slice(0, MAX_VALUE) : s;
};

/* ---------- registers and versions ---------- */
export async function ensureRegister(orgId, userId, client) {
  const c = client || { query };
  const r = await c.query('SELECT * FROM asset_registers WHERE organisation_id = $1 ORDER BY created_at LIMIT 1', [orgId]);
  if (r.rows[0]) return r.rows[0];
  const ins = await c.query(`INSERT INTO asset_registers (organisation_id, name, created_by) VALUES ($1, 'Master Asset Register', $2)
    ON CONFLICT (organisation_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING *`, [orgId, userId]);
  return ins.rows[0];
}

export async function activeVersion(orgId) {
  return one(`SELECT v.* FROM asset_registers g JOIN register_versions v ON v.id = g.active_version_id
               WHERE g.organisation_id = $1 ORDER BY g.created_at LIMIT 1`, [orgId]);
}

export async function getVersion(orgId, id) {
  const v = await one(`SELECT v.*, u.name AS uploaded_by_name, a.name AS approved_by_name, rj.name AS rejected_by_name
    FROM register_versions v LEFT JOIN users u ON u.id = v.uploaded_by LEFT JOIN users a ON a.id = v.approved_by LEFT JOIN users rj ON rj.id = v.rejected_by
    WHERE v.id = $1 AND v.organisation_id = $2`, [id, orgId]);
  if (!v) throw notFound('Register version');
  return v;
}

export async function createStaging(user, input) {
  const headers = Array.isArray(input.headers) ? input.headers.slice(0, 500).map((h, i) => clean(h) || 'Column ' + (i + 1)) : [];
  if (!headers.length) throw badRequest('The register has no column headings.');
  const mapping = {};
  for (const f of REGISTER_FIELDS) {
    const i = input.mapping ? Number(input.mapping[f.key]) : NaN;
    if (Number.isInteger(i) && i >= 0 && i < headers.length) mapping[f.key] = i;
    else if (f.required) throw badRequest(`Map a column to ${f.label}.`);
  }
  return tx(async (client) => {
    const reg = await ensureRegister(user.orgId, user.id, client);
    await client.query('SELECT id FROM asset_registers WHERE id = $1 FOR UPDATE', [reg.id]);
    const busy = await client.query(`SELECT version_no FROM register_versions WHERE register_id = $1 AND status IN ('staging', 'pending_approval')`, [reg.id]);
    if (busy.rowCount) throw conflict(`Version ${busy.rows[0].version_no} is still awaiting approval. Approve or reject it before uploading another register.`);
    const next = (await client.query('SELECT coalesce(max(version_no), 0) + 1 AS n FROM register_versions WHERE register_id = $1', [reg.id])).rows[0].n;
    const v = await client.query(
      `INSERT INTO register_versions (organisation_id, register_id, version_no, status, based_on_version_id, source_filename, sheet_name, header_row, headers, mapping, notes, uploaded_by)
       VALUES ($1, $2, $3, 'staging', $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, version_no`,
      [user.orgId, reg.id, next, reg.active_version_id, clean(input.fileName).slice(0, 255), clean(input.sheetName).slice(0, 120) || null,
        Number.isInteger(input.headerRow) ? input.headerRow : null, JSON.stringify(headers), JSON.stringify(mapping), clean(input.notes).slice(0, 2000), user.id]);
    return v.rows[0];
  });
}

/* ---------- row normalisation ---------- */
export function normaliseRow(raw, mapping, headers, syn) {
  const get = (k) => (mapping[k] != null ? clean(raw[mapping[k]]) : '');
  const row = {};
  FIELD_KEYS.forEach((k) => { row[k] = get(k); });
  const attributes = {};
  headers.forEach((h, i) => { const v = clean(raw[i]); if (v !== '') attributes[h] = v; });
  return finishRow(row, attributes, syn);
}

// Computes validation issues, the content hash and matching tokens for one asset row.
export function finishRow(row, attributes, syn) {
  const issues = [];
  if (!row.assetCode) issues.push('missing_asset_id');
  if (!row.description) issues.push('missing_description');
  if (row.assetCode && /\s/.test(row.assetCode)) issues.push('asset_id_contains_spaces');
  if (row.description && row.description.length >= MAX_VALUE) issues.push('description_truncated');
  const hashInput = JSON.stringify([FIELD_KEYS.map((k) => row[k]), Object.keys(attributes).sort().map((k) => [k, attributes[k]])]);
  const tokens = featuresToTokens(registerFeatures(row, syn));
  return { ...row, attributes, issues, contentHash: crypto.createHash('sha1').update(hashInput).digest('hex'), tokens };
}

const INSERT_ROWS_SQL = `
  INSERT INTO asset_versions (organisation_id, register_id, version_id, row_no, asset_code, description, category, location, location_description,
    status, site, criticality, parent_asset, alt_id, attributes, content_hash, match_tokens, issues, is_primary, last_modified_by, change_type)
  SELECT $1, $2, $3, x.row_no, x.asset_code, x.description, x.category, x.location, x.location_description, x.status, x.site, x.criticality,
         x.parent_asset, x.alt_id, coalesce(x.attributes, '{}'::jsonb), x.content_hash,
         ARRAY(SELECT jsonb_array_elements_text(x.tokens)), ARRAY(SELECT jsonb_array_elements_text(x.issues)),
         x.asset_code <> '', $4, coalesce(x.change_type, 'added')
    FROM jsonb_to_recordset($5::jsonb) AS x(row_no int, asset_code text, description text, category text, location text, location_description text,
         status text, site text, criticality text, parent_asset text, alt_id text, attributes jsonb, content_hash text, tokens jsonb, issues jsonb, change_type text)
  RETURNING id`;

export function rowRecord(r, rowNo, changeType) {
  const rec = { row_no: rowNo, attributes: r.attributes, content_hash: r.contentHash, tokens: r.tokens, issues: r.issues, change_type: changeType };
  Object.entries(FIELD_COLUMNS).forEach(([k, col]) => { rec[col] = r[k] || ''; });
  return rec;
}

export async function insertRows(client, version, records, userId) {
  if (!records.length) return [];
  const r = await client.query(INSERT_ROWS_SQL, [version.organisation_id, version.register_id, version.id, userId, JSON.stringify(records)]);
  return r.rows.map((x) => x.id);
}

export async function addStagingRows(user, versionId, body) {
  const v = await getVersion(user.orgId, versionId);
  if (v.status !== 'staging') throw conflict('This upload is no longer accepting rows.');
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length > 5000) throw badRequest('Send at most 5,000 rows per request.');
  const start = Number.isInteger(body.startRow) ? body.startRow : v.rows_received;
  const syn = parseSynonyms((await getSetting(user.orgId, 'matching')).synonyms);
  const records = [];
  rows.forEach((raw, i) => {
    if (!Array.isArray(raw) || !raw.some((c) => clean(c) !== '')) return;
    const r = normaliseRow(raw, v.mapping, v.headers, syn);
    if (!r.assetCode && !r.description) return;
    records.push(rowRecord(r, start + i + 1, 'added'));
  });
  await tx(async (client) => {
    await insertRows(client, v, records, user.id);
    await client.query('UPDATE register_versions SET rows_received = rows_received + $2 WHERE id = $1', [v.id, records.length]);
  });
  return { accepted: records.length, skipped: rows.length - records.length };
}

/* ---------- comparison ---------- */
const PRIMARY = 'is_primary';
const sameCode = 'upper(o.asset_code) = upper(n.asset_code)';

export async function compareCounts(fromId, toId, client) {
  const c = client || { query };
  if (!fromId) {
    const r = await c.query(`SELECT count(*) FILTER (WHERE ${PRIMARY})::int AS added FROM asset_versions WHERE version_id = $1`, [toId]);
    return { added: r.rows[0].added, removed: 0, modified: 0, descriptionChanged: 0, unchanged: 0, possibleIdChanges: 0 };
  }
  const r = await c.query(`
    SELECT
      (SELECT count(*) FROM asset_versions n WHERE n.version_id = $2 AND n.${PRIMARY}
         AND NOT EXISTS (SELECT 1 FROM asset_versions o WHERE o.version_id = $1 AND o.${PRIMARY} AND ${sameCode}))::int AS added,
      (SELECT count(*) FROM asset_versions o WHERE o.version_id = $1 AND o.${PRIMARY}
         AND NOT EXISTS (SELECT 1 FROM asset_versions n WHERE n.version_id = $2 AND n.${PRIMARY} AND ${sameCode}))::int AS removed,
      (SELECT count(*) FROM asset_versions n JOIN asset_versions o ON o.version_id = $1 AND o.${PRIMARY} AND ${sameCode}
         WHERE n.version_id = $2 AND n.${PRIMARY} AND o.content_hash <> n.content_hash)::int AS modified,
      (SELECT count(*) FROM asset_versions n JOIN asset_versions o ON o.version_id = $1 AND o.${PRIMARY} AND ${sameCode}
         WHERE n.version_id = $2 AND n.${PRIMARY} AND o.description <> n.description)::int AS description_changed,
      (SELECT count(*) FROM asset_versions n JOIN asset_versions o ON o.version_id = $1 AND o.${PRIMARY} AND ${sameCode}
         WHERE n.version_id = $2 AND n.${PRIMARY} AND o.content_hash = n.content_hash)::int AS unchanged`, [fromId, toId]);
  const x = r.rows[0];
  const idc = await c.query(idChangeSql('count(*)::int AS n', ''), [fromId, toId]);
  return { added: x.added, removed: x.removed, modified: x.modified, descriptionChanged: x.description_changed, unchanged: x.unchanged, possibleIdChanges: idc.rows[0].n };
}

// An asset removed and an asset added with the same description and location: probably a renumbered Asset ID.
function idChangeSql(select, tail) {
  return `SELECT ${select} FROM asset_versions n JOIN asset_versions o
      ON o.version_id = $1 AND o.${PRIMARY} AND upper(o.description) = upper(n.description) AND o.location = n.location AND upper(o.asset_code) <> upper(n.asset_code)
    WHERE n.version_id = $2 AND n.${PRIMARY} AND n.description <> ''
      AND NOT EXISTS (SELECT 1 FROM asset_versions x WHERE x.version_id = $1 AND x.${PRIMARY} AND upper(x.asset_code) = upper(n.asset_code))
      AND NOT EXISTS (SELECT 1 FROM asset_versions y WHERE y.version_id = $2 AND y.${PRIMARY} AND upper(y.asset_code) = upper(o.asset_code)) ${tail}`;
}

const ROW_COLS = 'id, asset_id, row_no, asset_code, description, category, location, location_description, status, site, criticality, parent_asset, alt_id, attributes, issues, is_primary, is_archived, change_type';
const shape = (r, p = '') => r && ({
  id: r[p + 'id'], assetId: r[p + 'asset_id'], rowNo: r[p + 'row_no'], assetCode: r[p + 'asset_code'], description: r[p + 'description'], category: r[p + 'category'],
  location: r[p + 'location'], locationDescription: r[p + 'location_description'], status: r[p + 'status'], site: r[p + 'site'], criticality: r[p + 'criticality'],
  parentAsset: r[p + 'parent_asset'], altId: r[p + 'alt_id'], attributes: r[p + 'attributes'], issues: r[p + 'issues'], isPrimary: r[p + 'is_primary'], isArchived: r[p + 'is_archived'], changeType: r[p + 'change_type']
});
const prefixed = (alias, p) => ROW_COLS.split(', ').map((c) => `${alias}.${c} AS ${p}${c}`).join(', ');

function changedFields(a, b) {
  const out = [];
  FIELD_KEYS.forEach((k) => { if ((a[k] || '') !== (b[k] || '')) out.push(k); });
  const keys = new Set([...Object.keys(a.attributes || {}), ...Object.keys(b.attributes || {})]);
  keys.forEach((k) => { if ((a.attributes || {})[k] !== (b.attributes || {})[k]) out.push('attr:' + k); });
  return out;
}

export async function compareList(fromId, toId, type, { limit, offset }) {
  let sql; let params;
  const page = ` LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
  if (type === 'added' && !fromId) {
    sql = `SELECT ${ROW_COLS} FROM asset_versions n WHERE n.version_id = $1 AND n.${PRIMARY} ORDER BY n.row_no` + page;
    params = [toId];
  } else if (type === 'added') {
    sql = `SELECT ${ROW_COLS} FROM asset_versions n WHERE n.version_id = $2 AND n.${PRIMARY}
      AND NOT EXISTS (SELECT 1 FROM asset_versions o WHERE o.version_id = $1 AND o.${PRIMARY} AND ${sameCode}) ORDER BY n.row_no` + page;
    params = [fromId, toId];
  } else if (type === 'removed') {
    if (!fromId) return [];
    sql = `SELECT ${ROW_COLS} FROM asset_versions o WHERE o.version_id = $1 AND o.${PRIMARY}
      AND NOT EXISTS (SELECT 1 FROM asset_versions n WHERE n.version_id = $2 AND n.${PRIMARY} AND ${sameCode}) ORDER BY o.row_no` + page;
    params = [fromId, toId];
  } else if (type === 'modified' || type === 'description') {
    if (!fromId) return [];
    sql = `SELECT ${prefixed('o', 'o_')}, ${prefixed('n', 'n_')} FROM asset_versions n JOIN asset_versions o ON o.version_id = $1 AND o.${PRIMARY} AND ${sameCode}
      WHERE n.version_id = $2 AND n.${PRIMARY} AND ${type === 'modified' ? 'o.content_hash <> n.content_hash' : 'o.description <> n.description'} ORDER BY n.row_no` + page;
    params = [fromId, toId];
    const r = await query(sql, params);
    return r.rows.map((x) => { const before = shape(x, 'o_'); const after = shape(x, 'n_'); return { before, after, changed: changedFields(before, after) }; });
  } else if (type === 'id_changes') {
    if (!fromId) return [];
    const r = await query(idChangeSql(`${prefixed('o', 'o_')}, ${prefixed('n', 'n_')}`, 'ORDER BY n.row_no' + page), [fromId, toId]);
    return r.rows.map((x) => ({ before: shape(x, 'o_'), after: shape(x, 'n_'), changed: ['assetCode'] }));
  } else if (type === 'duplicates') {
    sql = `SELECT ${ROW_COLS} FROM asset_versions WHERE version_id = $1 AND 'duplicate_asset_id' = ANY(issues) ORDER BY upper(asset_code), row_no` + page;
    params = [toId];
  } else if (type === 'issues') {
    sql = `SELECT ${ROW_COLS} FROM asset_versions WHERE version_id = $1 AND cardinality(issues) > 0 ORDER BY row_no` + page;
    params = [toId];
  } else throw badRequest('Unknown change type.');
  const r = await query(sql, params);
  return r.rows.map((x) => shape(x));
}

/* ---------- finalise (validate + compare) ---------- */
export async function finalizeStaging(user, versionId) {
  const v = await getVersion(user.orgId, versionId);
  if (!['staging', 'pending_approval'].includes(v.status)) throw conflict('This version has already been processed.');
  const reg = await one('SELECT * FROM asset_registers WHERE id = $1', [v.register_id]);
  const base = reg.active_version_id;
  return tx(async (client) => {
    await client.query(`UPDATE asset_versions SET is_primary = (asset_code <> ''), issues = array_remove(issues, 'duplicate_asset_id') WHERE version_id = $1`, [v.id]);
    // Duplicate Asset IDs: the first occurrence is kept, later ones are excluded and flagged.
    await client.query(`
      UPDATE asset_versions av SET is_primary = false, issues = array_append(av.issues, 'duplicate_asset_id')
        FROM (SELECT id, row_number() OVER (PARTITION BY upper(asset_code) ORDER BY row_no) AS rn FROM asset_versions WHERE version_id = $1 AND asset_code <> '') d
       WHERE av.id = d.id AND d.rn > 1`, [v.id]);
    await client.query(`
      UPDATE asset_versions av SET issues = array_append(av.issues, 'duplicate_asset_id')
       WHERE av.version_id = $1 AND av.is_primary AND NOT ('duplicate_asset_id' = ANY(av.issues))
         AND EXISTS (SELECT 1 FROM asset_versions d WHERE d.version_id = $1 AND NOT d.is_primary AND upper(d.asset_code) = upper(av.asset_code) AND d.asset_code <> '')`, [v.id]);
    if (base) {
      await client.query(`UPDATE asset_versions n SET change_type = 'added' WHERE n.version_id = $1`, [v.id]);
      await client.query(`
        UPDATE asset_versions n SET change_type = CASE WHEN o.content_hash = n.content_hash THEN 'unchanged' ELSE 'modified' END
          FROM asset_versions o WHERE n.version_id = $1 AND n.is_primary AND o.version_id = $2 AND o.is_primary AND ${sameCode}`, [v.id, base]);
    }
    const counts = await compareCounts(base, v.id, client);
    const q = await client.query(`SELECT count(*) FILTER (WHERE is_primary)::int AS assets, count(*)::int AS rows,
        count(*) FILTER (WHERE 'duplicate_asset_id' = ANY(issues) AND NOT is_primary)::int AS duplicates,
        count(*) FILTER (WHERE cardinality(issues) > 0)::int AS with_issues,
        count(*) FILTER (WHERE 'missing_asset_id' = ANY(issues))::int AS missing_id,
        count(*) FILTER (WHERE 'missing_description' = ANY(issues))::int AS missing_description
      FROM asset_versions WHERE version_id = $1`, [v.id]);
    const stats = await client.query(`SELECT t, count(*)::int AS c FROM asset_versions, unnest(match_tokens) t WHERE version_id = $1 AND is_primary GROUP BY t HAVING count(*) >= 50`, [v.id]);
    const x = q.rows[0];
    if (!x.assets) throw badRequest('No usable assets were found. Check the column mapping and that rows have an Asset ID.');
    const summary = {
      ...counts, totalRows: x.rows, assets: x.assets, duplicates: x.duplicates, rowsWithIssues: x.with_issues,
      missingAssetId: x.missing_id, missingDescription: x.missing_description,
      totalChanged: counts.added + counts.removed + counts.modified, comparedWithVersionId: base
    };
    await client.query(`UPDATE register_versions SET status = 'pending_approval', asset_count = $2, change_summary = $3, token_stats = $4, based_on_version_id = $5, submitted_at = now() WHERE id = $1`,
      [v.id, x.assets, JSON.stringify(summary), JSON.stringify(Object.fromEntries(stats.rows.map((s) => [s.t, s.c]))), base]);
    return summary;
  });
}

/* ---------- publish / restore ---------- */
async function activate(client, reg, version, user, reason) {
  if (reg.active_version_id && reg.active_version_id !== version.id) {
    await client.query(`UPDATE register_versions SET status = 'archived', archived_at = now() WHERE id = $1`, [reg.active_version_id]);
  }
  await client.query(`UPDATE asset_registers SET active_version_id = $2 WHERE id = $1`, [reg.id, version.id]);
  // Stable identities: one assets row per Asset ID, kept across versions.
  await client.query(`
    INSERT INTO assets (organisation_id, register_id, asset_code, first_version_id, last_seen_version_id, created_by)
    SELECT organisation_id, register_id, asset_code, version_id, version_id, $2 FROM asset_versions WHERE version_id = $1 AND is_primary
    ON CONFLICT (register_id, (upper(asset_code))) DO UPDATE SET last_seen_version_id = EXCLUDED.last_seen_version_id, state = 'active', archived_at = NULL, archived_reason = NULL`,
    [version.id, user.id]);
  await client.query(`UPDATE asset_versions av SET asset_id = a.id FROM assets a
    WHERE av.version_id = $1 AND av.is_primary AND a.register_id = av.register_id AND upper(a.asset_code) = upper(av.asset_code)`, [version.id]);
  await client.query(`UPDATE assets a SET state = 'archived', archived_at = now(), archived_reason = 'Manually archived'
    FROM asset_versions av WHERE av.version_id = $1 AND av.asset_id = a.id AND av.is_archived`, [version.id]);
  await client.query(`UPDATE assets a SET state = 'archived', archived_at = now(), archived_reason = $3
    WHERE a.register_id = $2 AND a.state = 'active'
      AND NOT EXISTS (SELECT 1 FROM asset_versions av WHERE av.version_id = $1 AND av.asset_id = a.id AND av.is_primary)`, [version.id, reg.id, reason]);
  await client.query(`INSERT INTO asset_categories (organisation_id, name) SELECT DISTINCT organisation_id, category FROM asset_versions
    WHERE version_id = $1 AND is_primary AND category <> '' ON CONFLICT DO NOTHING`, [version.id]);
}

export async function approveVersion(user, versionId, notes) {
  const regSettings = await getSetting(user.orgId, 'registers');
  return tx(async (client) => {
    const v = (await client.query('SELECT * FROM register_versions WHERE id = $1 AND organisation_id = $2 FOR UPDATE', [versionId, user.orgId])).rows[0];
    if (!v) throw notFound('Register version');
    if (v.status !== 'pending_approval') throw conflict('Only versions awaiting approval can be published.');
    if (regSettings.requireSecondApprover && v.uploaded_by === user.id) throw conflict('A different administrator must approve this upload (second-approver rule).');
    const reg = (await client.query('SELECT * FROM asset_registers WHERE id = $1 FOR UPDATE', [v.register_id])).rows[0];
    if ((reg.active_version_id || null) !== (v.based_on_version_id || null)) throw conflict('The active register changed after this upload was compared. Re-run the comparison before approving.');
    await activate(client, reg, v, user, `Removed in version ${v.version_no}`);
    await client.query(`UPDATE register_versions SET status = 'active', approved_by = $2, approved_at = now(), published_at = now(),
      notes = CASE WHEN $3 <> '' THEN trim(both from notes || E'\\n' || $3) ELSE notes END WHERE id = $1`, [v.id, user.id, notes || '']);
    return v;
  });
}

export async function rejectVersion(user, versionId, reason) {
  return tx(async (client) => {
    const v = (await client.query('SELECT * FROM register_versions WHERE id = $1 AND organisation_id = $2 FOR UPDATE', [versionId, user.orgId])).rows[0];
    if (!v) throw notFound('Register version');
    if (!['staging', 'pending_approval'].includes(v.status)) throw conflict('Only uploads awaiting approval can be rejected.');
    await client.query(`UPDATE register_versions SET status = 'rejected', rejected_by = $2, rejected_at = now(), rejection_reason = $3 WHERE id = $1`, [v.id, user.id, reason || '']);
    await client.query('DELETE FROM asset_versions WHERE version_id = $1', [v.id]); // rejected rows are not register history
    return v;
  });
}

export async function restoreVersion(user, versionId, notes) {
  return tx(async (client) => {
    const v = (await client.query('SELECT * FROM register_versions WHERE id = $1 AND organisation_id = $2 FOR UPDATE', [versionId, user.orgId])).rows[0];
    if (!v) throw notFound('Register version');
    if (v.status !== 'archived') throw conflict('Only archived versions can be restored.');
    const reg = (await client.query('SELECT * FROM asset_registers WHERE id = $1 FOR UPDATE', [v.register_id])).rows[0];
    const pending = await client.query(`SELECT 1 FROM register_versions WHERE register_id = $1 AND status IN ('staging', 'pending_approval')`, [reg.id]);
    if (pending.rowCount) throw conflict('Approve or reject the upload awaiting approval before rolling back.');
    const from = reg.active_version_id;
    await activate(client, reg, v, user, `Not in restored version ${v.version_no}`);
    await client.query(`UPDATE register_versions SET status = 'active', archived_at = NULL, published_at = now(),
      notes = trim(both from notes || E'\\n' || $2) WHERE id = $1`, [v.id, `Restored ${new Date().toISOString().slice(0, 10)} by ${user.name}${notes ? ': ' + notes : ''}`]);
    return { version: v, fromVersionId: from };
  });
}

/* ---------- export ---------- */
export async function* versionRows(versionId, batch = 5000) {
  let after = 0;
  for (;;) {
    const r = await query(`SELECT ${ROW_COLS} FROM asset_versions WHERE version_id = $1 AND is_primary AND row_no > $2 ORDER BY row_no LIMIT $3`, [versionId, after, batch]);
    if (!r.rows.length) return;
    for (const x of r.rows) yield shape(x);
    after = r.rows[r.rows.length - 1].row_no;
    if (r.rows.length < batch) return;
  }
}

// Original headings first (so an export re-imports cleanly), then platform columns.
export function exportHeader(version) {
  return [...(version.headers || []), 'SPG Change Type', 'SPG Issues', 'SPG Archived'];
}
export function exportLine(version, row) {
  const byIndex = {};
  Object.entries(version.mapping || {}).forEach(([field, i]) => { byIndex[i] = row[field]; });
  const cells = (version.headers || []).map((h, i) => (row.attributes && row.attributes[h] != null ? row.attributes[h] : byIndex[i] ?? ''));
  return [...cells, row.changeType, (row.issues || []).join(' '), row.isArchived ? 'Y' : ''];
}
