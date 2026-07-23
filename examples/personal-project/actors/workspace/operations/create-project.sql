INSERT INTO projects (id, workspace_id, name, description, status, created_at, updated_at)
VALUES (:projectId, :partitionId, :name, :description, 'Active', :now, :now)
RETURNING id, name, description, status;
