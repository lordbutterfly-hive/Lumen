'use client';

import { FC, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import DialogLogin from '@/blog/components/dialog-login';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useLiteLogin, type WalletChain } from './use-lite-login';
import WalletConnectDialog from './wallet-connect-dialog';
import TurnstileWidget, { turnstileSiteKey } from './turnstile-widget';
import GoogleSignIn, { googleConfigured } from './google-signin';
import HiveSigninPanel from './hive-signin-panel';

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
  orWallet: 'or connect a wallet',
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

const LumenLogin: FC = () => {
  const router = useRouter();
  const { user } = useUserClient();
  const { nameStatus, checkName, createAccount, google } = useLiteLogin();

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

  // Already signed in → leave the pre-auth page.
  useEffect(() => {
    if (user?.isLoggedIn) router.replace('/');
  }, [user?.isLoggedIn, router]);

  const goHome = () => {
    router.replace('/');
    router.refresh();
  };

  // Google Identity Services seam: acquiring the ID token needs the GIS SDK +
  // NEXT_PUBLIC_LITE_GOOGLE_CLIENT_ID. The backend (/api/lite/auth/google) is
  // built and ready; wiring the token acquisition here is the follow-up.
  const startGoogle = () => setError(COPY.googleSeam);

  /** Google returned an ID token — hand it to the (already built) backend. */
  const handleGoogleToken = async (idToken: string) => {
    setError(null);
    setBusy(true);
    const outcome = await google(idToken);
    setBusy(false);
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
    <div className="fixed inset-0 z-50 flex flex-col items-center overflow-y-auto bg-white px-5 pb-12 font-sans text-[#161511]">
      <div className="fixed inset-x-0 top-0 h-[3px] bg-[linear-gradient(90deg,#c0392b,#e07b3e)]" />

      {/* Wordmark: Open Sans to match the app shell's committed identity
          (app-header design-handoff-v2: "no serif display face") — the login
          mockup's Lora wordmark was the stray outlier. */}
      <div className="mb-8 mt-16 text-center">
        <a href="/" className="font-sans text-[42px] font-bold leading-none tracking-[-0.025em] text-[#161511]">
          Lumen
        </a>
        <p className="mt-2 font-serif text-base text-[#6b7280]">{COPY.tagline}</p>
      </div>

      <div className="flex w-[460px] max-w-full flex-col gap-[18px]">
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
                {googleConfigured() ? (
                  <GoogleSignIn onIdToken={handleGoogleToken} onError={setError} />
                ) : (
                  <button
                    onClick={startGoogle}
                    className="flex h-[52px] w-full items-center justify-center gap-[11px] rounded-[14px] border border-[#e4e6e9] bg-white text-[15.5px] font-semibold text-[#161511] hover:border-[#d3d6da] hover:bg-[#f9fafb]"
                  >
                    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden>
                      <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.4 6.6-16.1z" />
                      <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.1 15.4 46 24 46z" />
                      <path fill="#FBBC05" d="M11.8 27.2c-.4-1.3-.7-2.7-.7-4.2s.2-2.9.7-4.2v-5.7H4.5C3 16.1 2.1 19.9 2.1 23s.9 6.9 2.4 9.9l7.3-5.7z" />
                      <path fill="#EA4335" d="M24 9.9c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 3.3 29.9 1 24 1 15.4 1 8.1 5.9 4.5 13.1l7.3 5.7c1.7-5.2 6.5-8.9 12.2-8.9z" />
                    </svg>
                    {COPY.google}
                  </button>
                )}

                <div className="mx-0.5 my-4 flex items-center gap-3">
                  <div className="h-px flex-1 bg-[#ececec]" />
                  <span className="text-xs font-semibold text-[#9ca3af]">{COPY.orWallet}</span>
                  <div className="h-px flex-1 bg-[#ececec]" />
                </div>

                <div className="flex flex-col gap-2.5">
                  {/* Hive Keychain — reuse the built login dialog for real key auth. */}
                  <DialogLogin redirectTo="/">
                    <div className="flex h-14 w-full cursor-pointer items-center gap-3 rounded-[14px] border border-[#e4e6e9] bg-white px-4 text-left hover:border-[#c0392b] hover:bg-[#fefaf9]">
                      <span className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-[9px] bg-[#c0392b] text-[15px] font-extrabold text-white">
                        K
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[15px] font-semibold text-[#161511]">{COPY.keychainTitle}</span>
                        <span className="block text-xs text-[#6b7280]">{COPY.keychainSub}</span>
                      </span>
                    </div>
                  </DialogLogin>

                  {/* Bitcoin wallet — Lumen Lite, no keys. */}
                  <button
                    onClick={() => setWalletOpen('btc')}
                    className="flex h-14 w-full cursor-pointer items-center gap-3 rounded-[14px] border border-[#e4e6e9] bg-white px-4 text-left hover:border-[#f7931a] hover:bg-[#fffaf3]"
                  >
                    <span className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-[9px] bg-[#f7931a] text-base font-extrabold text-white">
                      ₿
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

                {error ? <p className="mt-4 text-center text-[13px] leading-[1.5] text-[#b45309]">{error}</p> : null}

                <p className="mt-[18px] text-center text-xs leading-[1.5] text-[#9ca3af]">
                  By continuing you agree to Lumen’s <a href="/tos.html">Terms</a> and{' '}
                  <a href="/privacy.html">Privacy Policy</a>.
                </p>
              </div>
            </div>

            {/* Tier-2: full Hive account, secondary. */}
            <HiveSigninPanel />
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
