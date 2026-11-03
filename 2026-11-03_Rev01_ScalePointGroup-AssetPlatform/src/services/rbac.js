// Role -> permission matrix, loaded from the database once and cached.
import { query } from '../db.js';

let roles = null; // Map roleId -> { id, key, name, level, permissions: Set }

export async function loadRoles(force = false) {
  if (roles && !force) return roles;
  const r = await query('SELECT id, key, name, description, level FROM roles ORDER BY level DESC');
  const p = await query('SELECT role_id, permission_key FROM role_permissions');
  const map = new Map();
  r.rows.forEach((row) => map.set(row.id, { ...row, permissions: new Set() }));
  p.rows.forEach((row) => { const role = map.get(row.role_id); if (role) role.permissions.add(row.permission_key); });
  roles = map;
  return roles;
}

export async function roleById(id) { return (await loadRoles()).get(id) || null; }
export async function roleByKey(key) { for (const r of (await loadRoles()).values()) if (r.key === key) return r; return null; }
export async function listRoles() {
  return [...(await loadRoles()).values()].map((r) => ({ id: r.id, key: r.key, name: r.name, description: r.description, level: r.level, permissions: [...r.permissions].sort() }));
}

export const can = (user, perm) => !!(user && user.permissions && user.permissions.has(perm));
