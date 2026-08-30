-- Up Migration
-- Group colour, chosen by the user. Lives on the category so the chips, the pickers,
-- the dashboard breakdown and the P&L all read one source instead of each deriving
-- their own. NULL falls back to the built-in palette, so nothing has to be set.
ALTER TABLE categories ADD COLUMN colour TEXT;

-- Seed the default groups with the palette they already render as, so upgrading
-- changes nothing on screen.
UPDATE categories SET colour = v.colour
FROM (VALUES
  ('Income', '#10b981'), ('Housing', '#6366f1'), ('Utilities', '#06b6d4'),
  ('Food & Drink', '#f97316'), ('Transport', '#3b82f6'), ('Health', '#f43f5e'),
  ('Personal', '#d946ef'), ('Entertainment', '#8b5cf6'), ('Financial', '#14b8a6'),
  ('Children', '#84cc16'), ('Gifts & Charity', '#f59e0b'), ('Other', '#64748b')
) AS v(name, colour)
WHERE categories.name = v.name AND categories.parent_id IS NULL;

-- Down Migration
ALTER TABLE categories DROP COLUMN colour;
