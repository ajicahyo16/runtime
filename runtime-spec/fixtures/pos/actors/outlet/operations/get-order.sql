SELECT id, total, status
FROM orders
WHERE outlet_id = :partitionId AND id = :orderId;
