-- Up Migration
-- What you're trying to achieve with your money, in your own words. The planner
-- reads these, so they are the steering input rather than decoration.
CREATE TABLE budget_goals (
  id UUID PRIMARY KEY,
  text TEXT NOT NULL,
  -- Optional structure, when the goal has a number attached. Both are free to be
  -- NULL: "stop eating out so much" is a legitimate goal with neither.
  target_cents BIGINT,
  by_date DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','dropped')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A generated plan is kept whole, applied or not, so a proposal can be reviewed,
-- part-applied, and compared against what was actually set later.
CREATE TABLE budget_plans (
  id UUID PRIMARY KEY,
  month DATE NOT NULL,
  model TEXT NOT NULL,
  thinking_tokens INT,
  goals JSONB NOT NULL,        -- snapshot: goals change, the plan that used them shouldn't
  summary TEXT,
  proposals JSONB NOT NULL,    -- [{categoryId, name, currentCents, proposedCents, period, reason}]
  applied_at TIMESTAMPTZ,
  applied_ids JSONB,           -- which proposals were actually taken
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX budget_plans_created_idx ON budget_plans (created_at DESC);

-- Down Migration
DROP TABLE budget_plans;
DROP TABLE budget_goals;
