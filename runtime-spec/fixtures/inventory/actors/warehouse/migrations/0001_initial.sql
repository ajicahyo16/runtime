CREATE TABLE inventory_items (
  sku TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity_delta INTEGER NOT NULL,
  movement_type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);

CREATE INDEX stock_movements_by_sku
ON stock_movements(sku, occurred_at);
