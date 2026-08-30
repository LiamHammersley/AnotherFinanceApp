-- Up Migration
-- A category marked excluded keeps its transactions out of the P&L and dashboard
-- spending, while they still move account balances and net worth. Setting it on a
-- group excludes every sub-category under it. This is the recurring counterpart to
-- type='excluded': tag the mortgage principal category once and a rule can apply it
-- on every import.
ALTER TABLE categories ADD COLUMN excluded BOOLEAN NOT NULL DEFAULT FALSE;

-- Down Migration
ALTER TABLE categories DROP COLUMN excluded;
