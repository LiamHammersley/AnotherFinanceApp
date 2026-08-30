-- Up Migration
-- Account cards are dragged into the order you want them on the dashboard.
-- Existing accounts keep the order they were created in.
ALTER TABLE accounts ADD COLUMN sort_order INT NOT NULL DEFAULT 0;

UPDATE accounts a SET sort_order = o.ord - 1
FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS ord FROM accounts) o
WHERE a.id = o.id;

-- Down Migration
ALTER TABLE accounts DROP COLUMN sort_order;
