-- Up Migration
ALTER TABLE ai_analyses ADD COLUMN dismissed_findings TEXT[] NOT NULL DEFAULT '{}';

-- Down Migration
ALTER TABLE ai_analyses DROP COLUMN dismissed_findings;
