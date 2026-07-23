SELECT id, title, body
FROM notes
WHERE workspace_id = :partitionId AND id = :noteId;
