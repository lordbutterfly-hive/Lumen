'use client';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
// Type-only — same reasoning as use-signer.ts's matching comment: this hook is
// called by SignerProviderClient (apps/wallet) on every page.
import type { SignerOptions } from '@smart-signer/lib/signer/signer';

/**
 * Signer hook for App Router (uses useUserClient).
 * Use useSigner for Pages Router components.
 */
export const useSignerClient = () => {
  const { user } = useUserClient();
  const { username, loginType, keyType } = user;
  const signerOptions: SignerOptions = {
    username,
    loginType,
    keyType,
    storageType: 'localStorage',
  };
  return { signerOptions };
};
