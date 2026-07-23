-- 0004_rate_limits.sql — Phase 5: per-subject rate counters (anti-Sybil). Spec §H.
-- Fixed-window counters in a shared store (Postgres) so caps hold across app
-- instances and survive deploys — NOT the Altera in-memory Map.

CREATE TABLE IF NOT EXISTS rate_counter (
  subject     TEXT NOT NULL,   -- 'user:{id}' | 'ip:{addr}'
  action      TEXT NOT NULL,   -- 'post' | 'comment' | 'like' | 'signup'
  window_key  TEXT NOT NULL,   -- 'd:2026-07-22' (daily) | 'h:2026-07-22T18' (hourly)
  count       INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (subject, action, window_key)
);

CREATE INDEX IF NOT EXISTS ix_rate_counter_updated ON rate_counter (updated_at);
