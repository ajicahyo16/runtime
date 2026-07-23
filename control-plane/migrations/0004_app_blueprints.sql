CREATE TABLE IF NOT EXISTS app_blueprints (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  document TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  updated_by_account_id TEXT NOT NULL
);
