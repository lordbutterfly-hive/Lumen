-- 0040_direct_messages.sql — end-to-end encrypted direct messages, for both account tiers.
--
-- ★★★ THE SERVER STORES CIPHERTEXT, NEVER PLAINTEXT. This is the whole reason the
-- feature is off-chain rather than a Hive encrypted memo (which is Hive-key-only, so a
-- lite Google/BTC/EVM account could never send one). A NEW Lumen-native X25519
-- messaging keypair is generated IN THE BROWSER per identity; only the PUBLIC key ever
-- reaches this database (`lumen_dm_key`), exactly as migration 0018 established for the
-- account keys — "a server that mints/receives/logs/stores it can take the account
-- later." Message bodies are XChaCha20-Poly1305 AEAD ciphertext produced and consumed
-- client-side; the columns below hold opaque bytes the server never decodes. There is
-- no plaintext column, on purpose: an empty one invites a future change to start
-- filling it.
--
-- IDENTITY MODEL — copied from `0017_follow_actors.sql` / `0030_block.sql`, because a
-- conversation has the same two-tier problem a follow/block edge does:
--
--   * Each participant is EITHER a Lumen user id OR a Hive account name, exactly one.
--   * A Lumen user is keyed by `user_id`, which survives an upgrade to a real Hive
--     account, so a thread written before the upgrade still resolves afterwards.
--   * `actor_key` ('u:<id>' / 'h:<name>') is the single stable node id every lookup,
--     the thread's sorted pair and the participant gate all key on — the SAME shape
--     `social/follow-actor.ts:actorKey()` produces, so the read and write sides can
--     never drift.
--
-- THREE TABLES:
--   lumen_dm_key     — one registered PUBLIC key per identity (rotate bumps version).
--   lumen_dm_thread  — one row per unordered pair, sorted so (A,B) and (B,A) collapse.
--   lumen_dm_message — one ciphertext + nonce per message, verbatim.

-- ── keys ─────────────────────────────────────────────────────────────────────
-- Only the PUBLIC key. `key_version` lets a counterparty pin which key a message was
-- encrypted to, so a rotation does not silently orphan in-flight ciphertext.
CREATE TABLE IF NOT EXISTS lumen_dm_key (
  user_id     TEXT REFERENCES lumen_user(user_id) ON DELETE CASCADE,
  hive        CITEXT,
  public_key  TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One stable node id, so every lookup and the ON CONFLICT arbiter key on a single
  -- value regardless of which tier the actor is (mirrors lumen_block's generated keys).
  actor_key TEXT
    GENERATED ALWAYS AS (COALESCE('u:' || user_id, 'h:' || lower(hive::text))) STORED,

  -- Exactly one identity, and a non-empty, bounded public key (a 32-byte X25519 key is
  -- ~44 base64 / 64 hex chars; 256 leaves headroom without inviting a blob).
  CONSTRAINT ck_dm_key_one_actor CHECK ((user_id IS NULL) <> (hive IS NULL)),
  CONSTRAINT ck_dm_key_public    CHECK (length(public_key) BETWEEN 1 AND 256)
);
-- Unique on the generated key = the arbiter for `ON CONFLICT (actor_key)` (same
-- technique lumen_block uses for `ON CONFLICT (blocker_key, blocked_key)`).
CREATE UNIQUE INDEX IF NOT EXISTS ux_lumen_dm_key_actor ON lumen_dm_key (actor_key);

-- ── threads ──────────────────────────────────────────────────────────────────
-- One row per unordered pair. The two keys are stored SORTED (a < b), so the same two
-- people always map to one thread no matter who wrote first. `requester_key` is the
-- side that opened a 'request', so a reply FROM THE OTHER SIDE can promote it to
-- 'open' — the Instagram/Twitter message-request pattern (a stranger's first DM waits
-- as a request until the recipient answers).
CREATE TABLE IF NOT EXISTS lumen_dm_thread (
  thread_id       TEXT PRIMARY KEY,
  actor_a_key     TEXT NOT NULL,
  actor_b_key     TEXT NOT NULL,
  requester_key   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'request',
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Sorted pair (strict <) canonicalises (A,B)/(B,A) AND forbids a self-thread in one
  -- constraint; the service rejects self-DM before it ever gets here too.
  CONSTRAINT ck_dm_thread_sorted    CHECK (actor_a_key < actor_b_key),
  CONSTRAINT ck_dm_thread_status    CHECK (status IN ('request', 'open')),
  CONSTRAINT ck_dm_thread_requester CHECK (requester_key IN (actor_a_key, actor_b_key))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_lumen_dm_thread_pair
  ON lumen_dm_thread (actor_a_key, actor_b_key);
-- A participant's inbox is "every thread naming my key, newest first" — one index per
-- side so either position is served without a scan.
CREATE INDEX IF NOT EXISTS ix_lumen_dm_thread_a
  ON lumen_dm_thread (actor_a_key, last_message_at DESC);
CREATE INDEX IF NOT EXISTS ix_lumen_dm_thread_b
  ON lumen_dm_thread (actor_b_key, last_message_at DESC);

-- ── messages ─────────────────────────────────────────────────────────────────
-- `nonce` and `ciphertext` are OPAQUE BYTES. The server writes and reads them verbatim
-- and never decodes them; decryption happens only in the browser that holds the
-- private key. `sender_key_version` / `recipient_key_version` pin which registered
-- public keys the ciphertext was sealed for, so a later rotation stays decryptable.
CREATE TABLE IF NOT EXISTS lumen_dm_message (
  message_id            TEXT PRIMARY KEY,
  thread_id             TEXT NOT NULL REFERENCES lumen_dm_thread(thread_id) ON DELETE CASCADE,
  sender_key            TEXT NOT NULL,
  nonce                 BYTEA NOT NULL,
  ciphertext            BYTEA NOT NULL,
  sender_key_version    INTEGER NOT NULL,
  recipient_key_version INTEGER NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at               TIMESTAMPTZ,

  -- Defence in depth: the API caps ciphertext at 16 KiB before it ever reaches here,
  -- and the DB refuses anything larger (or empty) independently. The nonce for
  -- XChaCha20-Poly1305 is 24 bytes; bounded generously rather than pinned so the crypto
  -- lane can adjust without a migration.
  CONSTRAINT ck_dm_message_ciphertext CHECK (octet_length(ciphertext) BETWEEN 1 AND 16384),
  CONSTRAINT ck_dm_message_nonce      CHECK (octet_length(nonce) BETWEEN 1 AND 64)
);
-- message_id is a ULID (time-sortable), so DESC on it is newest-first AND the pagination
-- cursor (`message_id < $before`) at once — no separate created_at ordering needed.
CREATE INDEX IF NOT EXISTS ix_lumen_dm_message_thread
  ON lumen_dm_message (thread_id, message_id DESC);
