'use client';

/**
 * The data + crypto layer for creator DMs, kept out of the components so every
 * network call sits next to the encryption it depends on. The one rule this file
 * enforces above all: the ONLY thing sent to `/api/lite/dm/*` is ciphertext and
 * public keys. Plaintext is encrypted before a POST and decrypted after a GET, both
 * in `../lib/dm-crypto`, and never touches the wire.
 *
 * Identity note: Lumen names a participant by an ACTOR (see
 * `lib/lite/social/follow-actor.ts`) - `h:<hive>` for a Hive account, `u:<userId>`
 * for a lite one. The server is the authority on resolving those (it re-derives the
 * sender from the session and the recipient with `resolveFollowTarget`, never
 * trusting a client-supplied actor). The client therefore passes the identifier it
 * already holds: a display handle when starting a new conversation from a profile or
 * token page, and the thread's `otherActorKey` when reading or replying inside an
 * existing thread.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { csrfHeaderName } from '@smart-signer/lib/csrf-protection';
import type { User } from '@smart-signer/types/common';
import {
  decrypt,
  encrypt,
  exportPrivateKeyBase64,
  getPublicKeyBase64,
  hasStoredKeypair,
  installKeypair,
  publicKeyOfPrivateBase64,
  storedKeyVersion
} from '../lib/dm-crypto';
import {
  DeviceOnlyError,
  backupViaFor,
  canOpen,
  hasBackupMethod,
  makeBackup,
  openBackup,
  parseBackup,
  type BackupVia,
  type DmKeyBackup
} from '../lib/dm-key-backup';

const JSON_POST: HeadersInit = { 'Content-Type': 'application/json', [csrfHeaderName]: '1' };

/** Client-side cap, mirrored by the server's ciphertext byte cap (~16KB). */
export const MAX_MESSAGE_CHARS = 8000;

/* ---------- wire shapes (defined here so the frontend needs none of the backend types) ---------- */

interface KeyResponse {
  public_key: string | null;
  key_version?: number;
}

interface RawLastMessage {
  nonce: string;
  ciphertext: string;
  senderActorKey: string;
}

interface RawThread {
  threadId: string;
  otherActorKey: string;
  /** The other side's Lumen handle (or Hive name), resolved by the server. */
  otherName?: string | null;
  status: string;
  lastMessage?: RawLastMessage | null;
}

interface RawMessage {
  messageId: string;
  nonce: string;
  ciphertext: string;
  senderKeyVersion: number;
  recipientKeyVersion: number;
  createdAt: string;
  /**
   * Optional: the threads list already carries a per-message `senderActorKey`, and
   * the thread-messages endpoint may carry it too. When present it is the only honest
   * way to label direction, so it is read when available and the UI degrades to a
   * neutral rendering when it is not, rather than guessing.
   */
  senderActorKey?: string;
}

interface RawMessagesResponse {
  status?: string;
  otherActorKey?: string;
  otherName?: string | null;
  messages?: RawMessage[];
}

/* ---------- helpers ---------- */

function actorKeyOf(user: { userId?: string; username: string }): string | null {
  if (user.userId) return `u:${user.userId}`;
  if (user.username) return `h:${user.username.toLowerCase()}`;
  return null;
}

/**
 * The server form of a recipient named by a display handle. `hive:<name>` (how the
 * token pages and a Meritum escrow name a Hive account) becomes the `h:<name>`
 * escape, which `resolveDmActor` routes to the real Hive account and never to a
 * name-colliding lite squatter (IDA-02, see dm-compose-modal.tsx). Bare handles and
 * wallet DIDs pass through unchanged.
 */
export function dmRecipientActor(handle: string): string {
  return handle.startsWith('hive:') ? `h:${handle.slice('hive:'.length)}` : handle;
}

async function fetchPublicKeyFor(actorParam: string): Promise<{ publicKey: string | null; keyVersion: number }> {
  const res = await fetch(`/api/lite/dm/keys?actor=${encodeURIComponent(actorParam)}`);
  if (!res.ok) throw new Error(`DM key read failed: HTTP ${res.status}`);
  const body = (await res.json()) as KeyResponse;
  return { publicKey: body.public_key ?? null, keyVersion: body.key_version ?? 1 };
}

/* ---------- own registration ---------- */

interface OwnKeyResponse {
  public_key: string | null;
  key_version?: number;
  backup?: string | null;
}

/** The caller's own current key and backup; null when the read failed (not "no key"). */
async function fetchOwnKey(): Promise<OwnKeyResponse | null> {
  try {
    const res = await fetch('/api/lite/dm/keys?own=1');
    if (!res.ok) return null;
    return (await res.json()) as OwnKeyResponse;
  } catch {
    return null;
  }
}

async function postOwnKey(publicKey: string, backup?: DmKeyBackup | null): Promise<boolean> {
  const res = await fetch('/api/lite/dm/keys', {
    method: 'POST',
    headers: JSON_POST,
    body: JSON.stringify(backup ? { publicKey, backup: JSON.stringify(backup) } : { publicKey })
  });
  return res.ok;
}

type BackupResult = 'saved' | 'device-only' | 'skipped';

// One backup attempt per identity at a time: the header and an open inbox can both reach
// this on the first page after sign-in, and two would mean two Keychain approvals.
const backupInFlight = new Map<string, Promise<BackupResult>>();

/**
 * Upload the encrypted backup of THIS browser's key (see `../lib/dm-key-backup`). Best
 * effort: a refusal, a closed popup or a login that cannot make one leaves the key
 * working on this device and the inbox offering to try again.
 */
function backUpOwnKey(user: User, actorKey: string, interactive: boolean): Promise<BackupResult> {
  const pending = backupInFlight.get(actorKey);
  if (pending) return pending;
  const work = (async (): Promise<BackupResult> => {
    try {
      const backup = await makeBackup(user, await exportPrivateKeyBase64(actorKey), interactive);
      if (!backup) return 'skipped';
      return (await postOwnKey(await getPublicKeyBase64(actorKey), backup)) ? 'saved' : 'skipped';
    } catch (error) {
      return error instanceof DeviceOnlyError ? 'device-only' : 'skipped';
    } finally {
      backupInFlight.delete(actorKey);
    }
  })();
  backupInFlight.set(actorKey, work);
  return work;
}

// TODO i18n - names for the one approval a backup or an unlock takes.
const VIA_LABEL: Record<BackupVia, string> = {
  keychain: 'Hive Keychain',
  peakvault: 'PeakVault',
  metamask: 'MetaMask',
  wif: 'your posting key',
  wallet: 'your wallet'
};

export interface OwnDmRegistration {
  /** The browser's public key is registered server-side and messaging is usable. */
  ready: boolean;
  registering: boolean;
  error: boolean;
  /**
   * A key is registered for this identity, the private half is not in THIS browser, and
   * there is no backup this login can open. Registering here would append a new key
   * version and make the existing messages unreadable to their owner, so it is refused
   * and surfaced instead of done silently.
   */
  orphaned: boolean;
  /**
   * The account's key lives on another device AND has a backup this login can open:
   * one approval (`unlock`) installs it here. Nothing is minted in this state, ever.
   */
  locked: boolean;
  /** This device holds the key and no backup exists yet; `backUp` would make one. */
  canBackUp: boolean;
  /** A wallet that signs the fixed message differently each time: this device only. */
  deviceOnly: boolean;
  /** Who the one approval goes to, for the copy ("Hive Keychain", "your wallet"). */
  approvalLabel: string | null;
  /** A wallet backup takes two signatures (the second proves they match), not one approval. */
  viaWallet: boolean;
  /** An unlock or backup is waiting on the signer. */
  working: boolean;
  /** Why the last unlock or backup did not go through, if it did not. */
  actionError: string | null;
  unlock: () => Promise<boolean>;
  backUp: () => Promise<boolean>;
  loggedIn: boolean;
  sessionUnavailable: boolean;
  /** Retry / force a registration attempt (e.g. after a failure). */
  ensure: () => Promise<boolean>;
}

type RegState = 'idle' | 'registering' | 'ready' | 'error' | 'orphaned' | 'locked';

/**
 * Ensures THIS browser can send and receive: its key is the account's registered key,
 * or the account has none yet and this browser registers one. Called by any surface
 * that needs the viewer to be able to send or receive (the compose modal, the inbox, a
 * thread) - never by the bare Message button, so merely viewing a profile registers
 * nothing. It never prompts on its own; `unlock` and `backUp` are for a press.
 *
 * ★★★ NEVER MINT OVER AN EXISTING REGISTRATION (2026-09-13), AND NEVER OVER A BACKUP
 * (2026-09-25). On a second device, a cleared profile or a private window there is no
 * local key, and the old flow generated a fresh one and registered it, appending a
 * version and leaving every earlier message unreadable to its own owner and to everyone
 * who wrote to them. Production, 2026-09-13 06:12: `daveks`. Now:
 *
 *  - this browser's key IS the registered key: ready;
 *  - a backup exists: locked (this login can open it) or orphaned (it cannot). Never a
 *    new key, whatever the tier;
 *  - a key exists without a backup: as before. A Hive account is orphaned; a lite one
 *    re-registers this browser's key (its old per-device rule);
 *  - no key anywhere: register this browser's key, then try the backup.
 *
 * The own-key read comes BEFORE the local check on purpose: the header may be making
 * this browser's key at the same moment, and it stores the key before registering it,
 * so a registered key seen here is already in local storage if it is ours.
 */
export function useOwnDmRegistration(): OwnDmRegistration {
  const qc = useQueryClient();
  const { user, isHydrated, sessionUnavailable } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  const actorKey = loggedIn ? actorKeyOf(user) : null;
  const via = loggedIn ? backupViaFor(user) : null;
  const [state, setState] = useState<RegState>('idle');
  const [backedUp, setBackedUp] = useState<boolean | null>(null);
  const [backupPossible, setBackupPossible] = useState(false);
  const [deviceOnly, setDeviceOnly] = useState(false);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const ensure = useCallback(async (): Promise<boolean> => {
    if (!loggedIn || !actorKey) return false;
    setState('registering');
    try {
      const own = await fetchOwnKey();
      const hasLocal = await hasStoredKeypair(actorKey);
      const localPub = hasLocal ? await getPublicKeyBase64(actorKey) : null;

      if (own === null) {
        // Could not tell. A key already here was registered when it was made, so it
        // still works; without one, making a key now could replace a backed-up one.
        if (!hasLocal) throw new Error('own key read failed');
        setState('ready');
        return true;
      }

      if (own.public_key && localPub === own.public_key) {
        setBackedUp(Boolean(own.backup));
        if (!own.backup) void hasBackupMethod(user).then(setBackupPossible);
        setState('ready');
        return true;
      }

      if (own.public_key && own.backup) {
        const backup = parseBackup(own.backup);
        setState(backup && canOpen(user, backup) ? 'locked' : 'orphaned');
        return false;
      }

      if (own.public_key && !hasLocal && actorKey.startsWith('h:')) {
        setState('orphaned');
        return false;
      }

      // No key anywhere, or (lite, or a key already here) a key without a backup: this
      // browser's key is registered, made here first if there is none.
      const publicKey = localPub ?? (await getPublicKeyBase64(actorKey));
      if (!(await postOwnKey(publicKey))) throw new Error('DM key registration failed');
      setBackedUp(false);
      void hasBackupMethod(user).then(setBackupPossible);
      setState('ready');
      if (!own.public_key) {
        // The first device for this account: its backup, as at sign-in (see useDmKeyOnSignIn).
        void backUpOwnKey(user, actorKey, false).then((r) => {
          if (r === 'saved') setBackedUp(true);
          if (r === 'device-only') setDeviceOnly(true);
        });
      }
      return true;
    } catch {
      // A failed registration is a real, visible state: the UI tells the viewer their
      // messaging is not set up yet rather than letting a send fail later.
      setState('error');
      return false;
    }
  }, [loggedIn, actorKey, user]);

  useEffect(() => {
    if (loggedIn && state === 'idle') void ensure();
  }, [loggedIn, state, ensure]);

  const unlock = useCallback(async (): Promise<boolean> => {
    if (!actorKey) return false;
    setWorking(true);
    setActionError(null);
    try {
      const own = await fetchOwnKey();
      const backup = parseBackup(own?.backup);
      if (!own?.public_key || !backup) throw new Error("There is no backup to unlock. Open Lumen on the device you first used.");
      const privateKey = await openBackup(user, backup);
      // Only the account's CURRENT key may be installed: a backup that opens to anything
      // else is refused before it touches this browser.
      if (publicKeyOfPrivateBase64(privateKey) !== own.public_key) {
        throw new Error("That backup belongs to an older messaging key, so it can't unlock your current messages.");
      }
      await installKeypair(actorKey, privateKey, own.key_version ?? 1);
      setBackedUp(true);
      setState('ready');
      void qc.invalidateQueries({ queryKey: ['dm-threads'] });
      void qc.invalidateQueries({ queryKey: ['dm-thread'] });
      return true;
    } catch (error) {
      setActionError(unlockFailure(error));
      return false;
    } finally {
      setWorking(false);
    }
  }, [actorKey, user, qc]);

  const backUp = useCallback(async (): Promise<boolean> => {
    if (!actorKey) return false;
    setWorking(true);
    setActionError(null);
    try {
      const result = await backUpOwnKey(user, actorKey, true);
      if (result === 'saved') setBackedUp(true);
      else if (result === 'device-only') setDeviceOnly(true);
      else setActionError("That didn't go through. Nothing changed; you can try again.");
      return result === 'saved';
    } finally {
      setWorking(false);
    }
  }, [actorKey, user]);

  return {
    ready: state === 'ready',
    orphaned: state === 'orphaned',
    locked: state === 'locked',
    registering: state === 'registering',
    error: state === 'error',
    canBackUp: state === 'ready' && backedUp === false && backupPossible && !deviceOnly,
    deviceOnly,
    approvalLabel: via ? VIA_LABEL[via] : null,
    viaWallet: via === 'wallet',
    working,
    actionError,
    unlock,
    backUp,
    loggedIn,
    sessionUnavailable,
    ensure
  };
}

function unlockFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'wrong_wallet') return 'Connect the wallet you use for Lumen, then try again.';
  if (message === 'cannot_open_backup' || message === 'This memo is not for this key') {
    return "This sign-in can't open your backup. Sign in the way you did on your first device.";
  }
  if (message.includes('older messaging key') || message.includes('no backup')) return message;
  return "That didn't unlock. Nothing changed; you can try again.";
}

/**
 * ★★ A KEY ON SIGN-IN, FOR EVERY ACCOUNT TYPE, WITHOUT EVER REPLACING ONE (2026-09-25,
 * owner: "they need to login into lumen to get the key").
 *
 * Mounted once in the header, so any signed-in account (Hive, Google, Bitcoin or
 * Ethereum wallet) becomes reachable by merely using Lumen, not only after finding
 * the Studio. It registers a key only when the account has NONE yet:
 *
 *  - This browser already holds a key for the account: nothing to do.
 *  - The account has a key (on another device, backed up or not): left alone. The
 *    inbox offers the unlock, or says where the key is.
 *  - No key anywhere: make one here, register it, then upload its backup: one approval
 *    for Keychain, PeakVault or MetaMask, none for a WIF login with a stored key, and for
 *    a wallet only if it is already connected (the wallet picker needs a press, so
 *    otherwise the inbox offers it).
 *
 * Waits for the server's answer on who is signed in (`clientAnswered`), so a stale
 * cached identity from a previous sign-in can never register a key for the wrong
 * account. Any failure is silent: signing in never fails over messaging, and the
 * inbox states the honest reason when it is opened.
 */
const signInHandled = new Set<string>();

export function useDmKeyOnSignIn(): void {
  const { user, isHydrated, clientAnswered } = useUserClient();
  const actorKey = isHydrated && clientAnswered && user.isLoggedIn ? actorKeyOf(user) : null;
  const userRef = useRef(user);
  userRef.current = user;

  useEffect(() => {
    if (!actorKey || signInHandled.has(actorKey)) return;
    signInHandled.add(actorKey);
    void (async () => {
      try {
        if (await hasStoredKeypair(actorKey)) return;
        const own = await fetchOwnKey();
        if (!own || own.public_key) return;
        if (!(await postOwnKey(await getPublicKeyBase64(actorKey)))) return;
        await backUpOwnKey(userRef.current, actorKey, false);
      } catch {
        /* see above: the inbox reports the state, sign-in is never blocked */
      }
    })();
  }, [actorKey]);
}

/* ---------- recipient key ---------- */

export interface RecipientKeyState {
  status: 'idle' | 'loading' | 'ready' | 'unregistered' | 'error';
  publicKey: string | null;
  keyVersion: number;
}

/**
 * Reads a counterparty's registered public key. `unregistered` (a `public_key: null`
 * answer) is the honest "this creator hasn't set up messaging yet" state - distinct
 * from `error`, which is a read that failed and may succeed on retry.
 */
export function useRecipientKey(actorParam: string | null): RecipientKeyState {
  const q = useQuery({
    queryKey: ['dm-key', actorParam],
    enabled: Boolean(actorParam),
    staleTime: 60_000,
    retry: 1,
    queryFn: () => fetchPublicKeyFor(actorParam as string)
  });

  if (!actorParam) return { status: 'idle', publicKey: null, keyVersion: 1 };
  if (q.isError) return { status: 'error', publicKey: null, keyVersion: 1 };
  if (q.data) {
    return q.data.publicKey
      ? { status: 'ready', publicKey: q.data.publicKey, keyVersion: q.data.keyVersion }
      : { status: 'unregistered', publicKey: null, keyVersion: 1 };
  }
  return { status: 'loading', publicKey: null, keyVersion: 1 };
}

/* ---------- send ---------- */

export interface SendInput {
  /** Handle (new conversation) or `otherActorKey` (reply) - the server resolves it. */
  recipientActor: string;
  recipientPublicKey: string;
  recipientKeyVersion: number;
  plaintext: string;
}

/**
 * Encrypts locally, then POSTs only ciphertext. This is the single choke point that
 * guarantees plaintext never leaves the browser on the send path.
 */
export function useSendMessage() {
  const qc = useQueryClient();
  const { user, isHydrated } = useUserClient();
  const myActorKey = isHydrated && user.isLoggedIn ? actorKeyOf(user) : null;
  return useMutation({
    mutationFn: async (input: SendInput) => {
      if (!myActorKey) throw new Error('You must be signed in to send a message.');
      const ownKeyVersion = await storedKeyVersion(myActorKey);
      const { nonce, ciphertext } = await encrypt(myActorKey, input.recipientPublicKey, input.plaintext);
      const res = await fetch('/api/lite/dm/send', {
        method: 'POST',
        headers: JSON_POST,
        body: JSON.stringify({
          recipientActor: input.recipientActor,
          nonce,
          ciphertext,
          senderKeyVersion: ownKeyVersion,
          recipientKeyVersion: input.recipientKeyVersion
        })
      });
      if (!res.ok) {
        let reason = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string; message?: string };
          reason = body.error ?? body.message ?? reason;
        } catch {
          /* non-JSON error body: keep the status */
        }
        throw new Error(reason);
      }
      return (await res.json()) as unknown;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dm-threads'] });
    }
  });
}

/* ---------- threads (inbox) ---------- */

export interface DmThreadSummary {
  threadId: string;
  otherActorKey: string;
  otherName: string | null;
  status: string;
  /** Decrypted preview of the last message, or null when there is nothing to show. */
  preview: string | null;
  /** True when a last message exists but could not be decrypted (unregistered/rotated key). */
  previewUndecryptable: boolean;
  lastFromMe: boolean;
}

/**
 * The viewer's threads, with each preview decrypted CLIENT-SIDE. The server cannot
 * produce these strings; it only stores the ciphertext. Per thread we fetch the
 * counterparty's public key once (cached within the run) and decrypt the last
 * message with it.
 */
export function useDmThreads() {
  const { user, isHydrated, sessionUnavailable } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  const myActorKey = loggedIn ? actorKeyOf(user) : null;

  const q = useQuery({
    queryKey: ['dm-threads', myActorKey],
    enabled: loggedIn,
    queryFn: async (): Promise<DmThreadSummary[]> => {
      if (!myActorKey) return [];
      const res = await fetch('/api/lite/dm/threads');
      if (!res.ok) throw new Error(`DM threads read failed: HTTP ${res.status}`);
      const body = (await res.json()) as { threads?: RawThread[] };
      const raw = body.threads ?? [];

      const keyCache = new Map<string, string | null>();
      const summaries: DmThreadSummary[] = [];
      for (const t of raw) {
        let preview: string | null = null;
        let previewUndecryptable = false;
        let lastFromMe = false;

        if (t.lastMessage) {
          lastFromMe = myActorKey !== null && t.lastMessage.senderActorKey === myActorKey;
          let pub = keyCache.get(t.otherActorKey);
          if (pub === undefined) {
            try {
              pub = (await fetchPublicKeyFor(t.otherActorKey)).publicKey;
            } catch {
              pub = null;
            }
            keyCache.set(t.otherActorKey, pub);
          }
          if (pub) {
            try {
              preview = await decrypt(myActorKey, pub, t.lastMessage.nonce, t.lastMessage.ciphertext);
            } catch {
              previewUndecryptable = true;
            }
          } else {
            previewUndecryptable = true;
          }
        }

        summaries.push({
          threadId: t.threadId,
          otherActorKey: t.otherActorKey,
          otherName: t.otherName ?? null,
          status: t.status,
          preview,
          previewUndecryptable,
          lastFromMe
        });
      }
      return summaries;
    }
  });

  return {
    threads: q.data ?? [],
    isLoading: q.isInitialLoading,
    isError: q.isError,
    loggedIn,
    sessionUnavailable,
    refetch: q.refetch
  };
}

export interface DmThreadWith {
  /** `none` = no conversation yet; `error` = the lookup failed (sending still lands in the right thread). */
  status: 'idle' | 'loading' | 'found' | 'none' | 'error';
  threadId: string | null;
}

/**
 * The viewer's existing thread with one person (`recipientActor` in the server form,
 * see `dmRecipientActor`), so "Message" on a Meritum order opens the conversation
 * that already exists. Keyed under 'dm-threads', so a send (which invalidates that
 * prefix) re-asks, and the thread a first message just created is found.
 */
export function useDmThreadWith(recipientActor: string | null): DmThreadWith {
  const { user, isHydrated } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  const myActorKey = loggedIn ? actorKeyOf(user) : null;

  const q = useQuery({
    queryKey: ['dm-threads', myActorKey, 'with', recipientActor],
    enabled: loggedIn && Boolean(recipientActor),
    retry: 1,
    queryFn: async (): Promise<string | null> => {
      const res = await fetch(`/api/lite/dm/threads?with=${encodeURIComponent(recipientActor as string)}`);
      if (!res.ok) throw new Error(`DM thread lookup failed: HTTP ${res.status}`);
      const body = (await res.json()) as { thread_id?: string | null };
      return body.thread_id ?? null;
    }
  });

  if (!recipientActor || !loggedIn) return { status: 'idle', threadId: null };
  if (q.data) return { status: 'found', threadId: q.data };
  if (q.isError) return { status: 'error', threadId: null };
  if (q.data === null) return { status: 'none', threadId: null };
  return { status: 'loading', threadId: null };
}

/* ---------- one thread ---------- */

export interface DmMessage {
  messageId: string;
  createdAt: string;
  /** Decrypted body, or null when it could not be decrypted. */
  text: string | null;
  undecryptable: boolean;
  /** Known only when the message carries a senderActorKey; null means direction unknown. */
  fromMe: boolean | null;
}

export interface DmThreadData {
  status: string | null;
  otherActorKey: string | null;
  otherName: string | null;
  messages: DmMessage[];
}

export function useDmThread(threadId: string | null) {
  const qc = useQueryClient();
  const { user, isHydrated, sessionUnavailable } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  const myActorKey = loggedIn ? actorKeyOf(user) : null;

  const q = useQuery({
    queryKey: ['dm-thread', threadId, myActorKey],
    enabled: Boolean(threadId) && loggedIn,
    queryFn: async (): Promise<DmThreadData> => {
      if (!myActorKey) return { status: null, otherActorKey: null, otherName: null, messages: [] };
      const res = await fetch(`/api/lite/dm/threads/${encodeURIComponent(threadId as string)}/messages`);
      if (!res.ok) throw new Error(`DM messages read failed: HTTP ${res.status}`);
      const body = (await res.json()) as RawMessagesResponse;
      const otherActorKey = body.otherActorKey ?? null;

      // One key read for the whole thread: the counterparty is the same for every
      // message, and ECDH is symmetric, so a single public key decrypts them all.
      let counterpartyPub: string | null = null;
      if (otherActorKey) {
        try {
          counterpartyPub = (await fetchPublicKeyFor(otherActorKey)).publicKey;
        } catch {
          counterpartyPub = null;
        }
      }

      const messages: DmMessage[] = [];
      for (const m of body.messages ?? []) {
        let text: string | null = null;
        let undecryptable = false;
        if (counterpartyPub) {
          try {
            text = await decrypt(myActorKey, counterpartyPub, m.nonce, m.ciphertext);
          } catch {
            undecryptable = true;
          }
        } else {
          undecryptable = true;
        }
        messages.push({
          messageId: m.messageId,
          createdAt: m.createdAt,
          text,
          undecryptable,
          fromMe: m.senderActorKey ? (myActorKey !== null && m.senderActorKey === myActorKey) : null
        });
      }
      // Server returns newest-first (message_id DESC); reverse to chronological so the
      // newest message sits at the BOTTOM - the normal DM reading order.
      messages.reverse();
      return { status: body.status ?? null, otherActorKey, otherName: body.otherName ?? null, messages };
    }
  });

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const reply = useCallback(
    async (plaintext: string): Promise<boolean> => {
      const otherActorKey = q.data?.otherActorKey ?? null;
      if (!otherActorKey || !plaintext.trim()) return false;
      setSending(true);
      setSendError(null);
      try {
        if (!myActorKey) throw new Error('You must be signed in to send a message.');
        const { publicKey, keyVersion } = await fetchPublicKeyFor(otherActorKey);
        if (!publicKey) throw new Error('The other person has no messaging key registered.');
        const ownKeyVersion = await storedKeyVersion(myActorKey);
        const { nonce, ciphertext } = await encrypt(myActorKey, publicKey, plaintext);
        const res = await fetch('/api/lite/dm/send', {
          method: 'POST',
          headers: JSON_POST,
          body: JSON.stringify({
            recipientActor: otherActorKey,
            nonce,
            ciphertext,
            senderKeyVersion: ownKeyVersion,
            recipientKeyVersion: keyVersion
          })
        });
        if (!res.ok) throw new Error(`Reply failed: HTTP ${res.status}`);
        await q.refetch();
        void qc.invalidateQueries({ queryKey: ['dm-threads'] });
        return true;
      } catch (e) {
        setSendError(e instanceof Error ? e.message : 'That reply did not go through.');
        return false;
      } finally {
        setSending(false);
      }
    },
    [q, qc, myActorKey]
  );

  return {
    status: q.data?.status ?? null,
    otherActorKey: q.data?.otherActorKey ?? null,
    otherName: q.data?.otherName ?? null,
    messages: q.data?.messages ?? [],
    isLoading: q.isInitialLoading,
    isError: q.isError,
    loggedIn,
    sessionUnavailable,
    reply,
    sending,
    sendError
  };
}

/* ---------- unread count + mark read ---------- */

export interface DmUnread {
  count: number;
  loggedIn: boolean;
  /** Mark unread incoming messages read: one thread (threadId) or all (omit). */
  markRead: (threadId?: string) => Promise<void>;
}

/**
 * The caller's unread INCOMING message count, for the Studio Messages-tab badge and the
 * notifications bell. Polls on a gentle cadence; `markRead` clears it (all, or one
 * thread) and refetches. Server-side (read_at), so it is consistent across devices.
 */
export function useDmUnread(): DmUnread {
  const qc = useQueryClient();
  const { user, isHydrated } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  const myActorKey = loggedIn ? actorKeyOf(user) : null;

  const q = useQuery({
    queryKey: ['dm-unread', myActorKey],
    enabled: loggedIn,
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async (): Promise<number> => {
      const res = await fetch('/api/lite/dm/unread');
      if (!res.ok) return 0;
      const body = (await res.json()) as { count?: number };
      return body.count ?? 0;
    }
  });

  const markRead = useCallback(
    async (threadId?: string): Promise<void> => {
      try {
        const res = await fetch('/api/lite/dm/read', {
          method: 'POST',
          headers: JSON_POST,
          body: JSON.stringify(threadId ? { threadId } : {})
        });
        if (res.ok) void qc.invalidateQueries({ queryKey: ['dm-unread'] });
      } catch {
        /* a failed mark-read just leaves the badge; never a user-facing error */
      }
    },
    [qc]
  );

  return { count: q.data ?? 0, loggedIn, markRead };
}
