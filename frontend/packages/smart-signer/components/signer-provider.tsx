import { type getSigner } from '@smart-signer/lib/signer/get-signer';
import { useSigner } from '@smart-signer/lib/use-signer';
import { transactionService } from '@transaction/index';
import { createContext, useContext, ReactNode, useMemo, useState, useEffect } from 'react';
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

export const SignerProvider = ({ children }: { children: ReactNode }) => {
  const [signer, setSigner] = useState<ReturnType<typeof getSigner> | null>(null);
  const { signerOptions, accountTier } = useSigner();
  useEffect(() => {
    logger.info('Starting SignerProvider.useEffect() to setup Signer');
    (async () => {
      // Lite accounts have no Hive key and never sign a chain tx client-side.
      // getSigner() would throw "Invalid loginType" for them; short-circuit
      // before it is ever called. Spec §A.5 (must-fix).
      if (accountTier === 'lite') {
        // F-L12: a lite session has no signer, so drop any identity a previous
        // FULL session left in the module-level singleton. Returning without
        // this kept the old user's signerOptions live for the whole SPA session.
        setSigner(null);
        transactionService.clearSignerOptions();
        return;
      }
      const _getSigner = (await import('@smart-signer/lib/signer/get-signer')).getSigner;
      if (signerOptions.username !== '') {
        setSigner(_getSigner(signerOptions));
        transactionService.setSignerOptions(signerOptions);
      } else {
        // F-L12: logout. Same reason — clear, never leave the previous user.
        setSigner(null);
        transactionService.clearSignerOptions();
      }
    })().catch(logger.error);
  }, [signerOptions.username, signerOptions.loginType, signerOptions.keyType, accountTier]);

  // TODO: Wait for signer to be initialized
  return <SignerContext.Provider value={{ signer: signer! }}>{children}</SignerContext.Provider>;
};
