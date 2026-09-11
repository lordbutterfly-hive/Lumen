-- 0045_offering_descriptions.sql — the long description for one posted service.
--
-- WHY IT IS NOT ON CHAIN. The contract carries exactly ONE free-form buyer-facing
-- string per offering, the title, bounded at MaxOfferTitleLen = 64 BYTES
-- (creator-tokens/core/params.go:156). That bound is not arbitrary: createOffering's
-- measured cost scales with the title, 3,129 RC at 2 characters and 5,693 at 64
-- (lib/vsc/rc-budget.ts:137), about 41 RC per byte. A 100-word description is ~600
-- bytes, so carrying it on chain would cost roughly 25,000 RC per createOffering
-- against 5,693 today, and would need a contract update and a second activation.
--
-- So the chain keeps the IDENTITY (the title, which the anti-rug price band is
-- anchored to, and which every escrow is asked against) and this table keeps the
-- PROSE. Stated plainly because it is a real tradeoff: a description here is not
-- part of the chain record and can be edited after a sale without an on-chain trace.
-- Nothing settles against it — contentHash/answerHash remain the commitments — so it
-- is marketing copy, and it is labelled as the creator's own words wherever it renders.
--
-- KEY. `creator` is the on-chain creator key EXACTLY as the contract stores it: a bare
-- Hive account name, or a full `did:pkh:…` for a wallet identity. Never normalised:
-- an EVM DID is EIP-55 checksummed and the ledger keys on the exact string
-- (lib/lite/wallet/did-pkh.ts's own note on the lowercase bug that read ZERO balance).
-- `offering_id` is the contract's monotone id; ids are never reused, so a row cannot
-- be inherited by a different service. A DELETED offering's row is left in place: the
-- id is dead on chain and can never come back, so the row is unreachable rather than
-- wrong, and keeping it means an accidental Remove does not also destroy the prose.
--
-- Idempotent. Apply on the box BEFORE the build that reads it goes live; the reader
-- degrades to an empty description if the table is absent, so ordering is not fatal.
CREATE TABLE IF NOT EXISTS creator_offering_description (
  creator      TEXT        NOT NULL,
  offering_id  BIGINT      NOT NULL,
  description  TEXT        NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (creator, offering_id)
);

-- The buyer-facing read is "every description for THIS creator", one query per token
-- page, so the primary key's leading column already serves it. No second index.
