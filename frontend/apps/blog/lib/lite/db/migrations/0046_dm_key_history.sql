-- DM public keys become APPEND-ONLY history.
--
-- WHY. lumen_dm_key had UNIQUE (actor_key) and rotation did UPDATE ... SET
-- public_key = EXCLUDED.public_key, so the previous PUBLIC key was destroyed in
-- place. Every message already records the `recipient_key_version` it was sealed
-- to, so the schema assumed a history that nothing kept.
--
-- Measured on production 2026-09-13: 4 of 17 actors had rotated to version 2,
-- and 9 of 18 messages reference recipient_key_version = 1 -- exactly half the
-- inbox pointing at public keys the table had already overwritten.
--
-- The consequence was asymmetric and avoidable. The person who rotates loses
-- their own history because their PRIVATE key is gone from the browser, and that
-- is inherent to client-held keys. But their counterparty lost it too, purely
-- because the server threw away a PUBLIC key -- something not secret, that the
-- counterparty needed and had every right to still read.
--
-- After this, one side rotating never breaks the other side's copy.
--
-- NOT RECOVERABLE BY THIS MIGRATION, and said plainly: the version-1 public keys
-- that were already overwritten are gone. Those 9 messages stay unreadable. This
-- stops the next ones.

-- The old unique index is what enforced "one row per actor"; the primary key
-- becomes (actor_key, key_version) instead. actor_key is a GENERATED column, so
-- it can be indexed but not written -- inserts keep supplying user_id / hive.
ALTER TABLE lumen_dm_key DROP CONSTRAINT IF EXISTS ux_lumen_dm_key_actor;
DROP INDEX IF EXISTS ux_lumen_dm_key_actor;

CREATE UNIQUE INDEX IF NOT EXISTS ux_lumen_dm_key_actor_version
  ON lumen_dm_key (actor_key, key_version);

-- "Which key is current for this actor" is now a MAX(key_version) question, and
-- this index is what keeps that a single index hit rather than a scan per lookup.
CREATE INDEX IF NOT EXISTS ix_lumen_dm_key_actor_current
  ON lumen_dm_key (actor_key, key_version DESC);
