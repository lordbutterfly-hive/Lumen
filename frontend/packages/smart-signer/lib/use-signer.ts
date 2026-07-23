import { useUser } from '@smart-signer/lib/auth/use-user';
import { SignerOptions } from '@smart-signer/lib/signer/signer';

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
