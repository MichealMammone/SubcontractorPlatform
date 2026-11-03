// First-run bootstrap. Creates the organisation, the first Super Admin and (optionally) demo accounts.
// Idempotent: it never changes existing users, so it is safe to run on every start.
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { hashPassword, passwordProblems } from '../src/lib/security.js';

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org';

async function ensureUser(client, orgId, email, name, roleKey, password, mustChange) {
  const exists = await client.query('SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL', [email]);
  if (exists.rowCount) return false;
  const role = await client.query('SELECT id FROM roles WHERE key = $1', [roleKey]);
  await client.query(
    `INSERT INTO users (organisation_id, email, name, password_hash, role_id, must_change_password, password_changed_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [orgId, email.toLowerCase(), name, await hashPassword(password), role.rows[0].id, mustChange]
  );
  return true;
}

async function main() {
  const s = config.seed;
  const client = await pool.connect();
  try {
    const users = await client.query('SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL');
    let org = (await client.query('SELECT id FROM organisations ORDER BY created_at LIMIT 1')).rows[0];
    if (!org) {
      org = (await client.query('INSERT INTO organisations (name, slug) VALUES ($1, $2) RETURNING id', [s.orgName, slugify(s.orgName)])).rows[0];
      console.log(`seed: created organisation "${s.orgName}"`);
    }

    if (users.rows[0].n === 0) {
      if (!s.adminEmail || !s.adminPassword) {
        console.warn('seed: no users exist. Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD and restart to create the first Super Admin.');
      } else {
        const problems = passwordProblems(s.adminPassword, s.adminEmail);
        if (problems.length) throw new Error('SEED_ADMIN_PASSWORD needs ' + problems.join('; '));
        await ensureUser(client, org.id, s.adminEmail, 'Platform Administrator', 'super_admin', s.adminPassword, true);
        console.log(`seed: created Super Admin ${s.adminEmail} (password change required at first login)`);
      }
    }

    if (s.demoUsers) {
      if (!s.demoPassword || passwordProblems(s.demoPassword).length) {
        console.warn('seed: SEED_DEMO_USERS=true but SEED_DEMO_PASSWORD is missing or too weak; demo users skipped.');
      } else {
        const demo = [
          ['demo.superadmin', 'Demo Super Admin', 'super_admin'],
          ['demo.admin', 'Demo Administrator', 'admin'],
          ['demo.user', 'Demo Standard User', 'standard'],
          ['demo.readonly', 'Demo Read Only', 'read_only']
        ];
        for (const [local, name, role] of demo) {
          const email = `${local}@${s.demoDomain}`;
          if (await ensureUser(client, org.id, email, name, role, s.demoPassword, false)) console.log(`seed: created demo user ${email} (${role})`);
        }
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('seed: error:', err.message);
  process.exit(1);
});
