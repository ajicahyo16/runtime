CREATE TABLE shifts (
  id TEXT PRIMARY KEY,
  outlet_id TEXT NOT NULL,
  status TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  outlet_id TEXT NOT NULL,
  total INTEGER NOT NULL CHECK (total >= 0),
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  outlet_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX orders_by_outlet_and_status
ON orders(outlet_id, status);

CREATE INDEX payments_by_order
ON payments(order_id);
