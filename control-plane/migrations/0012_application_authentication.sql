CREATE TABLE application_users (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('cloudflare_account')),
  provider_subject TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER,
  UNIQUE(provider, provider_subject)
);

CREATE TABLE application_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES application_users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent_hash TEXT,
  ip_hash TEXT
);

CREATE INDEX application_sessions_user_time_idx
  ON application_sessions(user_id, created_at DESC);

CREATE INDEX application_sessions_expiry_idx
  ON application_sessions(expires_at, revoked_at);

CREATE TABLE uplink_connections (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  account_id TEXT NOT NULL,
  account_name TEXT NOT NULL,
  token_envelope TEXT NOT NULL,
  connected_by_user_id TEXT NOT NULL REFERENCES application_users(id),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE authentication_rate_limits (
  fingerprint TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  failure_count INTEGER NOT NULL,
  blocked_until INTEGER,
  last_failure_at INTEGER NOT NULL
);

CREATE TABLE authentication_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES application_users(id),
  provider_subject_hash TEXT,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'blocked')),
  ip_hash TEXT,
  user_agent_hash TEXT,
  occurred_at INTEGER NOT NULL
);

CREATE INDEX authentication_events_time_idx
  ON authentication_events(occurred_at DESC);

ALTER TABLE workspaces ADD COLUMN owner_user_id TEXT REFERENCES application_users(id);
