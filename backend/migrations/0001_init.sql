-- Up Migration

CREATE TABLE users (
  id UUID PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE accounts (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('standard','credit_card','mortgage')),
  opening_balance_cents BIGINT NOT NULL DEFAULT 0,
  opening_date DATE NOT NULL,
  colour TEXT NOT NULL DEFAULT '#2563eb',
  icon TEXT NOT NULL DEFAULT 'bank',
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  csv_mapping JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  parent_id UUID REFERENCES categories(id) ON DELETE RESTRICT,
  is_income BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE imports (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id),
  filename TEXT NOT NULL,
  row_count INT NOT NULL,
  duplicates_discarded INT NOT NULL,
  new_count INT NOT NULL,
  rolled_back BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id),
  date DATE NOT NULL,
  payee TEXT NOT NULL,
  -- Signed integer cents: expenses negative, income positive. No floats.
  amount_cents BIGINT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income','expense','transfer','adjustment','interest')),
  category_id UUID REFERENCES categories(id),
  notes TEXT,
  reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  -- 'manual' | 'rule:<name>' | 'ai'
  assign_source TEXT,
  ai_confidence REAL,
  linked_transaction_id UUID REFERENCES transactions(id),
  transfer_group UUID,
  import_id UUID REFERENCES imports(id),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tx_account_date ON transactions (account_id, date);
CREATE INDEX idx_tx_category ON transactions (category_id);
CREATE INDEX idx_tx_import ON transactions (import_id);

CREATE TABLE rules (
  id UUID PRIMARY KEY,
  priority INT NOT NULL,
  match_text TEXT NOT NULL,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recurring (
  id UUID PRIMARY KEY,
  payee TEXT NOT NULL,
  category_id UUID REFERENCES categories(id),
  expected_amount_cents BIGINT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','fortnightly','monthly','quarterly','yearly')),
  last_seen DATE,
  next_due DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dismissed')),
  is_subscription BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  dismissed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  previous JSONB,
  next JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_created ON audit_log (created_at);

CREATE TABLE undo_history (
  id UUID PRIMARY KEY,
  action TEXT NOT NULL,
  description TEXT NOT NULL,
  payload JSONB NOT NULL,
  undone BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_usage (
  id UUID PRIMARY KEY,
  request_type TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INT NOT NULL,
  output_tokens INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Default category set (section 6.2) — a standard personal P&L
WITH parents AS (
  INSERT INTO categories (name, is_income) VALUES
    ('Income', TRUE), ('Housing', FALSE), ('Utilities', FALSE), ('Food & Drink', FALSE),
    ('Transport', FALSE), ('Health', FALSE), ('Personal', FALSE), ('Entertainment', FALSE),
    ('Financial', FALSE), ('Children', FALSE), ('Gifts & Charity', FALSE), ('Other', FALSE)
  RETURNING id, name, is_income
)
INSERT INTO categories (name, parent_id, is_income)
SELECT sub.name, p.id, p.is_income FROM parents p
JOIN LATERAL (
  SELECT unnest(CASE p.name
    WHEN 'Income' THEN ARRAY['Employment','Freelance / Self-employment','Investment Income','Benefits','Other Income']
    WHEN 'Housing' THEN ARRAY['Mortgage / Rent','Buildings Insurance','Ground Rent / Service Charge','Maintenance & Repairs']
    WHEN 'Utilities' THEN ARRAY['Electricity','Gas','Water','Internet','Mobile Phone','TV Licence']
    WHEN 'Food & Drink' THEN ARRAY['Groceries','Eating Out','Coffee & Snacks','Alcohol']
    WHEN 'Transport' THEN ARRAY['Fuel','Public Transport','Car Insurance','Road Tax','MOT & Servicing','Parking']
    WHEN 'Health' THEN ARRAY['Prescriptions','Dental','Optician','Gym & Fitness','Health Insurance']
    WHEN 'Personal' THEN ARRAY['Clothing & Footwear','Haircuts & Grooming','Toiletries']
    WHEN 'Entertainment' THEN ARRAY['Streaming Services','Cinema & Events','Hobbies','Books & Magazines','Games']
    WHEN 'Financial' THEN ARRAY['Credit Card Repayments','Loan Repayments','Savings Transfers','Pension','Bank Charges']
    WHEN 'Children' THEN ARRAY['Childcare','School Fees','Clubs & Activities','Children''s Clothing']
    WHEN 'Gifts & Charity' THEN ARRAY['Gifts','Charitable Donations']
    WHEN 'Other' THEN ARRAY['Uncategorised']
  END) AS name
) sub ON TRUE;

-- Down Migration
DROP TABLE ai_usage, undo_history, audit_log, alerts, recurring, rules, transactions, imports, categories, accounts, settings, sessions, users;
