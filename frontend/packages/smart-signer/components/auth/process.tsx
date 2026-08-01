import { useState, useEffect, useRef, MutableRefObject } from 'react';
import { cookieNamePrefix } from '@smart-signer/lib/session';
import { getCookie } from '@ui/lib/utils';
import { KeyType } from '@smart-signer/types/common';
import { useSignIn } from '@smart-signer/lib/auth/use-sign-in';
import { Signatures, PostLoginSchema } from '@smart-signer/lib/auth/utils';
import { getSigner } from '@smart-signer/lib/signer/get-signer';
import { SignerOptions } from '@smart-signer/lib/signer/signer';
import { useSigner } from '@smart-signer/lib/use-signer';
import { LoginFormSchema as SignInFormSchema } from '../signin-form';
import { getOperationForLogin } from '@smart-signer/lib/login-operation';
import { getChain } from '@transaction/lib/chain';
import { operation } from '@hiveio/wax';

import { getLogger } from '@hive/ui/lib/logging';
const logger = getLogger('app');
export interface LoginFormSchema extends SignInFormSchema {
  keyType: KeyType;
}

export const useProcessAuth = (authenticateOnBackend: boolean, strict: boolean) => {
  const authDataRef = useRef<PostLoginSchema | null>(null) as MutableRefObject<PostLoginSchema | null>;
  const [loginChallenge, setLoginChallenge] = useState('');
  const [isSigned, setIsSigned] = useState(false);
  const { signerOptions } = useSigner();
  const signIn = useSignIn();

  useEffect(() => {
    setLoginChallenge(getCookie(`${cookieNamePrefix}login_challenge`));
  }, []);

  const signAuth = async (data: LoginFormSchema): Promise<void> => {
    // F-L13 — this logged the WHOLE form payload. LoginFormSchema can carry a
    // raw WIF in `password`, so a single login wrote a private key to the app
    // log. Log only the identifying fields.
    const { loginType, username, keyType } = data;
    logger.info('signAuth: %o', { loginType, username, keyType });
    const signatures: Signatures = { posting: '', active: '' };
    let hivesignerToken = '';
    let signInData: PostLoginSchema;

    const loginSignerOptions: SignerOptions = {
      ...signerOptions,
      ...{
        username,
        loginType,
        keyType
      }
    };

    try {
      const hiveChain = await getChain();
      // Read challenge directly from cookie — React state may not have updated yet
      // if signAuth is called early (e.g., biometric auto-unlock on page load).
      const challenge = loginChallenge || getCookie(`${cookieNamePrefix}login_challenge`) || '';
      const operation: operation = await getOperationForLogin(username, keyType, challenge, loginType);

      const expr = new Date();
      expr.setHours(expr.getHours() + 1);
      const txBuilder = await hiveChain.createTransaction(expr);
      txBuilder.pushOperation(operation);
      txBuilder.validate();
      const tx = txBuilder.transaction;

      const signer = getSigner(loginSignerOptions);
      const pack = signer.pack;
      const signature = await signer.signTransaction({
        digest: txBuilder.sigDigest,
        transaction: tx
      });

      // F-L13 — this logged the RAW login signature. That transaction is never
      // broadcast: it is the off-chain auth proof the backend verifies, so the
      // signature IS the credential. It is also now a LIVE path (the Keychain
      // sign-in added 2026-08-01 calls signAuth), which is how it slipped past
      // the sweep that fixed the four signer files.
      logger.info('signAuth produced a signature (%d chars)', signature.length);
      txBuilder.addSignature(signature);
      signatures[keyType] = signature;

      // F-L13 — `addSignature` ran on the line above, so `toApi()` now embeds
      // the login signature; this logged it twice more, in two formats. The
      // pack is the only part with diagnostic value.
      logger.info('signAuth transaction built (pack: %s)', pack);

      signInData = {
        username,
        loginType,
        hivesignerToken,
        keyType,
        txJSON: txBuilder.toApi(),
        pack,
        strict,
        signatures,
        authenticateOnBackend
      };
    } catch (error) {
      logger.error(error, 'onSubmit error in signLoginChallenge');
      return Promise.reject(error);
    }

    authDataRef.current = signInData;

    setIsSigned(true);
    return Promise.resolve();
  };

  const submitAuth = async () => {
    try {
      if (authDataRef.current) {
        // TODO:
        await signIn.mutateAsync({ data: authDataRef.current });
      } else {
        throw new Error('Unexpected error while processing authorization');
      }
    } catch (error: unknown) {
      logger.error(error, 'onSubmit unexpected error');
      throw error;
    } finally {
      authDataRef.current = null;
      setIsSigned(false);
    }
  };

  return {
    signAuth,
    submitAuth,
    isSigned
  };
};
