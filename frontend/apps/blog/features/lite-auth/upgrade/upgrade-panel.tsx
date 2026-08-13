'use client';

import { FC, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { csrfHeaderName } from '@smart-signer/lib/csrf-protection';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useNameSuggest } from './use-name-suggest';
import { AccountKeys, generateAccountKeys, ownerKeyMatches, publicKeysOf } from './browser-keys';
import { fetchAuthMethods, requestStepUp, type LiteAuthMethodName } from '@/blog/lib/lite/client/lite-security';
import { connectWallet, signMessageWith, walletErrorMessage, type WalletChain } from '../wallet/appkit';
import GoogleSignIn, { googleConfigured } from '../login/google-signin';

/**
 * Upgrade a lite account to a real Hive account.
 *
 * ★ THE KEYS ARE MADE HERE, IN THIS BROWSER, AND NEVER LEAVE IT. Only the four public
 * keys are sent to the server. A Hive master password is the account's owner key, so
 * any copy anywhere else — a server that mints it, a log line, an encrypted row in our
 * database — is a party that could take the account later. This screen is what makes
 * "your own keys" true rather than a slogan.
 *
 * That has one consequence the flow is built around: nobody can re-issue these keys.
 * So the order is deliberate — **save first, create second**. The keys are shown and
 * explicitly acknowledged BEFORE the account is created, which means at every instant
 * either the account does not exist yet, or the user already has its keys. There is no
 * window in between for a dropped connection to strand anyone.
 *
 * Keys are also name-bound (Hive mixes the account name into the derivation), so they
 * are generated only after the name is settled, and thrown away if the name has to
 * change.
 */

interface UpgradeResponse {
  status?: string;
  code?: string;
  message?: string;
  hiveAccountName?: string;
  resumed?: boolean;
}

/**
 * The account's owner keys, waiting for it to appear on chain.
 *
 * `broadcast` returns when a node accepts the transaction into its mempool — the
 * account is not in a block yet, so an immediate read finds nothing. Without the wait
 * this check silently did nothing in the normal case, which is worse than not having
 * it: the screen would report "verified" having verified naught.
 */
async function onChainOwnerKeys(account: string): Promise<string[] | null> {
  const { getAccountFull } = await import('@transaction/lib/hive-api');
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const found = await getAccountFull(account);
      const auths = (found?.owner?.key_auths ?? []) as [string, number][];
      if (auths.length) return auths.map((auth) => String(auth[0]));
    } catch {
      // Not visible yet, or a node hiccup — both are "try again".
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return null;
}

interface StatusResponse {
  state?: 'lite' | 'upgraded' | 'created_not_linked' | 'still_settling';
  hiveAccountName?: string | null;
}

const COPY = {
  title: 'Upgrade to a full Hive account',
  intro:
    'Your Lumen account posts through Lumen. A full Hive account is yours alone: your own keys, your own name on chain, and you keep your posting history.',
  namePick: 'Choose your Hive account name',
  nameHint: 'Lowercase letters, numbers and dashes. 3–16 characters. This cannot be changed later.',
  nameLowercased: (lower: string) =>
    `Hive names are lowercase, so yours will be created as “${lower}”.`,
  // The one thing this screen must set expectations about. Lumen never reserved the
  // handle on Hive — reserving one means creating the account, which permanently
  // spends a token — so a Hive account needs its own, different name.
  nameWarning:
    'Your Hive account needs a new name — your Lumen name isn’t reserved on Hive and can’t carry over. Pick something close to it. On Lumen, your posts, followers and history all move to the new name.',
  suggestionsLabel: 'Available instead:',
  historyNote: 'On Lumen, your posts, your history and your profile all move to your new name.',
  // Honest about what upgrading does NOT do. Everything written before the upgrade was
  // signed by Lumen's shared publishing account, and a Hive post cannot change author,
  // so other front ends will show that back catalogue under Lumen, not under the new
  // account. Saying so here is cheaper than a user discovering it on peakd.
  historyLimit:
    'Posts you wrote before upgrading stay published through Lumen’s account on chain, so other Hive sites won’t list them under your new name. From here on, everything you post is yours on chain.',
  continue: 'Continue',
  generating: 'Creating your keys…',

  keysTitle: 'Save these keys — then we create your account',
  keysIntro:
    'These were just generated in your browser. Lumen never receives them and cannot make them again, so save them somewhere safe before continuing.',
  keysWarning:
    'Whoever has your master password owns the account. Store it somewhere only you can reach — a password manager, or written down offline. If you lose it, nobody can get the account back for you.',
  masterLabel: 'Master password (recovers everything)',
  acknowledge: 'I have saved these keys somewhere safe',
  create: 'Create my Hive account',
  createWithBtc: 'Confirm with your Bitcoin wallet & create',
  createWithEvm: 'Confirm with your Ethereum wallet & create',
  stepUpExplain:
    'One last check: confirm with the wallet or Google account you signed up with. Creating your Hive account cannot be undone, so we ask for it here rather than trusting the browser session alone.',
  stepUpFailed: 'Could not confirm it was you — please try again.',
  stepUpUnavailable: 'Sign-in confirmation is unavailable right now. Please try again later.',
  creating: 'Creating your account…',
  copy: 'Copy',
  copied: 'Copied',

  doneTitle: 'Your Hive account is live',
  doneBody: 'Sign in anywhere on Hive with the master password you just saved.',
  finish: 'Done',
  verifying: 'Checking your keys against Hive…',
  verifyUnknown:
    'Your account is being written to Hive. We could not confirm your keys against it yet — reload this page in a minute to check.',
  // Shown only if the account on chain does NOT hold the key this browser derived —
  // which would mean the keys just saved open nothing. Loud on purpose.
  keyMismatch:
    'WARNING: the account that was created does not carry the keys shown on this page. Do not rely on them. Contact support with your account name before doing anything else.',
  notLinkedTitle: 'Your account was created',
  notLinkedBody:
    'Your Hive account exists and the keys you saved are valid — but Lumen could not finish linking it to your profile. Reload this page in a moment; if it keeps happening, contact support rather than creating another account.',

  alreadyTitle: 'You already have a Hive account',
  alreadyBody:
    'An earlier upgrade completed, so no new account was created. Sign in with the keys you saved then — Lumen never had a copy and cannot re-issue them.',

  unavailable:
    'Account creation isn’t switched on yet. Nothing has changed on your account — try again later.',
  keygenFailed: 'Your browser could not generate the keys. Reload the page and try again.',
  settling:
    'Your last attempt is still settling on Hive. Give it a minute, then reload this page.',
  rateLimited: 'Too many attempts today — please try again tomorrow.',
  networkError: 'Network error — your account was not created. Please try again.'
};

/** Errors that mean "this name will not work" — the keys must be regenerated for a new one. */
const NAME_ERRORS = new Set(['name_taken', 'name_on_chain', 'invalid_name', 'name_must_differ']);

type Stage = 'name' | 'keys' | 'done' | 'already' | 'notLinked';

const UpgradePanel: FC = () => {
  const router = useRouter();
  const { user } = useUserClient();
  /**
   * ★★★ SAME RACE AS security-panel.tsx, SAME TIER COMPOUND (2026-08-12, G1).
   * The entry gate below used raw `useUserClient()`'s `user?.isLoggedIn` —
   * blank during SSR — so a genuinely signed-in lite reader always saw "Sign
   * in with your Lumen account to upgrade" for the hydration + fetch window,
   * on the screen that starts the irreversible key-generation flow.
   * `identity.isLoggedIn` answers that half immediately from the session
   * cookie. `account_tier` (needed for the rest of the gate, and for the
   * `useEffect` below that seeds the status check / name suggestions) still
   * does not exist on `identity`, so it stays off raw `user`, and the render
   * waits for `identity.clientAnswered` — the same `[QUERY_KEY.user]` query
   * `account_tier` comes from — before trusting it, rather than mounting the
   * name-picker (or the wrong message) on a guess. The `useEffect` itself is
   * deliberately NOT switched to `identity`: it is a run-once effect keyed on
   * `user?.isLoggedIn`/`user?.account_tier` together (`started` latches after
   * the first pass), and firing it early off `identity` while those two raw
   * fields are still unresolved would let it complete its one pass with an
   * empty `account_tier` and never retry the `checkName` seed once the real
   * tier lands.
   */
  const identity = useSessionIdentity();
  const { status: nameStatus, check: checkName } = useNameSuggest();
  const [stage, setStage] = useState<Stage>('name');
  const [name, setName] = useState('');
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState<AccountKeys | null>(null);
  const [hiveName, setHiveName] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // F-L1 step-up: which credentials this account can prove with, and (for
  // Google, whose button captures the nonce at render time) a nonce held ready.
  const [methods, setMethods] = useState<LiteAuthMethodName[] | null>(null);
  const [googleNonce, setGoogleNonce] = useState<string | null>(null);

  /**
   * On mount, ask the server where this account actually stands before offering to
   * create anything.
   *
   * This is not a nicety. A user whose previous attempt succeeded on chain but whose
   * response never arrived would otherwise be shown a fresh set of keys for an account
   * that already exists — keys that open nothing, presented as if they were theirs.
   * The status call settles any in-flight attempt server-side (using the public owner
   * key, no secret involved) and tells us plainly.
   */
  useEffect(() => {
    if (started || !user?.isLoggedIn) return;
    setStarted(true);
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/api/account/upgrade', {
          cache: 'no-store',
          headers: { [csrfHeaderName]: '1' }
        });
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as StatusResponse | null;
          if (!cancelled && body?.state === 'upgraded' && body.hiveAccountName) {
            setHiveName(body.hiveAccountName);
            setStage('already');
            return;
          }
          // An account exists for this person but Lumen has not linked it. Offering the
          // name picker here is what walks somebody into a SECOND account.
          if (!cancelled && body?.state === 'created_not_linked') {
            setHiveName(body.hiveAccountName ?? '');
            setStage('notLinked');
            return;
          }
          if (!cancelled && body?.state === 'still_settling') {
            setError(COPY.settling);
            return;
          }
        }
      } catch {
        // Offline or the endpoint is unavailable: fall through to the picker. The
        // upgrade POST performs the same reconciliation server-side.
      }
      if (cancelled) return;
      // Seed the name suggestions off their Lumen handle. The field is left EMPTY on
      // purpose: that handle is the one name this flow can never grant, so filling it
      // in would put a guaranteed rejection in the box.
      const current = user?.username;
      if (current && user?.account_tier === 'lite') checkName(current);
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.isLoggedIn, user?.username, user?.account_tier, started, checkName]);

  /** Name settled → derive the keys locally and show them. Nothing is sent yet. */
  const generate = useCallback(async () => {
    const chosen = name.trim().toLowerCase();
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const generated = await generateAccountKeys(chosen);
      setKeys(generated);
      setHiveName(chosen);
      setAcknowledged(false);
      setStage('keys');
    } catch {
      setError(COPY.keygenFailed);
    } finally {
      setBusy(false);
    }
  }, [name]);

  /**
   * F-L1 — which credentials this account owns, so the confirm step asks for one
   * it can actually produce. Loaded once the panel is live; a failure leaves
   * `methods` null and the wallet path is offered, which is what every account
   * created so far has.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await fetchAuthMethods();
      if (cancelled) return;
      setMethods(list ? list.methods.map((m) => m.method) : null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The Google button captures its nonce when it initialises, so unlike the
  // wallet path it cannot be fetched at click time. Held ready while the keys
  // are on screen.
  const googleOnly = methods !== null && methods.length > 0 && methods.every((m) => m === 'google_passkey');
  useEffect(() => {
    if (stage !== 'keys' || !googleOnly || !googleConfigured()) return;
    let cancelled = false;
    (async () => {
      const stepUp = await requestStepUp();
      if (!cancelled) setGoogleNonce(stepUp?.nonce ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [stage, googleOnly]);

  /**
   * Prove control of a wallet this account already owns. A fresh nonce per
   * attempt (single-use, user-bound) and a fresh signature — the session cookie
   * alone is deliberately not enough to reach the irreversible step.
   */
  const walletStepUp = async (chain: WalletChain): Promise<Record<string, unknown> | null> => {
    const address = await connectWallet(chain);
    const stepUp = await requestStepUp();
    if (!stepUp) return null;
    const message = chain === 'btc' ? stepUp.messages.btc : stepUp.messages.evm;
    if (!message) return null;
    const signature = await signMessageWith(chain, address, message);
    return { method: chain, address, signature, nonce: stepUp.nonce };
  };

  /** Keys saved → confirm with an existing credential, then create the account. */
  const createAccount = async (stepUpProof?: Record<string, unknown>) => {
    if (!keys) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/account/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [csrfHeaderName]: '1' },
        body: JSON.stringify({ newName: hiveName, publicKeys: publicKeysOf(keys), stepUp: stepUpProof })
      });
      const body = (await res.json().catch(() => null)) as UpgradeResponse | null;

      if (res.status === 503) {
        setError(body?.message || COPY.unavailable);
        return;
      }
      if (res.status === 429) {
        setError(body?.message || COPY.rateLimited);
        return;
      }
      if (body?.code === 'still_settling') {
        setError(COPY.settling);
        return;
      }
      if (body?.code === 'already_upgraded') {
        // Their account was made by an earlier attempt; these keys are not its keys.
        // The server sends the name they ACTUALLY hold — showing the one they just
        // typed would name an account that is not theirs.
        setKeys(null);
        if (body.hiveAccountName) setHiveName(body.hiveAccountName);
        setStage('already');
        return;
      }
      if (body?.code === 'created_not_linked') {
        setKeys(null);
        if (body.hiveAccountName) setHiveName(body.hiveAccountName);
        setStage('notLinked');
        return;
      }
      if (body?.code && NAME_ERRORS.has(body.code)) {
        // Keys are derived FROM the name, so a different name needs different keys.
        // Discarding them here is what stops a user saving keys that open nothing.
        setKeys(null);
        setAcknowledged(false);
        setStage('name');
        setError(body.message || 'That name is not available — please choose another.');
        return;
      }
      if (!res.ok || body?.status !== 'ok') {
        setError(body?.message || 'Could not create the account. Please try again.');
        return;
      }
      if (body.resumed) {
        // The account already existed from an earlier attempt of theirs, so these
        // freshly generated keys are not its keys and must never be presented as such.
        setKeys(null);
        setHiveName(body.hiveAccountName || hiveName);
        setStage('already');
        return;
      }
      const created = body.hiveAccountName || hiveName;
      setHiveName(created);
      setStage('done');

      // ★ The one question the user cannot answer for themselves: does the password
      // they just wrote down actually open the account that now exists? Everything
      // else on this path is recoverable; this is not. A fresh account can take a few
      // seconds to appear, so silence is treated as "not yet", never as failure — only
      // a definite mismatch raises the alarm.
      // Its OWN try/finally. The account exists at this point — a failure while
      // CHECKING it must never fall into the outer catch, which says "your account was
      // not created". That would print a flat contradiction on the same screen as
      // "Your Hive account is live", about something irreversible.
      setVerifying(true);
      try {
        const chainOwners = await onChainOwnerKeys(created);
        if (!chainOwners) {
          // Say so. "We could not check" and "we checked and it is fine" must never
          // look the same on this screen.
          setNotice(COPY.verifyUnknown);
        } else {
          const matches = await Promise.all(
            chainOwners.map((key) => ownerKeyMatches(created, keys.masterPassword, key))
          );
          if (!matches.some(Boolean)) setError(COPY.keyMismatch);
        }
      } catch {
        setNotice(COPY.verifyUnknown);
      } finally {
        setVerifying(false);
      }
    } catch {
      setError(COPY.networkError);
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

  if (!identity.isLoggedIn) {
    return (
      <div className="mx-auto max-w-[560px] p-6 text-[15px] text-[#4b5563]">
        Sign in with your Lumen account to upgrade.
      </div>
    );
  }
  if (!identity.clientAnswered) {
    // Genuinely signed in per the session cookie, but `account_tier` — which the
    // rest of this gate and the status-check effect above both need — isn't
    // confirmed yet. Neither the sign-in message nor the name picker is honest
    // here.
    //
    // ★ AND "ISN'T CONFIRMED YET" CAN MEAN "NEVER WILL BE" (2026-08-13,
    // adversarial review S4). `clientAnswered` cannot flip true off a failed read,
    // so this "Loading…" was permanent. It still refuses to guess the tier — the
    // gate below stays exactly as closed as it was — it just stops implying that
    // waiting will help.
    if (identity.sessionUnavailable) {
      return (
        <div className="mx-auto max-w-[560px] p-6">
          <p className="text-[15px] text-[#4b5563]">
            Couldn’t check your account just now, so we can’t start an upgrade.
          </p>
          <button
            type="button"
            onClick={identity.retrySession}
            className="mt-3 rounded-[10px] border border-[#e4e6e9] px-4 py-2 text-[14px] font-semibold text-[#3f4650] hover:bg-[#f6f7f8]"
          >
            Try again
          </button>
        </div>
      );
    }
    return <div className="mx-auto max-w-[560px] p-6 text-[15px] text-[#9ca3af]">Loading…</div>;
  }
  if (!user?.isLoggedIn || user.account_tier !== 'lite') {
    return (
      <div className="mx-auto max-w-[560px] p-6 text-[15px] text-[#4b5563]">
        Sign in with your Lumen account to upgrade.
      </div>
    );
  }

  // ── an account already exists ───────────────────────────────────────────────
  if (stage === 'already') {
    return (
      <div className="mx-auto max-w-[560px] p-6" data-testid="upgrade-already">
        <h1 className="font-serif text-2xl font-semibold text-[#161511]">{COPY.alreadyTitle}</h1>
        <p className="mt-2 text-[15px] leading-[1.55] text-[#4b5563]">
          Your account is <strong>@{hiveName}</strong>. {COPY.alreadyBody}
        </p>
        <button
          onClick={() => router.replace('/')}
          className="mt-5 h-12 w-full cursor-pointer rounded-xl bg-[#c0392b] text-[15px] font-semibold text-white hover:bg-[#a5301f]"
        >
          {COPY.finish}
        </button>
      </div>
    );
  }

  // ── created, but our own record is incomplete ───────────────────────────────
  if (stage === 'notLinked') {
    return (
      <div className="mx-auto max-w-[560px] p-6" data-testid="upgrade-not-linked">
        <h1 className="font-serif text-2xl font-semibold text-[#161511]">{COPY.notLinkedTitle}</h1>
        <p className="mt-2 text-[15px] leading-[1.55] text-[#4b5563]">
          <strong>@{hiveName}</strong> — {COPY.notLinkedBody}
        </p>
      </div>
    );
  }

  // ── created ─────────────────────────────────────────────────────────────────
  if (stage === 'done') {
    return (
      <div className="mx-auto max-w-[560px] p-6" data-testid="upgrade-done">
        <h1 className="font-serif text-2xl font-semibold text-[#161511]">{COPY.doneTitle}</h1>
        <p className="mt-2 text-[15px] leading-[1.55] text-[#4b5563]">
          <strong>@{hiveName}</strong> — {COPY.doneBody}
        </p>
        {verifying ? <p className="mt-2 text-[13px] text-[#9ca3af]">{COPY.verifying}</p> : null}
        {notice ? <p className="mt-2 text-[13px] leading-[1.55] text-[#b45309]">{notice}</p> : null}
        {error ? (
          <p className="mt-3 rounded-xl border border-[#f6c6c0] bg-[#fdf2f0] p-4 text-[14px] font-semibold leading-[1.55] text-[#8c2b1e]">
            {error}
          </p>
        ) : null}
        <button
          onClick={() => router.replace('/')}
          className="mt-5 h-12 w-full cursor-pointer rounded-xl bg-[#c0392b] text-[15px] font-semibold text-white hover:bg-[#a5301f]"
        >
          {COPY.finish}
        </button>
      </div>
    );
  }

  // ── keys: save them, then create ────────────────────────────────────────────
  if (stage === 'keys' && keys) {
    const rows: [string, string][] = [
      [COPY.masterLabel, keys.masterPassword],
      ['Owner key', keys.owner.privateWif],
      ['Active key', keys.active.privateWif],
      ['Posting key', keys.posting.privateWif],
      ['Memo key', keys.memo.privateWif]
    ];
    return (
      <div className="mx-auto max-w-[640px] p-6" data-testid="upgrade-keys">
        <h1 className="font-serif text-2xl font-semibold text-[#161511]">{COPY.keysTitle}</h1>
        <p className="mt-2 text-[15px] leading-[1.55] text-[#4b5563]">
          For <strong>@{hiveName}</strong>. {COPY.keysIntro}
        </p>
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
            data-testid="upgrade-ack"
          />
          {COPY.acknowledge}
        </label>
        {/*
          F-L1 — creating the account is irreversible, so it takes a fresh proof
          from the credential this account was created with, not just the session
          cookie. The spec has always required this for account-security actions;
          the button below is where it is asked for.
        */}
        <p className="mt-4 text-[13px] leading-[1.55] text-[#4b5563]">{COPY.stepUpExplain}</p>
        {googleOnly ? (
          googleConfigured() && googleNonce ? (
            <div className="mt-3" data-testid="upgrade-stepup-google">
              <GoogleSignIn
                key={googleNonce}
                nonce={googleNonce}
                onIdToken={(idToken) => {
                  if (!acknowledged || busy) return;
                  void createAccount({ method: 'google', idToken, nonce: googleNonce });
                }}
                onError={() => setError(COPY.stepUpFailed)}
              />
            </div>
          ) : (
            <p className="mt-3 text-[13px] leading-[1.55] text-[#b45309]">{COPY.stepUpUnavailable}</p>
          )
        ) : (
          (['btc', 'evm'] as WalletChain[])
            .filter((chain) => methods === null || methods.includes(chain === 'btc' ? 'btc_wallet' : 'evm_wallet'))
            .map((chain) => (
              <button
                key={chain}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const proof = await walletStepUp(chain);
                    if (!proof) {
                      setError(COPY.stepUpFailed);
                      return;
                    }
                    await createAccount(proof);
                  } catch (err) {
                    setError(walletErrorMessage(err));
                  } finally {
                    setBusy(false);
                  }
                }}
                disabled={!acknowledged || busy}
                data-testid={chain === 'btc' ? 'upgrade-create' : `upgrade-create-${chain}`}
                className="mt-3 h-12 w-full cursor-pointer rounded-xl bg-[#c0392b] text-[15px] font-semibold text-white hover:bg-[#a5301f] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? COPY.creating : chain === 'btc' ? COPY.createWithBtc : COPY.createWithEvm}
              </button>
            ))
        )}
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
          data-testid="upgrade-name"
          className="min-w-0 flex-1 border-0 font-sans text-base font-semibold text-[#161511] outline-none"
        />
      </div>
      {nameStatus.state === 'unavailable' ? (
        <>
          <p className="mt-2 text-[12.5px] font-medium text-[#b45309]">{nameStatus.reason}</p>
          {nameStatus.suggestions.length > 0 ? (
            <div className="mt-2.5">
              <p className="text-[12.5px] text-[#4b5563]">{COPY.suggestionsLabel}</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {nameStatus.suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => {
                      setName(suggestion);
                      checkName(suggestion);
                    }}
                    className="cursor-pointer rounded-lg border border-[#e4e6e9] px-2.5 py-1 text-[13px] font-semibold text-[#161511] hover:bg-[#f9fafb]"
                  >
                    @{suggestion}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-[#4b5563]">{COPY.historyNote}</p>
            </div>
          ) : null}
        </>
      ) : null}
      {/* ★ TELL THEM THE NAME CHANGED, BEFORE THE IRREVERSIBLE STEP.
          Hive account names are lowercase-only, so normalising the input is
          CORRECT — that part is not a bug and is not being changed here. What
          was wrong is that it happened in silence: the field accepted
          "QAUpper-Case" as valid, went green, and the first time the reader saw
          `qaupper-case` was on the screen that generates five irreversible
          private keys for it. A name you cannot change later should never be
          altered without saying so. */}
      {name.trim() && name.trim() !== name.trim().toLowerCase() ? (
        <p className="mt-2 text-xs leading-[1.55] text-[#b45309]">
          {COPY.nameLowercased(name.trim().toLowerCase())}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-[#9ca3af]">{COPY.nameHint}</p>
      <p className="mt-2 text-xs leading-[1.55] text-[#9ca3af]">{COPY.nameWarning}</p>
      <p className="mt-2 text-xs leading-[1.55] text-[#9ca3af]">{COPY.historyLimit}</p>

      <button
        onClick={generate}
        disabled={busy || nameStatus.state !== 'available'}
        data-testid="upgrade-continue"
        className="mt-5 h-12 w-full cursor-pointer rounded-xl bg-[#c0392b] text-[15px] font-semibold text-white hover:bg-[#a5301f] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? COPY.generating : COPY.continue}
      </button>
      {error ? <p className="mt-3 text-[13px] leading-[1.55] text-[#b45309]">{error}</p> : null}
    </div>
  );
};

export default UpgradePanel;
