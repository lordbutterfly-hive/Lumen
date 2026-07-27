-- 0013: one Bitcoin key = one account.
--
-- Credentials were keyed on the ADDRESS, but one private key produces three
-- standard addresses (legacy, P2SH-SegWit, native SegWit), so the same key could
-- register three separate accounts — a 3x Sybil multiplier invisible to every rate
-- limit, since each address really is a different string.
--
-- The fingerprint is hash160(compressed pubkey), recovered from the signature we
-- already verify (see auth/btc-key-fingerprint.ts). It sits ALONGSIDE external_ref
-- (still the address, still the display/lookup value) so existing rows keep working
-- and older credentials simply have no fingerprint yet.

ALTER TABLE lumen_auth_credential ADD COLUMN IF NOT EXISTS key_fingerprint TEXT;

-- One key, one credential — enforced only where a fingerprint is known, so rows
-- predating this migration are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS ux_credential_key_fingerprint
  ON lumen_auth_credential (method, key_fingerprint)
  WHERE key_fingerprint IS NOT NULL;
