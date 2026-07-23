INSERT INTO tasks (id, workspace_id, title, completed, created_at, updated_at)
VALUES (:taskId, :partitionId, :title, 0, :now, :now)
RETURNING id, title, completed;
