-- Container FAMILIES (2026-09-24, quote reblog spec v2 section 2).
--
-- Until now every container was a "lite" container (`lumen-c-<ulid>`): its depth-1
-- replies are Lumen posts written by lite accounts. Quote reblogs ("reblog with a
-- comment") need a SEPARATE family, `lumen-q-<ulid>`, owned by the same publishing
-- account, because code across the app and recsys treats every child of a `lumen-c-`
-- root as a Lumen post (content.tsx, hafsql.py) and every `lumen-c-` root body says
-- its replies decline rewards. Mixing quotes in would break both.
--
-- Existing rows are all lite containers, so the column defaults to 'lite' and nothing
-- about them changes. The live-container index moves from one live container per
-- account to one live container per (account, family), so a lite container and a
-- quote container can be open at the same time. This file runs inside one
-- transaction (migrate.ts), so there is no moment without a live-container index.

ALTER TABLE lumen_container ADD COLUMN IF NOT EXISTS family TEXT NOT NULL DEFAULT 'lite';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'lumen_container'::regclass AND conname = 'lumen_container_family_check'
  ) THEN
    ALTER TABLE lumen_container
      ADD CONSTRAINT lumen_container_family_check CHECK (family IN ('lite', 'quote'));
  END IF;
END $$;

DROP INDEX IF EXISTS ux_container_live_per_account;
CREATE UNIQUE INDEX IF NOT EXISTS ux_container_live_per_account_family
  ON lumen_container (hive_author, family)
  WHERE status IN ('opening', 'open');
