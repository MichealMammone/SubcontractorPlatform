-- ============================================================================
-- 002  Roles, permissions and the role -> permission matrix (RBAC)
-- Re-runnable: edits here are applied by adding a new migration that updates these rows.
-- ============================================================================

INSERT INTO roles (id, key, name, description, level) VALUES
  (1, 'super_admin', 'Super Admin',   'Full platform access, Asset Register Hub owner, user and settings management.', 100),
  (2, 'admin',       'Administrator', 'Manages standard users, processes and approves inspection reports.',              50),
  (3, 'standard',    'Standard User', 'Uploads inspection reports, generates and exports registers.',                     20),
  (4, 'read_only',   'Read Only',     'Views reports and asset data. No uploads or report generation.',                   10)
ON CONFLICT (id) DO UPDATE SET key = EXCLUDED.key, name = EXCLUDED.name, description = EXCLUDED.description, level = EXCLUDED.level;

INSERT INTO permissions (key, category, description) VALUES
  ('dashboard.view',      'General',     'View the dashboard'),
  ('analytics.view',      'General',     'View the analytics dashboard'),
  ('users.view',          'Users',       'View users and user metrics'),
  ('users.manage',        'Users',       'Create, edit, disable users and reset passwords (lower roles only)'),
  ('users.delete',        'Users',       'Delete users'),
  ('audit.view',          'Compliance',  'View and export audit logs'),
  ('settings.manage',     'Settings',    'Change platform settings'),
  ('registers.view',      'Registers',   'View the Asset Register Hub and versions'),
  ('registers.upload',    'Registers',   'Upload new master registers'),
  ('registers.approve',   'Registers',   'Approve and publish register updates'),
  ('registers.rollback',  'Registers',   'Roll back / restore archived register versions'),
  ('registers.export',    'Registers',   'Export register versions'),
  ('assets.view',         'Assets',      'View and search asset data'),
  ('assets.edit',         'Assets',      'Add, edit, archive, restore and bulk-update assets'),
  ('inspections.view',    'Inspections', 'View inspection reports and findings'),
  ('inspections.upload',  'Inspections', 'Upload inspection reports'),
  ('inspections.review',  'Inspections', 'Correct asset matches and assessment dates'),
  ('reports.view',        'Reports',     'View generated reports'),
  ('reports.generate',    'Reports',     'Generate inspection registers'),
  ('reports.export',      'Reports',     'Export reports to Excel, CSV and PDF'),
  ('reports.approve',     'Reports',     'Approve generated reports for client delivery')
ON CONFLICT (key) DO UPDATE SET category = EXCLUDED.category, description = EXCLUDED.description;

DELETE FROM role_permissions;

-- Super Admin: everything
INSERT INTO role_permissions (role_id, permission_key) SELECT 1, key FROM permissions;

-- Administrator
INSERT INTO role_permissions (role_id, permission_key) VALUES
  (2, 'dashboard.view'), (2, 'analytics.view'), (2, 'users.view'), (2, 'users.manage'),
  (2, 'registers.view'), (2, 'registers.export'), (2, 'assets.view'),
  (2, 'inspections.view'), (2, 'inspections.upload'), (2, 'inspections.review'),
  (2, 'reports.view'), (2, 'reports.generate'), (2, 'reports.export'), (2, 'reports.approve');

-- Standard User
INSERT INTO role_permissions (role_id, permission_key) VALUES
  (3, 'dashboard.view'), (3, 'registers.view'), (3, 'assets.view'),
  (3, 'inspections.view'), (3, 'inspections.upload'), (3, 'inspections.review'),
  (3, 'reports.view'), (3, 'reports.generate'), (3, 'reports.export');

-- Read Only User
INSERT INTO role_permissions (role_id, permission_key) VALUES
  (4, 'dashboard.view'), (4, 'registers.view'), (4, 'assets.view'),
  (4, 'inspections.view'), (4, 'reports.view');
