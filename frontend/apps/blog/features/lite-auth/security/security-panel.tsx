'use client';

import { FC, useCallback, useEffect, useState } from 'react';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import {
  bindGoogle,
  bindWallet,
  fetchAuthMethods,
  requestStepUp,
  type LiteAuthMethod,
  type LiteAuthMethodName
} from '@/blog/lib/lite/client/lite-security';
import {
  connectWallet,
  signMessageWith,
  walletConnectAvailable,
  walletErrorMessage,
  isTaprootAddress,
  type WalletChain
} from '../wallet/appkit';
import GoogleSignIn, { googleConfigured } from '../login/google-signin';

/**
 * Account security for a lite account: what can sign in, and adding a second way.
 *
 * This is the recovery story, and until now it did not exist in the product. A lite
 * account has no password and no recovery email — the linked credentials ARE the
 * account — so a user with one bound wallet who loses that wallet loses everything
 * they have written, permanently. The bind endpoint has been able to prevent that
 * since Phase 2 and nothing ever called it.
 *
 * Linking is a step-up: a single-use, user-bound nonce, then a fresh proof of the NEW
 * credential. The nonce is requested per attempt and never reused (SEQ-1/XC-2).
 */

const COPY = {
  title: 'Sign-in & recovery',
  intro:
    'Your Lumen account has no password. Whatever is listed here is how you get back in — so it is worth having more than one.',
  atRisk:
    'You have only one way to sign in. If you lose it, your account and everything you have written go with it. Nobody can restore it, including us.',
  safe: 'You have more than one way to sign in. If you lose one, you can still get back in with another.',
  linked: 'Linked to your account',
  addTitle: 'Add another way to sign in',
  addBtc: 'Link a Bitcoin wallet',
  addEvm: 'Link an Ethereum wallet',
  googleHint: 'Link a Google account',
  connecting: 'Waiting for your wallet…',
  linking: 'Linking…',
  linkedOk: 'Linked. You can now sign in with this too.',
  connectorMissing: 'One-click wallet linking isn’t set up on this deployment yet.',
  googleMissing: 'Google linking isn’t set up on this deployment yet.',
  stepUpFailed: 'Could not start linking — please try again.',
  taproot: 'Taproot addresses aren’t supported yet — use a SegWit (bc1q…) or legacy (1…) address.',
  loading: 'Loading…',
  // This page's whole job is to tell someone they have only one way back into
  // their account. Failing silently to "Loading…" forever meant that warning
  // never arrived — the one outcome this screen exists to prevent.
  loadError: "Couldn't load your sign-in methods just now.",
  loadRetry: 'Try again',
  signedOut: 'Sign in with your Lumen account to manage sign-in methods.',
  primary: 'Primary'
};

const METHOD_LABEL: Record<LiteAuthMethodName, string> = {
  google_passkey: 'Google',
  btc_wallet: 'Bitcoin wallet',
  evm_wallet: 'Ethereum wallet'
};

const METHOD_MARK: Record<LiteAuthMethodName, { symbol: string; bg: string }> = {
  google_passkey: { symbol: 'G', bg: '#4285f4' },
  btc_wallet: { symbol: '₿', bg: '#f7931a' },
  evm_wallet: { symbol: '◈', bg: '#627eea' }
};

function formatDate(value: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

const MethodRow: FC<{ method: LiteAuthMethod }> = ({ method }) => {
  const mark = METHOD_MARK[method.method] ?? { symbol: '•', bg: '#9ca3af' };
  return (
    <li className="flex items-center gap-3 rounded-xl border border-[#e4e6e9] bg-white p-3">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[15px] font-bold text-white"
        style={{ backgroundColor: mark.bg }}
        aria-hidden
      >
        {mark.symbol}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-semibold text-[#161511]">
          {METHOD_LABEL[method.method] ?? method.method}
          {method.isPrimary ? (
            <span className="ml-2 rounded-md bg-[#f3f4f6] px-1.5 py-0.5 text-[11px] font-semibold text-[#4b5563]">
              {COPY.primary}
            </span>
          ) : null}
        </span>
        <span className="block truncate font-mono text-[12.5px] text-[#9ca3af]">
          {method.hint ?? ''}
          {method.hint && method.createdAt ? ' · ' : ''}
          {formatDate(method.createdAt)}
        </span>
      </span>
    </li>
  );
};

const SecurityPanel: FC = () => {
  const { user } = useUserClient();
  const [methods, setMethods] = useState<LiteAuthMethod[] | null>(null);
  const [atRisk, setAtRisk] = useState(false);
  const [busy, setBusy] = useState<'btc' | 'evm' | 'google' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // Google captures its nonce when the button initialises, so it is fetched up front
  // and the button is remounted (key) whenever a fresh one arrives.
  const [googleNonce, setGoogleNonce] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const isLite = user?.isLoggedIn && user.account_tier === 'lite';

  const reload = useCallback(async () => {
    setLoadFailed(false);
    const data = await fetchAuthMethods();
    // fetchAuthMethods swallows every failure into null, so null is the ONLY
    // signal available here. Returning early left `methods` null forever and the
    // render sat on "Loading…" with no retry.
    if (!data) {
      setLoadFailed(true);
      return;
    }
    setMethods(data.methods);
    setAtRisk(data.atRisk);
  }, []);

  useEffect(() => {
    if (isLite) void reload();
  }, [isLite, reload]);

  // Pre-arm a step-up nonce for the Google button. It is single-use and short-lived,
  // so it is refreshed after every successful link.
  useEffect(() => {
    if (!isLite || !googleConfigured()) return;
    let cancelled = false;
    (async () => {
      const stepUp = await requestStepUp();
      if (!cancelled) setGoogleNonce(stepUp?.nonce ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [isLite, done]);

  const afterLink = async () => {
    setDone(true);
    setError(null);
    await reload();
  };

  const linkWallet = async (chain: WalletChain) => {
    setError(null);
    setDone(false);
    setBusy(chain);
    try {
      const address = await connectWallet(chain);
      if (chain === 'btc' && isTaprootAddress(address)) {
        setError(COPY.taproot);
        return;
      }
      // Fresh nonce per attempt: it is single-use and bound to this user.
      const stepUp = await requestStepUp();
      if (!stepUp) {
        setError(COPY.stepUpFailed);
        return;
      }
      const message = chain === 'btc' ? stepUp.messages.btc : stepUp.messages.evm;
      if (!message) {
        setError(COPY.stepUpFailed);
        return;
      }
      const signature = await signMessageWith(chain, address, message);
      const result = await bindWallet(chain, address, signature, stepUp.nonce);
      if (result.status !== 'ok') {
        setError(result.message);
        return;
      }
      await afterLink();
    } catch (err) {
      setError(walletErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const linkGoogle = async (idToken: string) => {
    if (!googleNonce) {
      setError(COPY.stepUpFailed);
      return;
    }
    setError(null);
    setDone(false);
    setBusy('google');
    const result = await bindGoogle(idToken, googleNonce);
    setBusy(null);
    if (result.status !== 'ok') {
      setError(result.message);
      return;
    }
    await afterLink();
  };

  if (!isLite) {
    return <div className="mx-auto max-w-[560px] p-6 text-[15px] text-[#4b5563]">{COPY.signedOut}</div>;
  }

  const connectorReady = walletConnectAvailable();

  return (
    <div className="mx-auto max-w-[560px] p-6">
      <h1 className="font-serif text-2xl font-semibold text-[#161511]">{COPY.title}</h1>
      <p className="mt-2 text-[15px] leading-[1.55] text-[#4b5563]">{COPY.intro}</p>

      {methods === null && loadFailed ? (
        <div className="mt-6">
          <p className="text-[14px] text-destructive">{COPY.loadError}</p>
          <button
            type="button"
            onClick={() => void reload()}
            className="mt-3 rounded-[10px] border border-[#e2e4e7] bg-white px-4 py-2 text-[14px] font-semibold text-[#161511] hover:border-[#161511]"
          >
            {COPY.loadRetry}
          </button>
        </div>
      ) : methods === null ? (
        <p className="mt-6 text-[14px] text-[#9ca3af]">{COPY.loading}</p>
      ) : (
        <>
          <div
            className={`mt-5 rounded-xl border p-4 text-[14px] leading-[1.55] ${
              atRisk
                ? 'border-[#f6c6c0] bg-[#fdf2f0] text-[#8c2b1e]'
                : 'border-[#cfe6d8] bg-[#f2f9f5] text-[#1f6340]'
            }`}
          >
            {atRisk ? COPY.atRisk : COPY.safe}
          </div>

          <h2 className="mt-6 text-[13px] font-semibold uppercase tracking-wide text-[#9ca3af]">
            {COPY.linked}
          </h2>
          <ul className="mt-2 flex flex-col gap-2">
            {methods.map((m) => (
              <MethodRow key={m.credentialId} method={m} />
            ))}
          </ul>
        </>
      )}

      <h2 className="mt-7 text-[13px] font-semibold uppercase tracking-wide text-[#9ca3af]">
        {COPY.addTitle}
      </h2>

      <div className="mt-2 flex flex-col gap-2">
        <button
          onClick={() => linkWallet('btc')}
          disabled={!connectorReady || busy !== null}
          className="flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border-[1.5px] border-[#e4e6e9] bg-white text-[15px] font-semibold text-[#161511] hover:border-[#161511] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="text-[#f7931a]">₿</span>
          {busy === 'btc' ? COPY.connecting : COPY.addBtc}
        </button>
        <button
          onClick={() => linkWallet('evm')}
          disabled={!connectorReady || busy !== null}
          className="flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border-[1.5px] border-[#e4e6e9] bg-white text-[15px] font-semibold text-[#161511] hover:border-[#161511] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="text-[#627eea]">◈</span>
          {busy === 'evm' ? COPY.connecting : COPY.addEvm}
        </button>
        {!connectorReady ? (
          <p className="text-[12.5px] text-[#9ca3af]">{COPY.connectorMissing}</p>
        ) : null}

        {googleConfigured() ? (
          googleNonce ? (
            <GoogleSignIn
              key={googleNonce}
              nonce={googleNonce}
              onIdToken={linkGoogle}
              onError={setError}
            />
          ) : (
            <p className="text-[12.5px] text-[#9ca3af]">{COPY.loading}</p>
          )
        ) : (
          <p className="text-[12.5px] text-[#9ca3af]">{COPY.googleMissing}</p>
        )}
      </div>

      {busy === 'google' ? <p className="mt-3 text-[13px] text-[#4b5563]">{COPY.linking}</p> : null}
      {done ? <p className="mt-3 text-[13px] font-medium text-[#1f6340]">{COPY.linkedOk}</p> : null}
      {error ? <p className="mt-3 text-[13px] leading-[1.55] text-[#b45309]">{error}</p> : null}
    </div>
  );
};

export default SecurityPanel;
