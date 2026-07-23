SELECT id, name, status
FROM projects
WHERE workspace_id = :partitionId
  AND (:cursor IS NULL OR id > :cursor)
ORDER BY id
LIMIT :pageSize;
