-- 0041_dm_unread_index.sql — partial index for the DM unread hot path.
--
-- countUnreadForActor / markReadForActor / unreadSendersForActor all filter
-- `read_at IS NULL` joined to the caller's threads, and they run on EVERY signed-in
-- bell fetch (notifications route) plus the Studio unread poll. Migration 0040's only
-- message index is (thread_id, message_id DESC), which does not cover `read_at IS NULL`,
-- so those queries scanned every message in the caller's threads and filtered read_at in
-- the heap — a cost that grows with total message history forever, capped output rows
-- (LIMIT 10) notwithstanding.
--
-- This PARTIAL index keeps all three O(unread): it only holds rows still unread, so it
-- stays tiny (read messages fall out of it) and directly serves the thread-scoped,
-- newest-first unread lookups. Idempotent.
CREATE INDEX IF NOT EXISTS ix_lumen_dm_message_unread
  ON lumen_dm_message (thread_id, sender_key, message_id DESC)
  WHERE read_at IS NULL;
