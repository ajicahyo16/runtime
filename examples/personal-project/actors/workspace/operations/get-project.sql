SELECT id, name, description, status
FROM projects
WHERE workspace_id = :partitionId AND id = :projectId;
