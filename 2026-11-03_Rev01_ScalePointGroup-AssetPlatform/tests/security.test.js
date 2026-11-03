import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hashPassword, verifyPassword, passwordProblems, temporaryPassword } from '../src/lib/security.js';
import { csvCell } from '../src/services/exports.js';

test('passwords hash with scrypt and verify', async () => {
  const hash = await hashPassword('Correct-Horse-42');
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyPassword('Correct-Horse-42', hash), true);
  assert.equal(await verifyPassword('correct-horse-42', hash), false);
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
});

test('password policy', () => {
  assert.ok(passwordProblems('short').length);
  assert.ok(passwordProblems('alllowercaseletters').length);
  assert.ok(passwordProblems('Password-12345').length); // common word
  assert.ok(passwordProblems('JaneSmith-2026!', 'janesmith@example.com').length);
  assert.equal(passwordProblems('Tunnel-Deluge-47').length, 0);
});

test('generated temporary passwords satisfy the policy', () => {
  for (let i = 0; i < 50; i++) assert.deepEqual(passwordProblems(temporaryPassword()), []);
});

test('CSV export neutralises spreadsheet formulas', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('-12'), '-12');
  assert.equal(csvCell('a,b'), '"a,b"');
});

test('RBAC matrix: read-only users cannot upload or export; only super admins manage registers', () => {
  const sql = fs.readFileSync(new URL('../db/migrations/002_roles_permissions.sql', import.meta.url), 'utf8');
  const grants = (role) => [...sql.matchAll(new RegExp(`\\(${role}, '([a-z._]+)'\\)`, 'g'))].map((m) => m[1]);
  const readOnly = grants(4); const standard = grants(3); const admin = grants(2);
  assert.ok(readOnly.includes('reports.view') && readOnly.includes('assets.view'));
  ['inspections.upload', 'reports.generate', 'reports.export'].forEach((p) => assert.ok(!readOnly.includes(p), p));
  ['inspections.upload', 'reports.generate', 'reports.export'].forEach((p) => assert.ok(standard.includes(p), p));
  ['registers.upload', 'registers.approve', 'assets.edit', 'audit.view', 'settings.manage', 'users.delete'].forEach((p) => {
    assert.ok(!admin.includes(p) && !standard.includes(p) && !readOnly.includes(p), p);
  });
  assert.ok(admin.includes('users.manage') && admin.includes('reports.approve'));
});
