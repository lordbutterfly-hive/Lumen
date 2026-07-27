-- 0012: edit/delete state + a FAIR publish queue.
--
-- Everything here answers a specific failure the adversarial review proved, so the
-- reasons are recorded next to the columns:
--
-- * last_publish_at — the publish queue was strict FIFO, so one user posting 50
--   times delayed every other user by minutes. A recomputed rank/ROW_NUMBER() does
--   NOT fix it: `FOR UPDATE` is illegal alongside a window function, the CTE
--   workaround locks the ENTIRE pending queue (serialising all workers), and even a
--   valid rank query re-computes after every single claim, so the heavy user's next
--   job immediately wins again. Fair round-robin needs PERSISTED per-user state —
--   this column — ordered ASC so whoever published least recently goes first.
--
-- * edit_version — each edit needs a distinct idempotency key (so a later edit is
--   never swallowed as a duplicate) while rapid edits still collapse into one
--   pending job.
--
-- * deleted_at — a deleted post must refuse further edits, and delete needs its own
--   state separate from `deleted_locally`.

ALTER TABLE lumen_user ADD COLUMN IF NOT EXISTS last_publish_at TIMESTAMPTZ;
ALTER TABLE lumen_post ADD COLUMN IF NOT EXISTS edit_version INT NOT NULL DEFAULT 0;
ALTER TABLE lumen_post ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- The claim query joins job -> post -> user and filters on status; this supports it.
CREATE INDEX IF NOT EXISTS ix_publish_job_pending_post
  ON publish_job (post_id) WHERE status = 'pending';

-- Reaping stuck jobs scans by claimed_at within one status.
CREATE INDEX IF NOT EXISTS ix_publish_job_publishing
  ON publish_job (claimed_at) WHERE status = 'publishing';
