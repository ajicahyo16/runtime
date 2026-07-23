CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL,
  request_type TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE INDEX approval_requests_by_status
ON approval_requests(queue_id, status, created_at);
