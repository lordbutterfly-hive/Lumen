'use client';

import { FC, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { csrfHeaderName } from '@smart-signer/lib/csrf-protection';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useLiteLogin } from '../login/use-lite-login';

/**
 * Upgrade a lite account to a real Hive account.
 *
 * The keys are shown once and Lumen keeps no long-term copy, so this screen is the
 * user's only chance to keep them. That shapes the whole flow: nothing navigates away
 * on its own, the keys must be explicitly acknowledged, and the copy says plainly that
 * losing them means losing the account.
 *
 * It is not the ONLY chance any more, though, and that matters. The server holds the
 * keys encrypted until they are acknowledged (migration 0015), so this component checks
 * for owed keys on mount — a user who closed the tab mid-flow lands back here and gets
 * them, instead of an account nobody can open. Acknowledging is what erases the stored
 * copy, which is why the button posts before it navigates.
 */

interface KeyPair {
  publicKey: string;
  /**
   * The server field is `privateWif` (see lib/lite/upgrade/account-creator.ts). This
   * interface previously said `privateKey`, which type-checks fine because the fetch
   * body is cast, and rendered the string "undefined" for every key while the user
   * ticked "I have saved these" — the exact unrecoverable outcome this screen exists to
   * prevent. Keep this name matched to the server type.
   */
  privateWif: string;
}

interface GeneratedKeys {
  masterPassword: string;
  owner: KeyPair;
  active: KeyPair;
  posting: KeyPair;
  memo: KeyPair;
}

interface UpgradeResponse {
  status?: string;
  code?: string;
  message?: string;
  hiveAccountName?: string;
  keys?: GeneratedKeys;
  revealId?: string;
  resumed?: boolean;
}

const COPY = {
  title: 'Upgrade to a full Hive account',
  intro:
    'Your Lumen account posts through Lumen. A full Hive account is yours alone: your own keys, your own name on chain, and you keep your posting history.',
  namePick: 'Choose your Hive account name',
  nameHint: 'Lowercase letters, numbers and dashes. 3–16 characters. This cannot be changed later.',
  submit: 'Create my Hive account',
  working: 'Creating your account…',
  unavailable:
    'Account creation isn’t switched on yet. Nothing has changed on your account — try again later.',
  unreadable:
    'Your account was created, but its keys can no longer be read. Please contact support before doing anything else — do not create another account.',
  keysTitle: 'Save these keys now',
  keysResumedTitle: 'Your keys are still waiting',
  keysWarning:
    'This is your one chance to keep these. Once you confirm below, Lumen erases its copy — after that nobody, including us, can recover the account.',
  keysResumedNote:
    'You left before confirming, so we held these for you. They are erased the moment you confirm.',
  masterLabel: 'Master password (recovers everything)',
  acknowledge: 'I have saved these keys somewhere safe',
  done: 'Confirm and finish',
  saving: 'Finishing…',
  ackFailed: 'Could not confirm just now — your keys are still safe. Try the button again.',
  copy: 'Copy',
  copied: 'Copied'
};

const UpgradePanel: FC = () => {
  const router = useRouter();
  const { user } = useUserClient();
  const { nameStatus, checkName } = useLiteLogin();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState<GeneratedKeys | null>(null);
  const [hiveName, setHiveName] = useState('');
  const [revealId, setRevealId] = useState<string | null>(null);
  const [resumed, setResumed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const adoptReveal = useCallback((body: UpgradeResponse, fallbackName: string) => {
    setKeys(body.keys ?? null);
    setHiveName(body.hiveAccountName ?? fallbackName);
    setRevealId(body.revealId ?? null);
    setResumed(Boolean(body.resumed));
  }, []);

  // Recovery: did a previous attempt create an account whose keys never reached us?
  useEffect(() => {
    if (!user?.isLoggedIn) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/account/upgrade/reveal', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as UpgradeResponse | null;
        if (!cancelled && body?.status === 'ok' && body.keys) adoptReveal(body, '');
      } catch {
        // No outstanding reveal, or the network is down. The normal flow still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.isLoggedIn, adoptReveal]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/account/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [csrfHeaderName]: '1' },
        body: JSON.stringify({ newName: name.trim().toLowerCase() })
      });
      const body = (await res.json().catch(() => null)) as UpgradeResponse | null;
      if (res.status === 503) {
        setError(COPY.unavailable);
        return;
      }
      if (body?.code === 'reveal_unreadable') {
        setError(COPY.unreadable);
        return;
      }
      if (!res.ok || body?.status !== 'ok' || !body.keys) {
        setError(body?.message || 'Could not create the account. Please try again.');
        return;
      }
      adoptReveal(body, name.trim().toLowerCase());
    } catch {
      setError('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Erase the server's copy, then leave. If the acknowledgement fails we deliberately
   * stay put: navigating away would abandon keys the user believes are confirmed.
   */
  const confirmAndFinish = async () => {
    if (!revealId) {
      router.replace('/');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/account/upgrade/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [csrfHeaderName]: '1' },
        body: JSON.stringify({ revealId })
      });
      if (!res.ok) {
        setError(COPY.ackFailed);
        return;
      }
      router.replace('/');
    } catch {
      setError(COPY.ackFailed);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard can be blocked; the value is on screen and selectable regardless.
    }
  };

  if (!user?.isLoggedIn || user.account_tier !== 'lite') {
    return (
      <div className="mx-auto max-w-[560px] p-6 text-[15px] text-[#4b5563]">
        Sign in with your Lumen account to upgrade.
      </div>
    );
  }

  // ── keys revealed: the one-time screen ──────────────────────────────────────
  if (keys) {
    const rows: [string, string][] = [
      [COPY.masterLabel, keys.masterPassword],
      ['Owner key', keys.owner.privateWif],
      ['Active key', keys.active.privateWif],
      ['Posting key', keys.posting.privateWif],
      ['Memo key', keys.memo.privateWif]
    ];
    return (
      <div className="mx-auto max-w-[640px] p-6">
        <h1 className="font-serif text-2xl font-semibold text-[#161511]">
          {resumed ? COPY.keysResumedTitle : COPY.keysTitle}
        </h1>
        <p className="mt-2 text-[15px] leading-[1.55] text-[#4b5563]">
          Your account <strong>@{hiveName}</strong> is created.
        </p>
        {resumed ? (
          <p className="mt-1.5 text-[14px] leading-[1.55] text-[#4b5563]">{COPY.keysResumedNote}</p>
        ) : null}
        <div className="mt-4 rounded-xl border border-[#f6c6c0] bg-[#fdf2f0] p-4 text-[14px] leading-[1.55] text-[#8c2b1e]">
          {COPY.keysWarning}
        </div>

        <div className="mt-4 flex flex-col gap-3">
          {rows.map(([label, value]) => (
            <div key={label} className="rounded-xl border border-[#e4e6e9] bg-white p-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[13px] font-semibold text-[#4b5563]">{label}</span>
                <button
                  onClick={() => copy(label, value)}
                  className="cursor-pointer rounded-md border border-[#e4e6e9] px-2 py-1 text-xs font-semibold text-[#4b5563] hover:bg-[#f9fafb]"
                >
                  {copied === label ? COPY.copied : COPY.copy}
                </button>
              </div>
              <code className="block break-all font-mono text-[12.5px] text-[#161511]">{value}</code>
            </div>
          ))}
        </div>

        <label className="mt-5 flex cursor-pointer items-start gap-2.5 text-[14px] text-[#4b5563]">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5"
          />
          {COPY.acknowledge}
        </label>
        <button
          onClick={confirmAndFinish}
          disabled={!acknowledged || busy}
          className="mt-4 h-12 w-full cursor-pointer rounded-xl bg-[#c0392b] text-[15px] font-semibold text-white hover:bg-[#a5301f] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? COPY.saving : COPY.done}
        </button>
        {error ? <p className="mt-3 text-[13px] leading-[1.55] text-[#b45309]">{error}</p> : null}
      </div>
    );
  }

  // ── name pick ───────────────────────────────────────────────────────────────
  const border =
    nameStatus.state === 'available'
      ? 'border-[#2f7d4f]'
      : nameStatus.state === 'unavailable'
        ? 'border-[#b45309]'
        : 'border-[#e4e6e9] focus-within:border-[#c0392b]';

  return (
    <div className="mx-auto max-w-[560px] p-6">
      <h1 className="font-serif text-2xl font-semibold text-[#161511]">{COPY.title}</h1>
      <p className="mt-2 text-[15px] leading-[1.55] text-[#4b5563]">{COPY.intro}</p>

      <label className="mt-6 block text-[13px] font-semibold text-[#4b5563]">{COPY.namePick}</label>
      <div className={`mt-1.5 flex h-12 items-center gap-2 rounded-xl border-[1.5px] px-3.5 ${border}`}>
        <span className="font-bold text-[#9ca3af]">@</span>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            checkName(e.target.value);
          }}
          spellCheck={false}
          className="min-w-0 flex-1 border-0 font-sans text-base font-semibold text-[#161511] outline-none"
        />
      </div>
      {nameStatus.state === 'unavailable' ? (
        <p className="mt-2 text-[12.5px] font-medium text-[#b45309]">{nameStatus.reason}</p>
      ) : null}
      <p className="mt-2 text-xs text-[#9ca3af]">{COPY.nameHint}</p>

      <button
        onClick={submit}
        disabled={busy || nameStatus.state !== 'available'}
        className="mt-5 h-12 w-full cursor-pointer rounded-xl bg-[#c0392b] text-[15px] font-semibold text-white hover:bg-[#a5301f] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? COPY.working : COPY.submit}
      </button>
      {error ? <p className="mt-3 text-[13px] leading-[1.55] text-[#b45309]">{error}</p> : null}
    </div>
  );
};

export default UpgradePanel;
