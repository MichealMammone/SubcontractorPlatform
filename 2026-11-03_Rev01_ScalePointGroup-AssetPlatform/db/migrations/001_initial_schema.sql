-- ============================================================================
-- Scale Point Group - Asset Inspection & Register Management Platform
-- 001  Initial schema (multi-tenant from day one: every business table carries organisation_id)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fast "contains" search over large asset registers

-- ---------------------------------------------------------------------------
-- Tenancy & identity
-- ---------------------------------------------------------------------------
CREATE TABLE organisations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id            smallint PRIMARY KEY,
  key           text NOT NULL UNIQUE,
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  level         integer NOT NULL               -- higher = more privileged; users may only manage lower levels
);

CREATE TABLE permissions (
  key           text PRIMARY KEY,
  category      text NOT NULL,
  description   text NOT NULL
);

CREATE TABLE role_permissions (
  role_id         smallint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key  text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email                text NOT NULL,
  name                 text NOT NULL,
  password_hash        text NOT NULL,
  role_id              smallint NOT NULL REFERENCES roles(id),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  must_change_password boolean NOT NULL DEFAULT false,
  failed_login_count   integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  last_login_ip        text,
  password_changed_at  timestamptz,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX users_org_idx ON users (organisation_id) WHERE deleted_at IS NULL;

CREATE TABLE sessions (
  id              text PRIMARY KEY,               -- SHA-256 of the cookie token; the raw token is never stored
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  csrf_token      text NOT NULL,
  ip              text,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE password_reset_tokens (
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz
);
CREATE INDEX password_reset_user_idx ON password_reset_tokens (user_id);

CREATE TABLE system_settings (
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  key             text NOT NULL,
  value           jsonb NOT NULL,
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, key)
);

-- ---------------------------------------------------------------------------
-- Stored files (original registers and inspection PDFs)
-- ---------------------------------------------------------------------------
CREATE TABLE stored_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('register', 'inspection', 'other')),
  file_name       text NOT NULL,
  mime_type       text NOT NULL,
  size_bytes      bigint NOT NULL,
  sha256          text NOT NULL,
  data            bytea NOT NULL,
  uploaded_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stored_files_org_idx ON stored_files (organisation_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Asset Register Hub
-- ---------------------------------------------------------------------------
CREATE TABLE asset_registers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  active_version_id uuid,                        -- FK added after register_versions exists
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, name)
);

CREATE TABLE register_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  register_id          uuid NOT NULL REFERENCES asset_registers(id) ON DELETE CASCADE,
  version_no           integer NOT NULL,
  status               text NOT NULL CHECK (status IN ('staging', 'pending_approval', 'active', 'archived', 'rejected')),
  based_on_version_id  uuid REFERENCES register_versions(id),   -- active version this upload was compared with
  source_filename      text NOT NULL DEFAULT '',
  source_file_id       uuid REFERENCES stored_files(id) ON DELETE SET NULL,
  sheet_name           text,
  header_row           integer,
  headers              jsonb NOT NULL DEFAULT '[]',
  mapping              jsonb NOT NULL DEFAULT '{}',
  notes                text NOT NULL DEFAULT '',
  asset_count          integer NOT NULL DEFAULT 0,
  rows_received        integer NOT NULL DEFAULT 0,
  change_summary       jsonb,
  token_stats          jsonb,
  uploaded_by          uuid REFERENCES users(id),
  uploaded_at          timestamptz NOT NULL DEFAULT now(),
  submitted_at         timestamptz,
  approved_by          uuid REFERENCES users(id),
  approved_at          timestamptz,
  published_at         timestamptz,
  archived_at          timestamptz,
  rejected_by          uuid REFERENCES users(id),
  rejected_at          timestamptz,
  rejection_reason     text,
  UNIQUE (register_id, version_no)
);
CREATE INDEX register_versions_org_idx ON register_versions (organisation_id, uploaded_at DESC);
ALTER TABLE asset_registers ADD CONSTRAINT asset_registers_active_version_fk
  FOREIGN KEY (active_version_id) REFERENCES register_versions(id) ON DELETE SET NULL;

CREATE TABLE asset_categories (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX asset_categories_unique ON asset_categories (organisation_id, lower(name));

-- Stable asset identity across register versions (keyed by Asset ID within a register)
CREATE TABLE assets (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organisation_id       uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  register_id           uuid NOT NULL REFERENCES asset_registers(id) ON DELETE CASCADE,
  asset_code            text NOT NULL,
  state                 text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  notes                 text NOT NULL DEFAULT '',
  date_added            timestamptz NOT NULL DEFAULT now(),
  first_version_id      uuid REFERENCES register_versions(id) ON DELETE SET NULL,
  last_seen_version_id  uuid REFERENCES register_versions(id) ON DELETE SET NULL,
  archived_at           timestamptz,
  archived_reason       text,
  created_by            uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX assets_code_unique ON assets (register_id, (upper(asset_code)));
CREATE INDEX assets_org_state_idx ON assets (organisation_id, state);

-- One row per asset per register version (immutable once the version is archived)
CREATE TABLE asset_versions (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organisation_id       uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  register_id           uuid NOT NULL REFERENCES asset_registers(id) ON DELETE CASCADE,
  version_id            uuid NOT NULL REFERENCES register_versions(id) ON DELETE CASCADE,
  asset_id              bigint REFERENCES assets(id) ON DELETE SET NULL,
  row_no                integer NOT NULL,
  asset_code            text NOT NULL DEFAULT '',
  description           text NOT NULL DEFAULT '',
  category              text NOT NULL DEFAULT '',
  location              text NOT NULL DEFAULT '',
  location_description  text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT '',
  site                  text NOT NULL DEFAULT '',
  criticality           text NOT NULL DEFAULT '',
  parent_asset          text NOT NULL DEFAULT '',
  alt_id                text NOT NULL DEFAULT '',
  attributes            jsonb NOT NULL DEFAULT '{}',    -- every original column, keyed by heading
  content_hash          text NOT NULL,
  match_tokens          text[] NOT NULL DEFAULT '{}',   -- precomputed matching features
  issues                text[] NOT NULL DEFAULT '{}',   -- data-integrity findings from validation
  is_primary            boolean NOT NULL DEFAULT true,  -- false for duplicates / rows without an Asset ID
  is_archived           boolean NOT NULL DEFAULT false, -- archived manually in Asset Management
  change_type           text NOT NULL DEFAULT 'added' CHECK (change_type IN ('added', 'modified', 'unchanged')),
  last_modified_at      timestamptz NOT NULL DEFAULT now(),
  last_modified_by      uuid REFERENCES users(id)
);
CREATE INDEX asset_versions_version_code_idx ON asset_versions (version_id, (upper(asset_code)));
CREATE INDEX asset_versions_version_primary_idx ON asset_versions (version_id) WHERE is_primary;
CREATE INDEX asset_versions_asset_idx ON asset_versions (asset_id);
CREATE INDEX asset_versions_tokens_idx ON asset_versions USING gin (match_tokens);
CREATE INDEX asset_versions_search_idx ON asset_versions
  USING gin ((asset_code || ' ' || description || ' ' || location) gin_trgm_ops);
CREATE INDEX asset_versions_category_idx ON asset_versions (version_id, category);

-- ---------------------------------------------------------------------------
-- Inspection reports, findings and generated registers
-- ---------------------------------------------------------------------------
CREATE TABLE inspection_reports (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id         uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  register_id             uuid REFERENCES asset_registers(id) ON DELETE SET NULL,
  register_version_id     uuid REFERENCES register_versions(id) ON DELETE SET NULL,
  file_id                 uuid REFERENCES stored_files(id) ON DELETE SET NULL,
  file_name               text NOT NULL,
  file_size               bigint NOT NULL DEFAULT 0,
  file_sha256             text,
  page_count              integer NOT NULL DEFAULT 0,
  report_ref              text NOT NULL DEFAULT '',
  site                    text NOT NULL DEFAULT '',
  assessment_date         date,
  assessment_date_source  text NOT NULL DEFAULT 'not_found' CHECK (assessment_date_source IN ('report', 'first_date', 'manual', 'not_found')),
  assessment_date_text    text NOT NULL DEFAULT '',
  meta                    jsonb NOT NULL DEFAULT '{}',
  warnings                text[] NOT NULL DEFAULT '{}',
  merge_duplicates        boolean NOT NULL DEFAULT true,
  status                  text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'processed', 'failed')),
  error                   text,
  finding_count           integer NOT NULL DEFAULT 0,
  matched_count           integer NOT NULL DEFAULT 0,
  review_count            integer NOT NULL DEFAULT 0,
  unmatched_count         integer NOT NULL DEFAULT 0,
  uploaded_by             uuid REFERENCES users(id),
  uploaded_at             timestamptz NOT NULL DEFAULT now(),
  processed_at            timestamptz
);
CREATE INDEX inspection_reports_org_idx ON inspection_reports (organisation_id, uploaded_at DESC);
CREATE INDEX inspection_reports_search_idx ON inspection_reports USING gin ((file_name || ' ' || report_ref || ' ' || site) gin_trgm_ops);

CREATE TABLE inspection_findings (
  id                           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organisation_id              uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  report_id                    uuid NOT NULL REFERENCES inspection_reports(id) ON DELETE CASCADE,
  seq                          integer NOT NULL,
  report_asset_text            text NOT NULL,
  description                  text NOT NULL DEFAULT '',
  sub_location                 text NOT NULL DEFAULT '',
  prefix                       text NOT NULL DEFAULT '',
  result                       text NOT NULL DEFAULT '',
  condition                    smallint,
  condition_pages              integer[] NOT NULL DEFAULT '{}',
  pages                        integer[] NOT NULL DEFAULT '{}',
  sections                     text[] NOT NULL DEFAULT '{}',
  checks                       jsonb NOT NULL DEFAULT '[]',
  defects                      jsonb NOT NULL DEFAULT '[]',
  comments                     text NOT NULL DEFAULT '',
  inspection_notes             text NOT NULL DEFAULT '',
  findings_summary             text NOT NULL DEFAULT '',
  match_status                 text NOT NULL CHECK (match_status IN ('match', 'likely', 'review', 'nomatch', 'confirmed', 'manual', 'rejected')),
  auto_status                  text NOT NULL DEFAULT 'nomatch',
  confidence                   numeric(5,1),
  match_explanation            text NOT NULL DEFAULT '',
  candidates                   jsonb NOT NULL DEFAULT '[]',
  matched_asset_id             bigint REFERENCES assets(id) ON DELETE SET NULL,
  matched_asset_version_id     bigint REFERENCES asset_versions(id) ON DELETE SET NULL,
  asset_code_snapshot          text NOT NULL DEFAULT '',     -- frozen at match time: history survives later register changes
  asset_description_snapshot   text NOT NULL DEFAULT '',
  asset_location_snapshot      text NOT NULL DEFAULT '',
  reviewed_by                  uuid REFERENCES users(id),
  reviewed_at                  timestamptz,
  review_note                  text NOT NULL DEFAULT ''
);
CREATE INDEX inspection_findings_report_idx ON inspection_findings (report_id, seq);
CREATE INDEX inspection_findings_asset_idx ON inspection_findings (organisation_id, matched_asset_id);
CREATE INDEX inspection_findings_condition_idx ON inspection_findings (organisation_id, condition);

CREATE TABLE generated_reports (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id       uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  inspection_report_id  uuid NOT NULL REFERENCES inspection_reports(id) ON DELETE CASCADE,
  register_version_id   uuid REFERENCES register_versions(id) ON DELETE SET NULL,
  name                  text NOT NULL,
  title                 text NOT NULL,
  prepared_for          text NOT NULL DEFAULT '',
  prepared_by_text      text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  asset_count           integer NOT NULL DEFAULT 0,
  flagged_count         integer NOT NULL DEFAULT 0,
  snapshot              jsonb NOT NULL,                -- frozen rows: re-downloads are identical
  generated_by          uuid REFERENCES users(id),
  generated_at          timestamptz NOT NULL DEFAULT now(),
  approved_by           uuid REFERENCES users(id),
  approved_at           timestamptz,
  view_count            integer NOT NULL DEFAULT 0,
  last_viewed_at        timestamptz
);
CREATE INDEX generated_reports_org_idx ON generated_reports (organisation_id, generated_at DESC);
CREATE INDEX generated_reports_inspection_idx ON generated_reports (inspection_report_id);
CREATE INDEX generated_reports_search_idx ON generated_reports USING gin (name gin_trgm_ops);

CREATE TABLE report_exports (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organisation_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  generated_report_id  uuid NOT NULL REFERENCES generated_reports(id) ON DELETE CASCADE,
  format               text NOT NULL CHECK (format IN ('xlsx', 'csv', 'pdf')),
  file_name            text NOT NULL,
  exported_by          uuid REFERENCES users(id),
  exported_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_exports_report_idx ON report_exports (generated_report_id, exported_at DESC);

-- ---------------------------------------------------------------------------
-- Audit & compliance
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organisation_id  uuid REFERENCES organisations(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  user_email       text NOT NULL DEFAULT '',
  action           text NOT NULL,
  entity_type      text NOT NULL DEFAULT '',
  entity_id        text NOT NULL DEFAULT '',
  summary          text NOT NULL DEFAULT '',
  details          jsonb NOT NULL DEFAULT '{}',
  ip               text,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_time_idx ON audit_logs (organisation_id, created_at DESC);
CREATE INDEX audit_logs_org_action_idx ON audit_logs (organisation_id, action, created_at DESC);
CREATE INDEX audit_logs_user_idx ON audit_logs (user_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (organisation_id, entity_type, entity_id);
