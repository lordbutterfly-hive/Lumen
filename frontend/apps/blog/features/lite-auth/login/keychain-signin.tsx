'use client';

import { FC, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useProcessAuth } from '@smart-signer/components/auth/process';
import { KeyType, LoginType } from '@smart-signer/types/common';

/**
 * Hive Keychain sign-in — the ONLY Hive-key path Lumen offers, and it does not
 * touch a single denser login component.
 *
 * ★ OPERATOR RULING 2026-08-01: Lumen has four ways in — Google, EVM wallet and
 * Bitcoin wallet (all Lumen Lite, via Reown for the two wallets) and Hive
 * Keychain for people who already have a Hive account. Everything else is
 * stripped from login.
 *
 * WHY THIS FILE EXISTS RATHER THAN A FILTERED LIST. Restricting the denser
 * method list was not enough: the panel handed off to `DialogLogin` ->
 * smart-signer's `SignInForm`, whose FIRST step is `SAFE_STORAGE_LOGIN` — the
 * hbauth "encrypt your keys in this browser" screen — with Keychain reachable
 * only after clicking through to "Other sign in options". So the denser flow,
 * its safe-storage step and its key-type toggle were all still in the path.
 * This component talks to `useProcessAuth` directly: one field, one button,
 * posting authority, done.
 *
 * Keychain needs a username because the signature is bound to a Hive account —
 * that is the one input, and it is not negotiable. Nothing here ever handles a
 * private key: the extension signs and returns a signature.
 */

const COPY = {
  title: 'Already on Hive?',
  sub: 'Sign in with the Hive Keychain browser extension. Your keys stay in the extension — Lumen never sees them.',
  usernameLabel: 'Hive username',
  placeholder: 'yourname',
  submit: 'Sign in with Keychain',
  working: 'Waiting for Keychain…',
  notDetected: 'Keychain not detected',
  install: 'Install the Hive Keychain extension, then reload this page.',
  needUsername: 'Enter your Hive username.',
  failed: 'That sign-in did not complete. Please try again.',
  cancelled: 'You cancelled — nothing was signed.'
};

interface KeychainSigninProps {
  /** Where to land after a successful sign-in. Defaults to the feed. The
   *  in-context dialog passes the page the user was trying to act on, so a
   *  "Write" click still ends at the composer. */
  redirectTo?: string;
}

const KeychainSignin: FC<KeychainSigninProps> = ({ redirectTo = '/' }) => {
  const router = useRouter();
  const { signAuth, submitAuth } = useProcessAuth(false, false);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detected, setDetected] = useState<boolean | null>(null);

  useEffect(() => {
    // Extensions inject after load; a single check on mount can race them.
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
      setError(/cancel|reject|denied/i.test(message) ? COPY.cancelled : COPY.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-[18px] border border-[#ebebeb] bg-white p-6 shadow-[0_1px_2px_rgba(20,18,10,0.03)]">
      <h2 className="text-[17px] font-semibold text-[#161511]">{COPY.title}</h2>
      <p className="mt-1.5 text-[13px] leading-[1.55] text-[#6b7280]">{COPY.sub}</p>

      <label htmlFor="keychain-username" className="mt-4 block text-[13px] font-medium text-[#4b5563]">
        {COPY.usernameLabel}
      </label>
      <div className="mt-1.5 flex items-center rounded-[10px] border border-[#e4e6e9] bg-white px-3 focus-within:border-[#c0392b]">
        <span className="text-[15px] text-[#9ca3af]">@</span>
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
          className="h-11 w-full bg-transparent px-1.5 text-[15px] text-[#161511] outline-none placeholder:text-[#9ca3af]"
        />
      </div>

      <button
        onClick={() => void signIn()}
        disabled={busy || detected === false}
        data-testid="keychain-signin"
        className="mt-3.5 h-12 w-full cursor-pointer rounded-[12px] bg-[#161511] text-[15px] font-semibold text-white hover:bg-[#2b2822] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? COPY.working : COPY.submit}
      </button>

      {detected === false ? (
        <p className="mt-3 text-[13px] leading-[1.55] text-[#b45309]">
          <span className="font-medium">{COPY.notDetected}</span> — {COPY.install}
        </p>
      ) : null}
      {error ? <p className="mt-3 text-[13px] leading-[1.55] text-[#b45309]">{error}</p> : null}
    </div>
  );
};

export default KeychainSignin;
