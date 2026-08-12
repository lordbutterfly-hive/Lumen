'use client';
import { type getSigner } from '@smart-signer/lib/signer/get-signer';
import { useSignerClient } from '@smart-signer/lib/use-signer-client';
import { transactionService } from '@transaction/index';
import { createContext, useContext, ReactNode, useState, useEffect } from 'react';
import { getLogger } from '@hive/ui/lib/logging';

const logger = getLogger('app');

type SignerContextType = {
  signer: ReturnType<typeof getSigner>;
};

export const SignerContext = createContext<SignerContextType | undefined>(undefined);

export const useSignerContext = () => {
  const context = useContext(SignerContext);
  if (!context) {
    throw new Error('useSignerContext must be used within a SignerProvider');
  }
  return context;
};

/**
 * SignerProvider for App Router (uses useSignerClient).
 * Use SignerProvider for Pages Router components.
 */
export const SignerProviderClient = ({ children }: { children: ReactNode }) => {
  const [signer, setSigner] = useState<ReturnType<typeof getSigner> | null>(null);
  const { signerOptions } = useSignerClient();
  useEffect(() => {
    logger.info('Starting SignerProviderClient.useEffect() to setup Signer');
    (async () => {
      if (signerOptions.username !== '') {
        // ★ Loaded here, inside the branch that actually needs it — see the
        // matching comment in signer-provider.tsx (the App Router twin of this
        // file) for why: get-signer.ts's static import pulls in all 7 signer
        // backends and their `@hiveio/wax-signers-*` providers, so a visitor
        // with no username to build a signer for should never pay for it.
        const _getSigner = (await import('@smart-signer/lib/signer/get-signer')).getSigner;
        setSigner(_getSigner(signerOptions));
        transactionService.setSignerOptions(signerOptions);
      } else {
        // F-L12 (App Router twin of signer-provider.tsx): on logout the
        // module-level singleton kept the previous user's signerOptions, and
        // every op this service builds takes its actor from them.
        setSigner(null);
        transactionService.clearSignerOptions();
      }
    })().catch(logger.error);
  }, [signerOptions.username, signerOptions.loginType, signerOptions.keyType]);

  // TODO: Wait for signer to be initialized
  return <SignerContext.Provider value={{ signer: signer! }}>{children}</SignerContext.Provider>;
};
