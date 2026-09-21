-- 0048_creator_ask_notes.sql — the buyer's message, attached to one request.
--
-- WHY IT IS NOT ON CHAIN. An escrow carries exactly ONE buyer-written string,
-- `contentHash`, bounded at MaxHashLen = 128 BYTES and forbidden a '|'
-- (creator-tokens/core/params.go:197, core/ask.go). The contract facilitates
-- payment and reputation, not messaging, and the Ask dialog's own reference is
-- deliberately short: `askReference(text)` is "ask-" plus a base-36 31-bit
-- string hash of the trimmed question (ui/token-page/token-page-helpers.ts),
-- so the chain records a RECEIPT for the text, never the text. Until this
-- table the text was then thrown away on the client, and the creator received
-- a paid request with no idea what was being asked.
--
-- WHY THE REFERENCE IS ENOUGH TO TRUST THE TEXT. The write path refuses any
-- note whose `askReferenceOf(text)` is not exactly the `content_hash` it is
-- filed under (lib/meritum/ask-note.ts, the same hash the dialog computes). So
-- a row here is verifiable against the chain: read the escrow's contentHash,
-- hash the note, compare. It is a weak (31-bit, non-cryptographic) digest, so
-- this is not a proof of authorship — it is the guarantee that the text shown
-- is the text the reference was minted from, which is the thing a creator
-- needs. Nothing settles against it: payment, answer and rating remain
-- chain-only. Stated plainly: a Lumen outage loses the message, never the
-- money.
--
-- KEYS. `creator` and `asker` are the on-chain account ids EXACTLY as the
-- contract keys them — `hive:<name>` for a Hive account, a full `did:pkh:…`
-- for a wallet identity (lib/vsc/reads.ts toDid). Never normalised beyond that
-- prefix: an EVM DID is EIP-55 checksummed and the ledger keys on the exact
-- string. NOTE this differs from creator_offering_description (0045), which
-- keys a Hive creator by the BARE name; a reader of both must convert, and the
-- ask-note route accepts either form and stores the contract form.
--
-- `content_hash` is the escrow's own reference, so (creator, content_hash) is
-- the pair the creator's inbox and the buyer's list already hold — no seq is
-- needed, and a note can be filed the moment the escrow is confirmed without a
-- second chain read for the seq. Two buyers asking one creator the identical
-- question share a reference and therefore a row: the write keeps the FIRST
-- asker and refuses a different one, so a row's `asker` is never rewritten.
--
-- BOUNDED. `text` is capped by the write path at MAX_ASK_NOTE_CHARS (2000)
-- UTF-16 units and refused for control characters other than newline/tab.
--
-- Idempotent. Apply on the box BEFORE the build that reads it goes live; both
-- the reader and the writer degrade honestly if the table is absent (the read
-- answers `unavailable: true`, the write answers 502 and the ask itself is
-- unaffected), so ordering is not fatal, but a note posted before the table
-- exists is lost.
CREATE TABLE IF NOT EXISTS creator_ask_note (
  creator       TEXT        NOT NULL,
  content_hash  TEXT        NOT NULL,
  asker         TEXT        NOT NULL,
  text          TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (creator, content_hash)
);

-- Both reads are "these hashes for THIS creator" (the Studio inbox and the
-- buyer's own list both know the creator), so the primary key's leading column
-- serves them. No second index.
