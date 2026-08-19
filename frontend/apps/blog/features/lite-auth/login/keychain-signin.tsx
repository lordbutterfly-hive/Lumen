'use client';

import { FC, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useProcessAuth } from '@smart-signer/components/auth/process';
import { KeyType, LoginType } from '@smart-signer/types/common';

/**
 * Hive Keychain sign-in — the ONLY Hive-key path Lumen offers, and it touches no
 * denser login component.
 *
 * ★ OPERATOR RULING 2026-08-01: Lumen has four ways in — Google, a Bitcoin
 * wallet and an EVM wallet (Lumen Lite; the wallets via Reown), plus Hive
 * Keychain for people who already have a Hive account. Everything else is
 * stripped from login.
 *
 * SHAPE COMES FROM THE DESIGN (design_handoff_lumen_redesign/Login.dc.html,
 * "Hiveblog UI Redesign Request (2)"): Keychain is a 56px ROW sitting inside
 * the main card under the "or connect a wallet" divider — the handoff's own
 * markup comments it "Equal-weight: Keychain (above) + Bitcoin" — with a
 * "Detected" chip when the extension is present. It is NOT a separate card and
 * NOT a collapsed secondary section.
 *
 * WHY THIS EXISTS RATHER THAN A FILTERED METHOD LIST. Restricting the denser
 * list was not enough: the row handed off to `DialogLogin` -> smart-signer's
 * `SignInForm`, whose FIRST step is `SAFE_STORAGE_LOGIN` — the hbauth "encrypt
 * your keys in this browser" screen — with PeakVault / MetaMask-Snap /
 * Google-Drive-restore / WIF / HiveAuth / HiveSigner one click away under
 * "Other sign in options". This talks to `useProcessAuth` directly.
 *
 * Keychain needs a username because the signature binds to a Hive account; that
 * is the single input, revealed only after the row is chosen so the row itself
 * stays visually equal to the wallet rows. No private key is ever handled here —
 * the extension signs and returns a signature.
 */

const COPY = {
  title: 'Sign in with Hive Keychain',
  sub: 'Your keys, your content.',
  detected: 'Detected',
  usernameLabel: 'Hive username',
  placeholder: 'yourname',
  submit: 'Sign in with Keychain',
  working: 'Waiting for Keychain…',
  notDetected: 'Not detected. Install the Hive Keychain extension, then reload.',
  needUsername: 'Enter your Hive username.',
  failed: 'That sign-in did not complete. Please try again.',
  cancelled: 'You cancelled. Nothing was signed.',
  // ★ Distinct from `failed` on purpose (2026-08-09). "Sign-in did not complete"
  // reads as "your credentials are wrong" and sends the reader off to re-check a
  // username that was never the problem. When the server tells us it could not
  // reach Hive, say that, and say whose problem it is.
  unreachable: 'Could not reach Hive to verify your sign-in. This is on our side, not your account. Please try again in a moment.'
};

interface KeychainSigninProps {
  /** Where to land after a successful sign-in. Defaults to the feed; the
   *  in-context dialog passes the page the user was acting on, so a "Write"
   *  click still ends at the composer. */
  redirectTo?: string;
}

const KeychainSignin: FC<KeychainSigninProps> = ({ redirectTo = '/' }) => {
  const router = useRouter();
  // ★★★ THE FIRST ARGUMENT IS `authenticateOnBackend`, AND IT MUST STAY TRUE
  // (2026-08-09). It was hardcoded `false`, which routed `signIn()` down
  // `verifyLogin()` — a function that builds a `{isLoggedIn: true}` object in
  // the browser and contacts nobody. `POST /api/auth/login` is the only place a
  // Hive session is ever saved, so with `false` the server was never told anyone
  // signed in: no cookie existed, and `/api/users/me` — which the whole app asks
  // on every mount — correctly answered "signed out" on every refresh and every
  // navigation home. `/api/feed/for-you` saw no viewer and served
  // `trending-fallback / degraded: anonymous`, which is why the feed looked
  // identical signed in. One cause, both reported symptoms.
  //
  // Five earlier fixes all aimed downstream of this — when to refetch, whether a
  // failed request counts as a logout, an epoch check, a log line. None could
  // work: the client was asking an honest question and getting an honest answer.
  //
  // Do NOT make this configurable. `siteConfig.loginAuthenticateOnBackend` reads
  // `LOGIN_AUTHENTICATE_ON_BACKEND`, which is absent from `apps/blog/.env.local`
  // and `"no"` in `.env.blog`, so wiring it here would restore the bug quietly.
  // Lumen has no working signed-out mode: every `/api/lite/*` route, the feed,
  // moderation and notifications all read the session cookie server-side.
  // Guarded by `qa/harness/real-login-session-proof.mjs`, which signs with a real
  // key and fails if the browser ends up without a session.
  const { signAuth, submitAuth } = useProcessAuth(true, false);
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detected, setDetected] = useState<boolean | null>(null);

  useEffect(() => {
    // Extensions inject after load; one check on mount can race them.
    const check = () => setDetected(typeof window !== 'undefined' && 'hive_keychain' in window);
    check();
    const timer = setTimeout(check, 1200);
    return () => clearTimeout(timer);
  }, []);

  const signIn = async () => {
    const name = username.trim().toLowerCase().replace(/^@/, '');
    if (!name) {
      setError(COPY.needUsername);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Posting authority: everything Lumen does day to day is a posting action.
      await signAuth({ loginType: LoginType.keychain, username: name, keyType: KeyType.posting, remember: false });
      await submitAuth();
      router.push(redirectTo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The server answers 503 with an exposed message when the chain was
      // unreachable (see api-handlers/auth/login.ts). Prefer what it actually
      // said; fall back to our own wording when the request never got an answer
      // at all — an aborted or failed fetch is the same story from the reader's
      // side, and it is NOT a credential problem either way.
      const status = (err as { response?: Response })?.response?.status;
      const serverMessage = (err as { data?: { error?: { message?: string } } })?.data?.error?.message;
      if (status === 503) {
        setError(serverMessage || COPY.unreachable);
      } else if (status === undefined && /fetch|network|abort|timeout/i.test(message)) {
        setError(COPY.unreachable);
      } else if (/cancel|reject|denied/i.test(message)) {
        setError(COPY.cancelled);
      } else {
        setError(COPY.failed);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="keychain-row"
        // Auto height with padding, matching the wallet rows above (fuckery list C4).
        className="flex w-full cursor-pointer items-center gap-3 rounded-card border border-line-11 bg-surface-1 px-4 py-3 text-left hover:border-line-brand-10 hover:bg-surface-6"
      >
        {/* ★ THE REAL HIVE KEYCHAIN MARK (2026-08-09, owner-supplied) — was the
            letter "K" on a red plate. The official asset carries its own black
            plate, so it is clipped to the same 9px radius the other rows use
            rather than being placed on one. */}
        <img
          src="/logos/hive-keychain.png"
          alt=""
          aria-hidden
          width={34}
          height={34}
          className="h-[34px] w-[34px] flex-shrink-0 rounded-control"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] leading-[24px] font-semibold text-ink-2">{COPY.title}</span>
          <span className="block text-caption text-ink-10">{COPY.sub}</span>
        </span>
        {/* ★ TOP-ALIGNED, NOT CENTRED (fuckery list C6). Centring a one-line chip
            against a two-line text block floated it between the title and the
            subtitle, so it read as a label for the subtitle. It describes the
            METHOD, so it sits level with the method's name. */}
        {detected ? (
          <span className="mt-0.5 flex-shrink-0 self-start rounded-full bg-surface-ok-3 px-2.5 py-1 text-caption font-semibold text-ink-ok-2">
            {COPY.detected}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="mt-2.5 rounded-card border border-line-2 bg-surface-4 p-4">
          <label htmlFor="keychain-username" className="block text-caption font-medium text-ink-8">
            {COPY.usernameLabel}
          </label>
          <div className="mt-1.5 flex items-center rounded-control border border-line-11 bg-surface-1 px-3 focus-within:border-line-brand-10">
            <span className="text-[15px] leading-[24px] text-ink-14">@</span>
            <input
              id="keychain-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void signIn();
              }}
              placeholder={COPY.placeholder}
              autoComplete="username"
              spellCheck={false}
              data-testid="keychain-username"
              className="h-11 w-full bg-transparent px-1.5 text-[15px] leading-[24px] text-ink-2 outline-none placeholder:text-ink-14"
            />
          </div>
          <button
            onClick={() => void signIn()}
            disabled={busy || detected === false}
            data-testid="keychain-signin"
            className="mt-3 h-12 w-full cursor-pointer rounded-control bg-surface-43 text-[15px] leading-[24px] font-semibold text-ink-27 hover:bg-surface-40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? COPY.working : COPY.submit}
          </button>
          {detected === false ? (
            <p className="mt-2.5 text-caption text-ink-warn-3">{COPY.notDetected}</p>
          ) : null}
          {error ? <p className="mt-2.5 text-caption text-ink-warn-3">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
};

export default KeychainSignin;
