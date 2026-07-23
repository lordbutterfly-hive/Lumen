-- 0008_follow_tombstone.sql — FOLLOW-RECSYS-1 (PRUNED 2026-07-22).
-- Unfollow must EMIT A RETRACTION on the recsys edge feed, not a silent hard-
-- delete, or the recsys graph keeps phantom follow edges — a follow/unfollow
-- churn could then inflate an account's apparent reach. Soft-delete with an
-- `active` flag and bump `seq` on every state change so the delta feed
-- (seq > cursor) re-observes the edge and can add OR remove it.
ALTER TABLE lumen_follow ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
