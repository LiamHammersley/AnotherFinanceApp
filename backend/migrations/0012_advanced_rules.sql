-- Up Migration
-- Rules become a named, toggleable set of conditions (all/any) with two actions:
-- assign a category, and/or rename the displayed vendor. The old single
-- match_text + amount range + account columns become the first conditions.
ALTER TABLE rules ADD COLUMN name TEXT;
ALTER TABLE rules ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE rules ADD COLUMN match_all BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE rules ADD COLUMN conditions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE rules ADD COLUMN rename_to TEXT;
-- A rule may now rename without categorising
ALTER TABLE rules ALTER COLUMN category_id DROP NOT NULL;

UPDATE rules SET
  name = match_text,
  conditions =
    jsonb_build_array(jsonb_build_object('field', 'payee', 'op', 'contains', 'value', match_text))
    || CASE
         WHEN min_amount_cents IS NOT NULL AND max_amount_cents IS NOT NULL
           THEN jsonb_build_array(jsonb_build_object('field', 'amount', 'op', 'between',
                  'value', min_amount_cents, 'value2', max_amount_cents))
         WHEN min_amount_cents IS NOT NULL
           THEN jsonb_build_array(jsonb_build_object('field', 'amount', 'op', 'gte', 'value', min_amount_cents))
         WHEN max_amount_cents IS NOT NULL
           THEN jsonb_build_array(jsonb_build_object('field', 'amount', 'op', 'lte', 'value', max_amount_cents))
         ELSE '[]'::jsonb
       END
    || CASE
         WHEN account_id IS NOT NULL
           THEN jsonb_build_array(jsonb_build_object('field', 'account', 'op', 'is', 'value', account_id))
         ELSE '[]'::jsonb
       END;

ALTER TABLE rules DROP COLUMN match_text;
ALTER TABLE rules DROP COLUMN min_amount_cents;
ALTER TABLE rules DROP COLUMN max_amount_cents;
ALTER TABLE rules DROP COLUMN account_id;

-- Down Migration
-- Reconstructs the legacy shape from the conditions a v1 rule could express;
-- anything richer (multiple text conditions, "any" matching, renames) is lost.
ALTER TABLE rules ADD COLUMN match_text TEXT;
ALTER TABLE rules ADD COLUMN min_amount_cents BIGINT;
ALTER TABLE rules ADD COLUMN max_amount_cents BIGINT;
ALTER TABLE rules ADD COLUMN account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

UPDATE rules SET
  match_text = COALESCE((
    SELECT c->>'value' FROM jsonb_array_elements(conditions) c
    WHERE c->>'field' = 'payee' LIMIT 1), name, ''),
  min_amount_cents = (
    SELECT (c->>'value')::bigint FROM jsonb_array_elements(conditions) c
    WHERE c->>'field' = 'amount' AND c->>'op' IN ('gte', 'gt', 'between') LIMIT 1),
  max_amount_cents = (
    SELECT COALESCE(c->>'value2', c->>'value')::bigint FROM jsonb_array_elements(conditions) c
    WHERE c->>'field' = 'amount' AND c->>'op' IN ('lte', 'lt', 'between') LIMIT 1),
  account_id = (
    SELECT (c->>'value')::uuid FROM jsonb_array_elements(conditions) c
    WHERE c->>'field' = 'account' AND c->>'op' = 'is' LIMIT 1);

DELETE FROM rules WHERE category_id IS NULL;
ALTER TABLE rules ALTER COLUMN match_text SET NOT NULL;
ALTER TABLE rules ALTER COLUMN category_id SET NOT NULL;
ALTER TABLE rules DROP COLUMN name;
ALTER TABLE rules DROP COLUMN enabled;
ALTER TABLE rules DROP COLUMN match_all;
ALTER TABLE rules DROP COLUMN conditions;
ALTER TABLE rules DROP COLUMN rename_to;
