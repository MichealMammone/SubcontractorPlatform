// Audit trail. Every security-relevant or data-changing action is written here.
import { query } from '../db.js';
import { clientIp } from '../lib/http.js';

/**
 * audit(req, 'asset.update', { entityType: 'asset', entityId: 12, summary: '...', details: { before, after } }, client?)
 * req may be null for system events; pass `actor` in opts to override the user.
 */
export async function audit(req, action, opts = {}, client = null) {
  const u = opts.actor || (req && req.user) || null;
  const row = [
    opts.orgId || (u && u.orgId) || null,
    u ? u.id : null,
    (u && u.email) || opts.email || '',
    action,
    opts.entityType || '',
    opts.entityId == null ? '' : String(opts.entityId),
    String(opts.summary || '').slice(0, 1000),
    JSON.stringify(opts.details || {}),
    req ? clientIp(req) : null,
    req ? String(req.get('user-agent') || '').slice(0, 300) : null
  ];
  const sql = `INSERT INTO audit_logs (organisation_id, user_id, user_email, action, entity_type, entity_id, summary, details, ip, user_agent)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;
  try {
    await (client || { query }).query(sql, row);
  } catch (err) {
    // Never let an audit write break the user's action outside a transaction, but make it visible.
    console.error('audit: failed to write', action, err.message);
    if (client) throw err;
  }
}

// Field-level difference between two flat objects, for "detailed change record".
export function diffFields(before, after, keys) {
  const out = {};
  (keys || Object.keys({ ...before, ...after })).forEach((k) => {
    const a = before ? before[k] : undefined;
    const b = after ? after[k] : undefined;
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out[k] = { from: a ?? null, to: b ?? null };
  });
  return out;
}
