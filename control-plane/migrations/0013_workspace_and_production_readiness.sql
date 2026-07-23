CREATE TABLE workspace_memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES application_users(id),
  role TEXT NOT NULL CHECK(role IN ('owner','admin','developer','operator','viewer')),
  invited_by_user_id TEXT REFERENCES application_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_memberships_user_idx ON workspace_memberships(user_id, updated_at DESC);

CREATE TABLE role_capabilities (
  role TEXT NOT NULL,
  capability TEXT NOT NULL,
  allowed INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (role, capability)
);

INSERT INTO role_capabilities (role, capability) VALUES
  ('owner','workspace.read'),('owner','workspace.settings'),('owner','members.manage'),('owner','build.manage'),
  ('owner','release.manage'),('owner','deploy.dev'),('owner','deploy.staging'),('owner','production.approve'),
  ('owner','deploy.production'),('owner','incidents.manage'),('owner','telemetry.export'),('owner','backup.manage'),
  ('owner','readiness.manage'),
  ('admin','workspace.read'),('admin','workspace.settings'),('admin','members.manage'),('admin','build.manage'),
  ('admin','release.manage'),('admin','deploy.dev'),('admin','deploy.staging'),('admin','incidents.manage'),
  ('admin','telemetry.export'),('admin','backup.manage'),('admin','readiness.manage'),
  ('developer','workspace.read'),('developer','build.manage'),('developer','release.manage'),('developer','deploy.dev'),
  ('operator','workspace.read'),('operator','deploy.staging'),('operator','incidents.manage'),('operator','telemetry.export'),
  ('operator','readiness.manage'),
  ('viewer','workspace.read');

INSERT OR IGNORE INTO workspace_memberships (workspace_id, user_id, role, invited_by_user_id, created_at, updated_at)
SELECT id, owner_user_id, 'owner', NULL, created_at, created_at FROM workspaces WHERE owner_user_id IS NOT NULL;

CREATE TABLE workspace_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('admin','developer','operator','viewer')),
  target_account_id TEXT,
  invited_by_user_id TEXT NOT NULL REFERENCES application_users(id),
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_by_user_id TEXT REFERENCES application_users(id),
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX workspace_invitations_workspace_idx ON workspace_invitations(workspace_id, created_at DESC);

CREATE TABLE onboarding_progress (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  step TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  completed_by_user_id TEXT NOT NULL REFERENCES application_users(id),
  PRIMARY KEY (workspace_id, project_id, step)
);

CREATE TABLE environment_configuration (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  environment TEXT NOT NULL CHECK(environment IN ('dev','staging','production')),
  variables TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by_user_id TEXT NOT NULL REFERENCES application_users(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, project_id, environment)
);

CREATE TABLE environment_secrets (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  environment TEXT NOT NULL CHECK(environment IN ('dev','staging','production')),
  name TEXT NOT NULL,
  value_envelope TEXT NOT NULL,
  rotated_by_user_id TEXT NOT NULL REFERENCES application_users(id),
  rotated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, project_id, environment, name)
);

CREATE TABLE production_governance_policies (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  require_separate_approver INTEGER NOT NULL DEFAULT 0,
  deployment_window_start_hour INTEGER,
  deployment_window_end_hour INTEGER,
  updated_by_user_id TEXT NOT NULL REFERENCES application_users(id),
  updated_at INTEGER NOT NULL
);

CREATE TABLE production_change_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  release_id TEXT NOT NULL REFERENCES releases(id),
  summary TEXT NOT NULL,
  rollback_release_id TEXT REFERENCES releases(id),
  config_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','approved','rejected','deployed','rolled_back')),
  requested_by_user_id TEXT NOT NULL REFERENCES application_users(id),
  approved_by_user_id TEXT REFERENCES application_users(id),
  requested_at INTEGER NOT NULL,
  approved_at INTEGER,
  deployed_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX production_change_release_active_idx
  ON production_change_requests(release_id) WHERE status IN ('draft','approved');

ALTER TABLE release_approvals ADD COLUMN change_request_id TEXT REFERENCES production_change_requests(id);
ALTER TABLE release_approvals ADD COLUMN config_revision INTEGER;

CREATE TABLE deployment_overrides (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  release_id TEXT NOT NULL REFERENCES releases(id),
  reason TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES application_users(id),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE backup_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT REFERENCES projects(id),
  scope TEXT NOT NULL CHECK(scope IN ('control_plane','runtime_partition')),
  environment TEXT,
  partition_hash TEXT,
  provider TEXT NOT NULL,
  bookmark TEXT NOT NULL,
  retention_until INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  verification_status TEXT NOT NULL CHECK(verification_status IN ('pending','verified','failed')),
  created_by_user_id TEXT NOT NULL REFERENCES application_users(id),
  created_at INTEGER NOT NULL,
  verified_at INTEGER
);

CREATE TABLE restore_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  backup_id TEXT NOT NULL REFERENCES backup_records(id),
  target TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('planned','validating','succeeded','failed')),
  integrity_result TEXT,
  requested_by_user_id TEXT NOT NULL REFERENCES application_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE schema_migration_records (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  version TEXT NOT NULL,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('applied','failed','rolled_back')),
  applied_at INTEGER NOT NULL,
  UNIQUE(scope, version)
);

CREATE TABLE service_objectives (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  indicator TEXT NOT NULL,
  target REAL NOT NULL,
  window_days INTEGER NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES application_users(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id, indicator)
);

CREATE TABLE readiness_reviews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  status TEXT NOT NULL CHECK(status IN ('draft','blocked','approved')),
  evidence TEXT NOT NULL,
  critical_open_count INTEGER NOT NULL,
  reviewed_by_user_id TEXT NOT NULL REFERENCES application_users(id),
  reviewed_at INTEGER NOT NULL
);

CREATE TABLE sensitive_action_usage (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES application_users(id),
  action TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id, action, window_started_at)
);
