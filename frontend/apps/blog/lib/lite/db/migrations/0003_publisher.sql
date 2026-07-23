-- 0003_publisher.sql — Phase 4: proxy-post publisher outbox queue. Spec §4/§D.

CREATE TABLE IF NOT EXISTS publish_job (
  job_id           TEXT PRIMARY KEY,                 -- ULID
  post_id          TEXT NOT NULL REFERENCES lumen_post(post_id) ON DELETE CASCADE,
  job_type         TEXT NOT NULL CHECK (job_type IN ('create','update','delete')),
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','holding','publishing','published','failed','rejected')),
  attempts         INT NOT NULL DEFAULT 0,
  max_attempts     INT NOT NULL DEFAULT 5,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at       TIMESTAMPTZ,
  claimed_by       TEXT,
  last_error       TEXT,
  idempotency_key  TEXT NOT NULL UNIQUE,             -- post_id + job_type (+ version); dedupes enqueue
  payload_snapshot JSONB NOT NULL,                   -- exact title/body/tags/footer at enqueue; edits never mutate an in-flight job
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- claimable work, oldest-ready first (worker uses FOR UPDATE SKIP LOCKED)
CREATE INDEX IF NOT EXISTS ix_publish_job_claimable
  ON publish_job (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ix_publish_job_post ON publish_job (post_id);
