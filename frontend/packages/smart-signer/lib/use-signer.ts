import { useUser } from '@smart-signer/lib/auth/use-user';
// Type-only — see the header comment in signer.ts: this hook is called by
// SignerProvider on every page, so a value import here would statically pull in
// signer.ts's (and transitively wax's) runtime graph for every visitor.
import type { SignerOptions } from '@smart-signer/lib/signer/signer';

export const useSigner = () => {
  const { user } = useUser();
  const { username, loginType, keyType, account_tier } = user;
  const signerOptions: SignerOptions = {
    username,
    loginType,
    keyType,
    storageType: 'localStorage',
  };
  // account_tier is surfaced so consumers (e.g. SignerProvider) can keep lite
  // accounts off the client-side signer axis — they have no Hive key. Spec §A.5.
  return { signerOptions, accountTier: account_tier };
};
