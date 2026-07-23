INSERT INTO notes (id, workspace_id, title, body, created_at, updated_at)
VALUES (:noteId, :partitionId, :title, :body, :now, :now)
RETURNING id, title;
