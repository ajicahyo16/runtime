SELECT id, title, completed
FROM tasks
WHERE workspace_id = :partitionId
  AND completed = :completed
  AND (:cursor IS NULL OR id > :cursor)
ORDER BY id
LIMIT :pageSize;
