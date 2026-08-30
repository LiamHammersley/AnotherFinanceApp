-- Up Migration
-- A budget is a spending (or earning) target on a category, in force from a given
-- month until superseded. Storing it as a dated series rather than a single mutable
-- number means last month's report doesn't change when you raise this month's target.
--
-- amount_cents NULL means "stop budgeting this category from this month on", which
-- keeps 0 available as a real target ("spend nothing here").
CREATE TABLE budgets (
  id UUID PRIMARY KEY,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  period TEXT NOT NULL DEFAULT 'monthly' CHECK (period IN ('monthly','quarterly','yearly')),
  amount_cents BIGINT CHECK (amount_cents IS NULL OR amount_cents >= 0),
  effective_from DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (category_id, effective_from)
);

CREATE INDEX budgets_category_effective_idx ON budgets (category_id, effective_from DESC);

-- Down Migration
DROP TABLE budgets;
