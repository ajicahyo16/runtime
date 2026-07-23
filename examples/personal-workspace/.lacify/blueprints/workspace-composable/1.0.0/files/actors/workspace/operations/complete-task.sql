UPDATE tasks
SET completed = 1, updated_at = :now
WHERE workspace_id = :partitionId AND id = :taskId
RETURNING id, title, completed;
