-- Up Migration
-- budget_plans.summary was declared TEXT but has always held serialised JSON, so
-- reading it back gave a string where the app expected an object — which is how the
-- raw payload ended up rendered into the Earlier plans list.
--
-- Converted in place. pg_input_is_valid (PostgreSQL 16+) lets a row that isn't valid
-- JSON survive as a plain summary string instead of failing the whole migration.
ALTER TABLE budget_plans
  ALTER COLUMN summary TYPE JSONB
  USING CASE
    WHEN summary IS NULL THEN NULL
    WHEN pg_input_is_valid(summary, 'jsonb') THEN summary::jsonb
    ELSE jsonb_build_object('summary', summary)
  END;

-- Down Migration
ALTER TABLE budget_plans ALTER COLUMN summary TYPE TEXT USING summary::text;
