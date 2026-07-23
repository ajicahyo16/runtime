ALTER TABLE deployment_jobs ADD COLUMN logs TEXT NOT NULL DEFAULT '[]';

-- `planning` was an abandoned pre-state. Existing jobs become explicitly runnable.
UPDATE deployment_jobs SET status = 'planned' WHERE status = 'planning';
