-- 0018_client_side_keys.sql — private keys move to the browser, permanently.
--
-- The upgrade flow used to mint a Hive master password ON THE SERVER, encrypt it into
-- `key_reveal`, and send it to the browser in an HTTP response. A master password IS
-- the account's owner key: anyone holding it owns the account for good, and can lock
-- the real owner out beyond recovery. That made us custodians of every account we
-- created, contradicted what the upgrade screen promises the user ("your own keys"),
-- and turned this table into a standing target — server, env file and database backup
-- together were enough to take accounts later.
--
-- Keys are now generated in the user's browser and only the four PUBLIC keys are sent
-- here, so there is nothing left to encrypt or store. The table is dropped rather than
-- left empty: an unused secret store invites a future change to start filling it again.
--
-- What replaces it for robustness. `key_reveal` also solved a real problem — a lost
-- HTTP response used to mean a created account whose keys nobody had. The public
-- owner key does that job now: it is recorded on the upgrade attempt BEFORE the
-- broadcast, so a later attempt can ask the chain "does this account exist, and is its
-- owner key the one this user's browser generated?" and finish the bookkeeping. Public
-- keys are safe to store; that is the whole point of them.
ALTER TABLE upgrade_event ADD COLUMN IF NOT EXISTS owner_public_key TEXT;

DROP TABLE IF EXISTS key_reveal;
