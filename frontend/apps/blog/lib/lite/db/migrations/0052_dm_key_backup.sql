-- DM key BACKUP: messaging on every device, not only the one that made the key.
--
-- The private half of a messaging key lives in the browser that made it, so a second
-- device could never read the account's messages. The first device now also uploads a
-- BACKUP of that private key, encrypted on the device before it is sent:
--
--   * a Hive account: a Hive memo to the account's OWN posting public key, so opening it
--     takes the account's posting key (one Keychain approval on a new device);
--   * a wallet account: AES-GCM under a key derived from the wallet's signature over a
--     fixed message, stored only when that wallet signs deterministically.
--
-- The server stores it verbatim and cannot open it. It belongs to one key version, so it
-- sits on that version's row. Opaque, bounded, never logged.
--
-- Numbered 0052, not 0049: main already carries 0049-0051 (quote reblogs, unreleased).
-- Migrations are tracked by file name, so either may deploy first.
ALTER TABLE lumen_dm_key ADD COLUMN IF NOT EXISTS backup TEXT;
ALTER TABLE lumen_dm_key ADD CONSTRAINT ck_dm_key_backup CHECK (backup IS NULL OR length(backup) BETWEEN 1 AND 4096);
