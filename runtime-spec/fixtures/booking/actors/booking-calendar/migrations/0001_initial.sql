CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);

CREATE INDEX bookings_by_calendar_time
ON bookings(calendar_id, starts_at, ends_at);
