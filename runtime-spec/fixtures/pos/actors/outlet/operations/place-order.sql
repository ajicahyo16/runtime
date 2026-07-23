INSERT INTO orders (id, outlet_id, total, status, created_at, updated_at)
VALUES (:orderId, :partitionId, :total, 'Confirmed', :now, :now)
RETURNING id, total, status;
