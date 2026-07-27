-- 0010: EVM wallet as a third lite auth method (login + bind), mirroring btc_wallet.
--
-- An EVM proof is a plain EIP-191 `personal_sign` over our single-use nonce, so it
-- is CHAIN-AGNOSTIC: the same key controls that address on every EVM chain. That is
-- deliberate — the address is an identity binder here, and the same binder is what a
-- Magi account-mapping would later use to let the account hold creator tokens.
--
-- `network` stays informational ('eip155'); nothing keys off it.

DO $$
DECLARE
  c RECORD;
BEGIN
  -- Drop whatever CHECK currently pins the method vocabulary, by definition rather
  -- than by generated name, so this applies cleanly regardless of how 0001 was named.
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'lumen_auth_credential'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%btc_wallet%'
  LOOP
    EXECUTE format('ALTER TABLE lumen_auth_credential DROP CONSTRAINT %I', c.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'lumen_auth_credential'::regclass
      AND conname = 'lumen_auth_credential_method_check'
  ) THEN
    ALTER TABLE lumen_auth_credential
      ADD CONSTRAINT lumen_auth_credential_method_check
      CHECK (method IN ('google_passkey', 'btc_wallet', 'evm_wallet'));
  END IF;
END
$$;
