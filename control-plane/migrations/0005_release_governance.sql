CREATE TABLE IF NOT EXISTS release_verifications (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id),
  status TEXT NOT NULL CHECK(status IN ('passed', 'failed')),
  checks TEXT NOT NULL,
  verified_by_account_id TEXT NOT NULL,
  verified_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS release_verifications_release_time_idx ON release_verifications(release_id, verified_at DESC);

CREATE TABLE IF NOT EXISTS release_approvals (
  release_id TEXT NOT NULL REFERENCES releases(id),
  account_id TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  PRIMARY KEY (release_id, account_id)
);
