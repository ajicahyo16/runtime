SELECT id, total, status
FROM orders
WHERE outlet_id = :partitionId
  AND (:cursor IS NULL OR id > :cursor)
ORDER BY id
LIMIT :pageSize;
