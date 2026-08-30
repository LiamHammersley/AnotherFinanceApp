-- Up Migration
-- A friendly name for a recurring entry. `payee` stays the raw bank description
-- because it is the match key refreshRecurring() joins transactions on — the
-- nickname is display only.
ALTER TABLE recurring ADD COLUMN nickname TEXT;

-- Down Migration
ALTER TABLE recurring DROP COLUMN nickname;
