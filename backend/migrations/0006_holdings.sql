-- Up Migration
-- Assets and liabilities that aren't bank accounts (super, property, vehicles,
-- investments, private loans) so net worth means net worth, not just cash minus debt.
CREATE TABLE holdings (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('asset','liability')),
  kind TEXT NOT NULL DEFAULT 'other',
  notes TEXT,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Valuations over time: the net worth chart uses the latest value at or before
-- each month end, so a revaluation never rewrites history.
CREATE TABLE holding_values (
  id UUID PRIMARY KEY,
  holding_id UUID NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
  as_of DATE NOT NULL,
  value_cents BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (holding_id, as_of)
);
CREATE INDEX idx_holding_values_lookup ON holding_values (holding_id, as_of DESC);

-- Down Migration
DROP TABLE holding_values;
DROP TABLE holdings;
