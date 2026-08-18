'use client';

import { FC, useCallback, useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { useRouter } from 'next/navigation';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useSignOut } from '@smart-signer/lib/auth/use-sign-out';
import { useTranslation } from '@/blog/i18n/client';
import { dateToShow } from '@ui/lib/parse-date';
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
 *
 * ★★★ AND IT IS WHERE "SIGN OUT EVERYWHERE" LIVES (2026-08-10). `logout-all` has
 * existed since F-L3 and had NO caller anywhere in the product — the only thing that
 * ever advanced the account-wide session epoch was the ordinary per-device sign-out
 * button, doing it by accident. Now that sign-out correctly revokes one device, the
 * account-wide lever needs a real home, and this is the screen a user reaches when
 * they think something is wrong with their account.
 */

const COPY = {
  title: 'Sign-in & recovery',
  intro:
    'Your Lumen account has no password. Whatever is listed here is how you get back in. So it is worth having more than one.',
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
  stepUpFailed: 'Could not start linking. Please try again.',
  taproot: 'Taproot addresses aren’t supported yet. Use a SegWit (bc1q…) or legacy (1…) address.',
  loading: 'Loading…',
  signOutAllTitle: 'Signed in somewhere else?',
  signOutAllBody:
    'Signing out normally only signs out the device you are using. If you think someone else has access to your account, this ends every session everywhere. Including this one.',
  signOutAll: 'Sign out on all devices',
  signOutAllConfirm: 'Yes, sign out everywhere',
  signOutAllCancel: 'Cancel',
  signOutAllBusy: 'Signing out…',
  signOutAllFailed: 'Could not sign out everywhere just now. Please try again.',
  // This page's whole job is to tell someone they have only one way back into
  // their account. Failing silently to "Loading…" forever meant that warning
  // never arrived — the one outcome this screen exists to prevent.
  loadError: "Couldn't load your sign-in methods just now.",
  loadRetry: 'Try again',
  // ★ The SESSION read failing is a different failure from the METHODS read
  // failing, and it used to have no words at all — see the gate below.
  sessionError: "Couldn't check your account just now, so this page can't show your sign-in methods.",
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

/**
 * Low 5: this used to be `new Date(value).toLocaleDateString()` with no locale
 * argument, so it rendered in whatever default locale the runtime falls back to
 * (US-style "8/16/2026") regardless of the reader's actual browser locale — while
 * the profile page's "Joined August 2026" (profile-identity.tsx) already goes
 * through `dateToShow`, which formats via the app's own translated month names
 * instead of trusting the runtime's locale guess. Reusing that helper here keeps
 * both dates on the one presentation the app already has, rather than adding a
 * second date format to keep in sync with it.
 */
function formatDate(value: string | null, t: TFunction<'common_blog', undefined>): string {
  if (!value || Number.isNaN(new Date(value).getTime())) return '';
  return dateToShow(value, t);
}

const MethodRow: FC<{ method: LiteAuthMethod; t: TFunction<'common_blog', undefined> }> = ({ method, t }) => {
  const mark = METHOD_MARK[method.method] ?? { symbol: '•', bg: '#9ca3af' };
  return (
    <li className="flex items-center gap-3 rounded-xl border border-line-11 bg-surface-1 p-3">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[15px] leading-[24px] font-bold text-ink-27"
        style={{ backgroundColor: mark.bg }}
        aria-hidden
      >
        {mark.symbol}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] leading-[22px] font-semibold text-ink-2">
          {METHOD_LABEL[method.method] ?? method.method}
          {method.isPrimary ? (
            <span className="ml-2 rounded-md bg-surface-22 px-1.5 py-0.5 text-[12px] leading-[18px] font-semibold text-ink-8">
              {COPY.primary}
            </span>
          ) : null}
        </span>
        <span className="block truncate font-mono text-[13px] leading-[20px] text-ink-14">
          {method.hint ?? ''}
          {method.hint && method.createdAt ? ' · ' : ''}
          {formatDate(method.createdAt, t)}
        </span>
      </span>
    </li>
  );
};

const SecurityPanel: FC = () => {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  /**
   * ★★★ SAME RACE AS EVERY OTHER IDENTITY GATE, COMPOUNDED BY TIER
   * (2026-08-12, G1). `isLite` below was already gated on raw
   * `useUserClient()`'s `user?.isLoggedIn`, which cannot answer during SSR —
   * so a genuinely signed-in lite reader landing on this page always saw
   * "Sign in with your Lumen account…" for the whole hydration + fetch
   * window, on the one screen whose entire job is telling someone they have
   * only one way back into their account. `identity.isLoggedIn` answers that
   * half immediately from the session cookie. The other half — whether this
   * account IS lite — genuinely cannot be known any sooner: `account_tier`
   * does not exist on `identity` by design (only the real client `user`
   * object has it, same as `muted-list.tsx`/`profile-actions.tsx`). So the
   * render below is three-way, not two: definitely signed out (identity),
   * signed in but tier not confirmed yet (`identity.clientAnswered`, same
   * `[QUERY_KEY.user]` query `account_tier` comes from — a loading state, not
   * a guess), then the real `isLite` check once it's safe to trust.
   */
  const identity = useSessionIdentity();
  const router = useRouter();
  const signOutMutation = useSignOut();
  const [confirmSignOutAll, setConfirmSignOutAll] = useState(false);
  const [signOutAllError, setSignOutAllError] = useState<string | null>(null);
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
  // M11: "Continue with Google" belongs in "Add another way to sign in" only while
  // Google isn't already one of the ways in. Once it's bound it's already shown
  // above as the Primary method, and offering it again here is the same option
  // twice on one screen — confusing on a page whose entire job is being clear
  // about what a reader's recovery options are.
  const googleLinked = methods?.some((m) => m.method === 'google_passkey') ?? false;

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
  // M11: skip once Google is already linked — there is no button left to arm a
  // nonce for, and requesting one would just spend a single-use challenge on
  // the server for nothing.
  useEffect(() => {
    if (!isLite || !googleConfigured() || googleLinked) return;
    let cancelled = false;
    (async () => {
      const stepUp = await requestStepUp();
      if (!cancelled) setGoogleNonce(stepUp?.nonce ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [isLite, done, googleLinked]);

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

  const signOutEverywhere = async () => {
    setSignOutAllError(null);
    try {
      // `everywhere` is the whole point: the default (false) is the per-device
      // sign-out every other control uses.
      await signOutMutation.mutateAsync({ user, everywhere: true });
    } catch {
      // Say so rather than navigating away as if it worked — this is the control a
      // user reaches for when they believe their account is compromised, and a
      // silent failure here is the worst possible lie.
      setSignOutAllError(COPY.signOutAllFailed);
      return;
    }
    router.push('/');
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

  if (!identity.isLoggedIn) {
    return (
      <div className="mx-auto max-w-[560px] p-6">
        {/* ★ A GATE IS STILL A PAGE, AND A PAGE NEEDS ITS NAME (A7, 2026-08-18). Measured
              live: /security and /upgrade returned ZERO headings of any level to a
              signed-out visitor, because the panel early-returns one sentence. A
              document with no h1 gives a screen-reader user nothing to orient by and
              gives a crawler nothing to index — and these two are exactly the pages
              someone lands on cold from a link. The heading is the page's identity,
              not a decoration on its happy path. */}
        <h1 className="font-serif text-2xl font-semibold text-ink-2">{COPY.title}</h1>
        <p className="mt-2 text-[15px] leading-[24px] text-ink-8">{COPY.signedOut}</p>
      </div>
    );
  }
  if (!identity.clientAnswered) {
    // ★★★ "LOADING…" WAS PERMANENT ON A FAILED SESSION READ (2026-08-13,
    // adversarial review S4). `clientAnswered` is `dataUpdatedAt > 0`, and React
    // Query's error reducer never sets `dataUpdatedAt` — so a `/api/users/me` that
    // only ever failed left this word on screen for the life of the page, on the
    // one screen whose entire purpose is warning someone they have a single way
    // back into their account. The same reasoning that produced `loadError` for
    // the methods fetch (see COPY) applies here and was simply never followed
    // through to the gate above it.
    if (identity.sessionUnavailable) {
      return (
        <div className="mx-auto max-w-[560px] p-6">
          <p className="text-[15px] leading-[24px] text-ink-8">{COPY.sessionError}</p>
          <button
            type="button"
            onClick={identity.retrySession}
            className="mt-3 rounded-control border border-line-11 px-4 py-2 text-[14px] leading-[22px] font-semibold text-ink-7 hover:bg-surface-16"
          >
            {COPY.loadRetry}
          </button>
        </div>
      );
    }
    return <div className="mx-auto max-w-[560px] p-6 text-[15px] leading-[24px] text-ink-14">{COPY.loading}</div>;
  }
  if (!isLite) {
    return (
      <div className="mx-auto max-w-[560px] p-6">
        {/* ★ A GATE IS STILL A PAGE, AND A PAGE NEEDS ITS NAME (A7, 2026-08-18). Measured
              live: /security and /upgrade returned ZERO headings of any level to a
              signed-out visitor, because the panel early-returns one sentence. A
              document with no h1 gives a screen-reader user nothing to orient by and
              gives a crawler nothing to index — and these two are exactly the pages
              someone lands on cold from a link. The heading is the page's identity,
              not a decoration on its happy path. */}
        <h1 className="font-serif text-2xl font-semibold text-ink-2">{COPY.title}</h1>
        <p className="mt-2 text-[15px] leading-[24px] text-ink-8">{COPY.signedOut}</p>
      </div>
    );
  }

  const connectorReady = walletConnectAvailable();

  return (
    <div className="mx-auto max-w-[560px] p-6">
      <h1 className="font-serif text-2xl font-semibold text-ink-2">{COPY.title}</h1>
      <p className="mt-2 text-[15px] leading-[24px] text-ink-8">{COPY.intro}</p>

      {methods === null && loadFailed ? (
        <div className="mt-6">
          <p className="text-[14px] leading-[22px] text-destructive">{COPY.loadError}</p>
          <button
            type="button"
            onClick={() => void reload()}
            className="mt-3 rounded-control border border-line-12 bg-surface-1 px-4 py-2 text-[14px] leading-[22px] font-semibold text-ink-2 hover:border-line-28"
          >
            {COPY.loadRetry}
          </button>
        </div>
      ) : methods === null ? (
        <p className="mt-6 text-[14px] leading-[22px] text-ink-14">{COPY.loading}</p>
      ) : (
        <>
          <div
            className={`mt-5 rounded-xl border p-4 text-[14px] leading-[22px] ${
              atRisk
                ? 'border-line-brand-2 bg-surface-brand-5 text-ink-brand-2'
                : 'border-line-15 bg-surface-ok-2 text-ink-ok-1'
            }`}
          >
            {atRisk ? COPY.atRisk : COPY.safe}
          </div>

          <h2 className="mt-6 text-[13px] leading-[20px] font-semibold uppercase tracking-wide text-ink-14">
            {COPY.linked}
          </h2>
          <ul className="mt-2 flex flex-col gap-2">
            {methods.map((m) => (
              <MethodRow key={m.credentialId} method={m} t={t} />
            ))}
          </ul>
        </>
      )}

      <h2 className="mt-7 text-[13px] leading-[20px] font-semibold uppercase tracking-wide text-ink-14">
        {COPY.addTitle}
      </h2>

      <div className="mt-2 flex flex-col gap-2">
        <button
          onClick={() => linkWallet('btc')}
          disabled={!connectorReady || busy !== null}
          className="flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-line-11 bg-surface-1 text-[15px] leading-[24px] font-semibold text-ink-2 hover:border-line-28 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="text-ink-warn-9">₿</span>
          {busy === 'btc' ? COPY.connecting : COPY.addBtc}
        </button>
        <button
          onClick={() => linkWallet('evm')}
          disabled={!connectorReady || busy !== null}
          className="flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-line-11 bg-surface-1 text-[15px] leading-[24px] font-semibold text-ink-2 hover:border-line-28 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="text-ink-info-7">◈</span>
          {busy === 'evm' ? COPY.connecting : COPY.addEvm}
        </button>
        {!connectorReady ? (
          <p className="text-[13px] leading-[20px] text-ink-14">{COPY.connectorMissing}</p>
        ) : null}

        {googleLinked ? (
          // M11: Google is already listed above as the linked Primary method —
          // offering it again here as something to add is the same option twice.
          <p className="text-[13px] leading-[20px] text-ink-14">
            {t('lite_auth.security.google_already_linked')}
          </p>
        ) : googleConfigured() ? (
          googleNonce ? (
            <GoogleSignIn
              key={googleNonce}
              nonce={googleNonce}
              onIdToken={linkGoogle}
              onError={setError}
            />
          ) : (
            <p className="text-[13px] leading-[20px] text-ink-14">{COPY.loading}</p>
          )
        ) : (
          <p className="text-[13px] leading-[20px] text-ink-14">{COPY.googleMissing}</p>
        )}
      </div>

      <h2 className="mt-8 text-[13px] leading-[20px] font-semibold uppercase tracking-wide text-ink-14">
        {COPY.signOutAllTitle}
      </h2>
      <p className="mt-2 text-[14px] leading-[22px] text-ink-8">{COPY.signOutAllBody}</p>
      {confirmSignOutAll ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void signOutEverywhere()}
            disabled={signOutMutation.isLoading}
            data-testid="sign-out-everywhere-confirm"
            className="rounded-control border-2 border-line-brand-11 bg-surface-1 px-4 py-2 text-[14px] leading-[22px] font-semibold text-ink-brand-5 hover:bg-surface-brand-5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {signOutMutation.isLoading ? COPY.signOutAllBusy : COPY.signOutAllConfirm}
          </button>
          <button
            type="button"
            onClick={() => setConfirmSignOutAll(false)}
            disabled={signOutMutation.isLoading}
            className="rounded-control border border-line-12 bg-surface-1 px-4 py-2 text-[14px] leading-[22px] font-semibold text-ink-2 hover:border-line-28 disabled:opacity-50"
          >
            {COPY.signOutAllCancel}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmSignOutAll(true)}
          data-testid="sign-out-everywhere"
          className="mt-2 rounded-control border border-line-12 bg-surface-1 px-4 py-2 text-[14px] leading-[22px] font-semibold text-ink-2 hover:border-line-28"
        >
          {COPY.signOutAll}
        </button>
      )}
      {signOutAllError ? (
        <p className="mt-2 text-[13px] leading-[20px] text-destructive">{signOutAllError}</p>
      ) : null}

      {busy === 'google' ? <p className="mt-3 text-[13px] leading-[20px] text-ink-8">{COPY.linking}</p> : null}
      {done ? <p className="mt-3 text-[13px] leading-[20px] font-medium text-ink-ok-1">{COPY.linkedOk}</p> : null}
      {error ? <p className="mt-3 text-[13px] leading-[20px] text-ink-warn-3">{error}</p> : null}
    </div>
  );
};

export default SecurityPanel;
