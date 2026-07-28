-- 0020_container_failed.sql — a container root that can never be opened.
--
-- Until now a container could only be 'opening', 'open' or 'closed'. That left no way
-- to say "this one is dead": a root whose broadcast fails permanently (a rotated
-- posting key, a malformed operation, an account restriction) stayed 'opening' forever,
-- and because the worker's wait-for-container path reschedules without consulting the
-- attempt ceiling, every child queued behind it retried every 60 seconds indefinitely
-- while `reserveChildSlot` kept filling the same dead container toward its 1000-child
-- cap. One bad root could hold up a thousand posts with no self-healing.
--
-- 'failed' is excluded from the live partial index below, so retiring one immediately
-- frees the account to open a fresh container on the next post.
DO $$
DECLARE ck_name TEXT;
BEGIN
  SELECT conname INTO ck_name
    FROM pg_constraint
   WHERE conrelid = 'lumen_container'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%status%opening%';
  IF ck_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE lumen_container DROP CONSTRAINT %I', ck_name);
  END IF;
END $$;

ALTER TABLE lumen_container
  ADD CONSTRAINT lumen_container_status_check
  CHECK (status IN ('opening', 'open', 'closed', 'failed'));
