-- Up Migration
-- 'excluded' — real money movement that is not income or spending: the principal
-- leg of a mortgage repayment, an owner drawing, a reimbursed float. It still moves
-- the account balance and net worth, but never reaches the P&L (which selects on
-- type IN ('income','expense','interest')) and never counts as uncategorised.
ALTER TABLE transactions DROP CONSTRAINT transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('income','expense','transfer','adjustment','interest','excluded'));

-- Down Migration
UPDATE transactions SET type = CASE WHEN amount_cents >= 0 THEN 'income' ELSE 'expense' END
WHERE type = 'excluded';
ALTER TABLE transactions DROP CONSTRAINT transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('income','expense','transfer','adjustment','interest'));
