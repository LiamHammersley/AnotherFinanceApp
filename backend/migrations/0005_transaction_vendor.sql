-- Up Migration
-- Cleaned display name, derived from payee at write time. Stored so the list can
-- sort by what it shows; existing rows are backfilled by the API on startup.
ALTER TABLE transactions ADD COLUMN vendor TEXT;
CREATE INDEX idx_tx_vendor ON transactions (vendor);

-- Down Migration
DROP INDEX idx_tx_vendor;
ALTER TABLE transactions DROP COLUMN vendor;
