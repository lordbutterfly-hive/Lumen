'use client';

import { FC, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useLiteLogin, type WalletChain } from './use-lite-login';
import WalletConnectDialog from './wallet-connect-dialog';
import TurnstileWidget, { turnstileSiteKey } from './turnstile-widget';
import GoogleSignIn, { googleConfigured } from './google-signin';
import KeychainSignin from './keychain-signin';

// TODO i18n — staged copy while the redesign lands (mirrors app-header's LABELS
// precedent); move to locales/*/common_blog.json once final.
// A Lumen account posts to Hive but DECLINES all rewards (decision 2026-07-23) —
// earning starts on your own Hive account, after upgrading. Promising payment on the
// signup screen would be a straight lie to the person reading it, so the copy sells
// the thing that is actually true: publishing to Hive with nothing to set up.
const COPY = {
  tagline: 'A calmer place to read and write on Hive.',
  welcome: 'Welcome to Lumen',
  welcomeSub:
    'Publish to Hive without keys, wallets or setup. Start in seconds; upgrade to a full Hive account — and start earning on it — whenever you’re ready.',
  google: 'Continue with Google',
  orHive: 'or connect with Hive Keychain',
  keychainTitle: 'Sign in with Hive Keychain',
  keychainSub: 'Your existing Hive account — keys stay on your device.',
  btcTitle: 'Continue with a Bitcoin wallet',
  btcSub: 'Sign a message to prove ownership — no payment, no gas.',
  evmTitle: 'Continue with an Ethereum wallet',
  evmSub: 'MetaMask, Rainbow, any EVM wallet — a signature, not a transaction.',
  namePick: 'Pick your Lumen name',
  namePickSub: 'This is how you’ll appear across Lumen. You can’t change it later, so choose well.',
  nameRules: 'Lowercase letters, numbers and dashes. 3–16 characters.',
  create: 'Create my Lumen account',
  createReassure:
    'Free. No keys to save. Your posts publish through Lumen with a small “via Lumen” mark and don’t collect rewards — upgrade to a full Hive account whenever you want, and your posting history comes with you.',
  back: 'Back',
  checking: 'Checking…',
  googleSeam:
    'Google sign-in is being set up — for now, use a Bitcoin or Ethereum wallet, or a Hive account below.',
  captchaNeeded: 'Please complete the “I’m human” check first.'
};

type View = 'default' | 'name';

/**
 * `embedded` renders the same four ways in — Google, Bitcoin wallet, Ethereum
 * wallet, Hive Keychain — without the standalone-page chrome, so the sign-in
 * DIALOG can offer the identical set.
 *
 * ★ WHY (2026-08-07): the dialog opens from ~24 places (upvote, reply, composer,
 * profile) and showed ONLY Hive Keychain, with a text link to /login for
 * everything else. So the app's widest sign-in surface hid three of its four
 * methods — including the two that need no keys, which are the whole point of a
 * Lumen account. Reusing this component means the dialog can never drift from
 * the page again.
 */
const LumenLogin: FC<{ embedded?: boolean }> = ({ embedded = false }) => {

  const router = useRouter();

  // ★ AN ALREADY-SIGNED-IN VISITOR MUST NOT LAND ON A SIGN-IN FORM (2026-08-07).
  //
  // The header renders a real, clickable "Log in" link before hydration — on
  // purpose, so crawlers and slow connections can see the front door (see
  // app-header.tsx). For a SIGNED-IN reader that window was assumed to be one
  // frame; measured on a cold cache over a slow connection it lasts 8-48s, and
  // clicking it brought them here, to a full sign-in form that did not recognise
  // their perfectly valid session. That is what "refreshing logs me out" looked
  // like from the outside — the session was never lost, the reader was just
  // stranded on the wrong page.
  //
  // Fixing it here rather than in the header keeps the SEO-visible link intact.
  const { user: sessionUser, isHydrated: sessionHydrated } = useUserClient();
  useEffect(() => {
    if (embedded) return; // inside the dialog, signing in is the point
    if (sessionHydrated && sessionUser?.isLoggedIn) {
      router.replace('/');
    }
  }, [embedded, sessionHydrated, sessionUser?.isLoggedIn, router]);
  const { user } = useUserClient();
  const { nameStatus, checkName, createAccount, google, googleChallenge } = useLiteLogin();

  const [view, setView] = useState<View>('default');
  // Which wallet dialog is open (null = none). One dialog serves both chains.
  const [walletOpen, setWalletOpen] = useState<WalletChain | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // '' until the widget hands one over. Required only when a site key is configured,
  // which is exactly when the server has a secret to verify it against.
  const [captchaToken, setCaptchaToken] = useState('');
  const captchaRequired = turnstileSiteKey().length > 0;
  const [error, setError] = useState<string | null>(null);

  // F-L11: Google's ID token must echo a single-use server nonce (GIS captures it at
  // button init), so fetch one up front and re-arm after each attempt. null = not yet
  // ready / fetch failed → the real button is withheld rather than minting a token the
  // server will reject as a replay.
  const [googleNonce, setGoogleNonce] = useState<string | null>(null);
  // ★★★ RESOLVED ON THE CLIENT, NOT DURING SSR (2026-08-06).
  //
  // `googleConfigured()` reads the client id through `@beam-australia/react-env`,
  // whose `env()` resolves from `window.__ENV` in the BROWSER but from
  // `process.env` on the SERVER. Those two disagreed here: the browser had
  // `REACT_APP_LITE_GOOGLE_CLIENT_ID` (verified in `window.__ENV`) while the
  // server render did not, so SSR emitted the disabled "Google sign-in is being
  // set up" fallback — and because nothing re-rendered after hydration, that
  // fallback STUCK. Google sign-in was permanently dead on a correctly
  // configured deploy, and it also produced a React hydration mismatch.
  //
  // Evaluating it in an effect makes the browser the authority: the server
  // renders the safe "not available" state, and the client corrects it on mount.
  const [googleReady, setGoogleReady] = useState(false);
  const refreshGoogleNonce = useCallback(() => {
    void googleChallenge().then((n) => setGoogleNonce(n));
  }, [googleChallenge]);
  useEffect(() => {
    if (googleConfigured()) {
      setGoogleReady(true);
      refreshGoogleNonce();
    }
  }, [refreshGoogleNonce]);

  // Already signed in → leave the pre-auth page.
  useEffect(() => {
    if (user?.isLoggedIn) router.replace('/');
  }, [user?.isLoggedIn, router]);

  const goHome = () => {
    router.replace('/');
    router.refresh();
  };

  /** Google returned an ID token — hand it to the (already built) backend. */
  const handleGoogleToken = async (idToken: string) => {
    if (!googleNonce) {
      setError('Google sign-in isn’t ready yet — please try again in a moment.');
      return;
    }
    setError(null);
    setBusy(true);
    const outcome = await google(idToken, googleNonce);
    setBusy(false);
    // The nonce is single-use; arm a fresh one for the next attempt.
    refreshGoogleNonce();
    if (outcome.status === 'authenticated') goHome();
    else if (outcome.status === 'needs_name') setView('name');
    else setError(outcome.message);
  };

  const submitName = async () => {
    if (nameStatus.state !== 'available') return;
    // The token MUST be sent. The server verifies it and, in production, refuses to
    // open signup at all unless Turnstile is configured — so a client that never
    // sends one turns every signup into `captcha_failed`.
    if (captchaRequired && !captchaToken) {
      setError(COPY.captchaNeeded);
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await createAccount(name.trim().toLowerCase(), captchaToken || undefined);
    setBusy(false);
    if (outcome.status === 'ok') goHome();
    else setError(outcome.message);
  };

  const nameBorder =
    nameStatus.state === 'available'
      ? 'border-[#2f7d4f]'
      : nameStatus.state === 'unavailable'
        ? 'border-[#b45309]'
        : 'border-[#e4e6e9] focus-within:border-[#c0392b]';

  return (
    // Full-screen layer: /login is standalone (no three-column shell), but the
    // root layout renders <AppHeader/> on every route. Covering it here keeps the
    // change isolated to this feature; the clean long-term fix is a route-group
    // split (move AppHeader into a "(shell)" group, login outside it).
    <div
      className={
        embedded
          ? 'flex w-full flex-col items-center bg-white font-sans text-[#161511]'
          : 'fixed inset-0 z-50 flex flex-col items-center overflow-y-auto bg-white px-5 pb-12 font-sans text-[#161511]'
      }
    >
      {embedded ? null : <div className="fixed inset-x-0 top-0 h-[3px] bg-[linear-gradient(90deg,#c0392b,#e07b3e)]" />}

      {/* Wordmark: Open Sans to match the app shell's committed identity
          (app-header design-handoff-v2: "no serif display face") — the login
          mockup's Lora wordmark was the stray outlier. */}
      {embedded ? null : (
        <div className="mb-8 mt-16 text-center">
          <a href="/" className="font-sans text-[42px] font-bold leading-none tracking-[-0.025em] text-[#161511]">
            Lumen
          </a>
          <p className="mt-2 font-serif text-base text-[#6b7280]">{COPY.tagline}</p>
        </div>
      )}

      <div className={embedded ? 'flex w-full max-w-full flex-col gap-[18px]' : 'flex w-[460px] max-w-full flex-col gap-[18px]'}>
        {view === 'default' ? (
          <>
            <div className="overflow-hidden rounded-[22px] border border-[#ebebeb] bg-white shadow-[0_12px_40px_rgba(192,57,43,0.07),0_1px_2px_rgba(20,18,10,0.04)]">
              <div className="border-b border-[#f3ede9] bg-[radial-gradient(120%_100%_at_0%_0%,#fdf1ee_0%,#fff_62%)] px-[30px] pb-6 pt-8">
                <h1 className="font-serif text-[30px] font-semibold leading-[1.12] tracking-[-0.01em] text-[#161511]">
                  {COPY.welcome}
                </h1>
                <p className="mt-2 text-[14.5px] leading-[1.55] text-[#4b5563]">{COPY.welcomeSub}</p>
              </div>

              <div className="p-6">
                {/* Primary: Google identity (Lumen Lite, no keys). The real Google
                    button renders when a client id is configured; otherwise the styled
                    fallback below explains the state instead of failing on click. */}
                {googleReady ? (
                  googleNonce ? (
                    // key + nonce: GIS captures the nonce at init, so a fresh nonce
                    // remounts the button (F-L11).
                    <GoogleSignIn
                      key={googleNonce}
                      nonce={googleNonce}
                      onIdToken={handleGoogleToken}
                      onError={setError}
                    />
                  ) : (
                    <button
                      type="button"
                      disabled
                      className="flex h-[52px] w-full items-center justify-center gap-[11px] rounded-[14px] border border-[#e4e6e9] bg-white text-[15.5px] font-semibold text-[#161511] opacity-60"
                    >
                      {COPY.google}
                    </button>
                  )
                ) : (
                  // Not configured client-side (REACT_APP_LITE_GOOGLE_CLIENT_ID unset — see
                  // google-signin.tsx googleConfigured()). Rendering this as a normal-looking,
                  // clickable button was the F-14b bug: it looked identical to a working button
                  // but did nothing visible on click. Disabled + an always-visible reason instead.
                  <div>
                    <button
                      type="button"
                      disabled
                      aria-disabled="true"
                      className="flex h-[52px] w-full cursor-not-allowed items-center justify-center gap-[11px] rounded-[14px] border border-[#e4e6e9] bg-white text-[15.5px] font-semibold text-[#161511] opacity-60"
                    >
                      <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden>
                        <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.4 6.6-16.1z" />
                        <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.1 15.4 46 24 46z" />
                        <path fill="#FBBC05" d="M11.8 27.2c-.4-1.3-.7-2.7-.7-4.2s.2-2.9.7-4.2v-5.7H4.5C3 16.1 2.1 19.9 2.1 23s.9 6.9 2.4 9.9l7.3-5.7z" />
                        <path fill="#EA4335" d="M24 9.9c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 3.3 29.9 1 24 1 15.4 1 8.1 5.9 4.5 13.1l7.3 5.7c1.7-5.2 6.5-8.9 12.2-8.9z" />
                      </svg>
                      {COPY.google}
                    </button>
                    <p className="mt-2 text-center text-[13px] leading-[1.5] text-[#6b7280]">{COPY.googleSeam}</p>
                  </div>
                )}

                <div className="mt-2.5" />
                <div className="flex flex-col gap-2.5">

                  {/* Bitcoin wallet — Lumen Lite, no keys. */}
                  <button
                    onClick={() => setWalletOpen('btc')}
                    className="flex h-14 w-full cursor-pointer items-center gap-3 rounded-[14px] border border-[#e4e6e9] bg-white px-4 text-left hover:border-[#f7931a] hover:bg-[#fffaf3]"
                  >
                    {/* ★ A REAL MARK, NOT A GLYPH (2026-08-07). This was the
                        character "₿", which the app's font stack does not carry —
                        it rendered as an empty orange square while Google,
                        Ethereum and Keychain all showed proper marks. Drawn as
                        SVG so it cannot depend on a font again. */}
                    <span className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-[9px] bg-[#f7931a] text-white">
                      <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden fill="currentColor">
                        <path d="M15.9 10.6c.63-.42 1.03-1.1 1.03-2.1 0-1.66-1.2-2.63-3.02-2.94V3h-1.8v2.47h-1.2V3H9.1v2.53H6v1.9h1.2c.5 0 .68.2.68.63v7.88c0 .35-.2.56-.6.56H6V18.5h3.1V21h1.8v-2.47h1.2V21h1.8v-2.53c2.3-.2 3.9-1.28 3.9-3.4 0-1.6-.86-2.6-2.4-3.06l.5-.4zM10.7 7.6h2.05c1.06 0 1.7.45 1.7 1.36 0 .9-.64 1.4-1.7 1.4H10.7V7.6zm2.4 8.8H10.7v-3h2.4c1.26 0 1.98.55 1.98 1.5s-.72 1.5-1.98 1.5z" />
                      </svg>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold text-[#161511]">{COPY.btcTitle}</span>
                      <span className="block text-xs text-[#6b7280]">{COPY.btcSub}</span>
                    </span>
                  </button>

                  {/* EVM wallet — Lumen Lite, no keys. Same proof shape as BTC. */}
                  <button
                    onClick={() => setWalletOpen('evm')}
                    className="flex h-14 w-full cursor-pointer items-center gap-3 rounded-[14px] border border-[#e4e6e9] bg-white px-4 text-left hover:border-[#627eea] hover:bg-[#f8f9ff]"
                  >
                    <span className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-[9px] bg-[#627eea] text-base font-extrabold text-white">
                      ◈
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold text-[#161511]">{COPY.evmTitle}</span>
                      <span className="block text-xs text-[#6b7280]">{COPY.evmSub}</span>
                    </span>
                  </button>
                </div>

                {/* ── The Hive path, deliberately SEPARATE ──────────────────
                    Google / Bitcoin / Ethereum above are all LUMEN LITE: no
                    keys, no wallet required to hold an account, created by us.
                    Keychain below signs into a FULL HIVE ACCOUNT the person
                    already owns. They are different kinds of thing, so they do
                    not belong in one undifferentiated list — the three lite
                    options carry equal weight, and this is its own step. */}
                <div className="mx-0.5 my-4 flex items-center gap-3">
                  <div className="h-px flex-1 bg-[#ececec]" />
                  <span className="text-xs font-semibold text-[#9ca3af]">{COPY.orHive}</span>
                  <div className="h-px flex-1 bg-[#ececec]" />
                </div>

                <KeychainSignin />

                {error ? <p className="mt-4 text-center text-[13px] leading-[1.5] text-[#b45309]">{error}</p> : null}

                <p className="mt-[18px] text-center text-xs leading-[1.5] text-[#9ca3af]">
                  By continuing you agree to Lumen’s <a href="/tos.html">Terms</a> and{' '}
                  <a href="/privacy.html">Privacy Policy</a>.
                </p>
              </div>
            </div>

            {/* Tier-2: full Hive account, secondary. */}
          </>
        ) : (
          <div className="rounded-[18px] border border-[#ebebeb] bg-white p-6 shadow-[0_1px_2px_rgba(20,18,10,0.03)]">
            <button
              onClick={() => {
                setView('default');
                setError(null);
              }}
              className="mb-4 flex items-center gap-1.5 border-0 bg-transparent p-0 text-[13px] font-semibold text-[#6b7280]"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2">
                <path d="M15 18l-6-6 6-6" />
              </svg>
              {COPY.back}
            </button>
            <h1 className="font-serif text-2xl font-semibold text-[#161511]">{COPY.namePick}</h1>
            <p className="mt-1.5 text-sm leading-[1.5] text-[#6b7280]">{COPY.namePickSub}</p>

            <div className={`mb-2 mt-[18px] flex h-12 items-center gap-2 rounded-xl border-[1.5px] px-3.5 ${nameBorder}`}>
              <span className="font-bold text-[#9ca3af]">@</span>
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  checkName(e.target.value);
                }}
                autoFocus
                spellCheck={false}
                className="min-w-0 flex-1 border-0 font-sans text-base font-semibold text-[#161511] outline-none"
              />
              {nameStatus.state === 'checking' ? (
                <span className="text-[13px] font-semibold text-[#9ca3af]">{COPY.checking}</span>
              ) : nameStatus.state === 'available' ? (
                <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[#2f7d4f]">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2f7d4f" strokeWidth="2.4">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  @{name.trim().toLowerCase()} is available
                </span>
              ) : null}
            </div>
            {nameStatus.state === 'unavailable' ? (
              <p className="mb-2 text-[12.5px] font-medium text-[#b45309]">{nameStatus.reason}</p>
            ) : null}
            <p className="mb-[18px] text-xs text-[#9ca3af]">{COPY.nameRules}</p>

            {/* Real Turnstile widget. Renders nothing when no site key is set — which
                is also when the server passes the check through, so the two ends can
                never be half-configured. */}
            <TurnstileWidget onToken={setCaptchaToken} />

            <button
              onClick={submitName}
              disabled={busy || nameStatus.state !== 'available' || (captchaRequired && !captchaToken)}
              className="h-12 w-full cursor-pointer rounded-xl bg-[#c0392b] text-[15px] font-semibold text-white hover:bg-[#a5301f] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? COPY.checking : COPY.create}
            </button>
            {error ? <p className="mt-3 text-center text-[13px] leading-[1.5] text-[#b45309]">{error}</p> : null}
            <p className="mt-3 text-center text-xs leading-[1.5] text-[#6b7280]">{COPY.createReassure}</p>
          </div>
        )}
      </div>

      <div className="my-9 flex gap-5 text-[13px] text-[#9ca3af]">
        <a href="/tos.html" className="text-[#9ca3af]">Terms</a>
        <a href="/privacy.html" className="text-[#9ca3af]">Privacy</a>
        <a href="/faq.html" className="text-[#9ca3af]">Help</a>
      </div>

      {walletOpen ? (
        <WalletConnectDialog
          chain={walletOpen}
          onClose={() => setWalletOpen(null)}
          onAuthenticated={() => {
            setWalletOpen(null);
            goHome();
          }}
          onNeedsName={() => {
            setWalletOpen(null);
            setView('name');
          }}
        />
      ) : null}
    </div>
  );
};

export default LumenLogin;
