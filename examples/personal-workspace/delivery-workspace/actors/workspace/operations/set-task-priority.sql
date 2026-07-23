UPDATE tasks
SET priority = :priority, updated_at = :now
WHERE workspace_id = :partitionId AND id = :taskId
RETURNING id, title, priority;
