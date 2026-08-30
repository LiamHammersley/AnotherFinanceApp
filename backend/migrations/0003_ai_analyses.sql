-- Up Migration
CREATE TABLE ai_analyses (
  id UUID PRIMARY KEY,
  months INT NOT NULL,
  model TEXT NOT NULL,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE ai_analyses;
