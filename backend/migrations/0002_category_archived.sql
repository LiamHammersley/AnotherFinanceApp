-- Up Migration
ALTER TABLE categories ADD COLUMN archived BOOLEAN NOT NULL DEFAULT FALSE;

-- Down Migration
ALTER TABLE categories DROP COLUMN archived;
