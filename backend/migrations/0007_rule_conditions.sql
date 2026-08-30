-- Up Migration
-- Rules can narrow on amount and account, not just payee text. All nullable:
-- a rule with only match_text behaves exactly as before.
ALTER TABLE rules ADD COLUMN min_amount_cents BIGINT;
ALTER TABLE rules ADD COLUMN max_amount_cents BIGINT;
ALTER TABLE rules ADD COLUMN account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;

-- Down Migration
ALTER TABLE rules DROP COLUMN min_amount_cents;
ALTER TABLE rules DROP COLUMN max_amount_cents;
ALTER TABLE rules DROP COLUMN account_id;
