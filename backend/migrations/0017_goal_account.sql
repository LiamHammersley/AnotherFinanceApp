-- Up Migration
-- A goal can be backed by an account you're already saving into. The account's
-- balance then counts toward the goal, so "needs $X/mo" solves for what's LEFT
-- rather than the whole target — the difference between a goal that's 86% done
-- and one that hasn't started.
ALTER TABLE budget_goals ADD COLUMN account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

-- Down Migration
ALTER TABLE budget_goals DROP COLUMN account_id;
