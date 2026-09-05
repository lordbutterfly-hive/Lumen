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

import { useCallback, useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { csrfHeaderName } from '@smart-signer/lib/csrf-protection';
import { decrypt, encrypt, getOrCreateKeypair, getPublicKeyBase64 } from '../lib/dm-crypto';

// Actor keys whose public key this browser has already registered in this session, so
// repeated compose/inbox mounts don't each re-POST (see useOwnDmRegistration). Cleared
// on reload, where one idempotent re-register is harmless.
const registeredThisSession = new Set<string>();

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
  messages?: RawMessage[];
}

/* ---------- helpers ---------- */

function actorKeyOf(user: { userId?: string; username: string }): string | null {
  if (user.userId) return `u:${user.userId}`;
  if (user.username) return `h:${user.username.toLowerCase()}`;
  return null;
}

async function fetchPublicKeyFor(actorParam: string): Promise<{ publicKey: string | null; keyVersion: number }> {
  const res = await fetch(`/api/lite/dm/keys?actor=${encodeURIComponent(actorParam)}`);
  if (!res.ok) throw new Error(`DM key read failed: HTTP ${res.status}`);
  const body = (await res.json()) as KeyResponse;
  return { publicKey: body.public_key ?? null, keyVersion: body.key_version ?? 1 };
}

/* ---------- own registration ---------- */

export interface OwnDmRegistration {
  /** The browser's public key is registered server-side and messaging is usable. */
  ready: boolean;
  registering: boolean;
  error: boolean;
  loggedIn: boolean;
  sessionUnavailable: boolean;
  /** Retry / force a registration attempt (e.g. after a failure). */
  ensure: () => Promise<boolean>;
}

/**
 * Ensures THIS browser has a keypair and that its PUBLIC key is registered. Called
 * by any surface that needs the viewer to be able to send or receive (the compose
 * modal, the inbox, a thread) - never by the bare Message button, so merely viewing
 * a profile registers nothing. Registration is idempotent server-side (an upsert).
 */
export function useOwnDmRegistration(): OwnDmRegistration {
  const { user, isHydrated, sessionUnavailable } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  const actorKey = loggedIn ? actorKeyOf(user) : null;
  const [state, setState] = useState<'idle' | 'registering' | 'ready' | 'error'>('idle');

  const ensure = useCallback(async (): Promise<boolean> => {
    if (!loggedIn || !actorKey) return false;
    // Already registered this identity in this session: resolve without another POST.
    if (registeredThisSession.has(actorKey)) {
      setState('ready');
      return true;
    }
    setState('registering');
    try {
      const publicKey = await getPublicKeyBase64(actorKey);
      const res = await fetch('/api/lite/dm/keys', {
        method: 'POST',
        headers: JSON_POST,
        body: JSON.stringify({ publicKey })
      });
      if (!res.ok) throw new Error(`DM key registration failed: HTTP ${res.status}`);
      registeredThisSession.add(actorKey);
      setState('ready');
      return true;
    } catch {
      // A failed registration is a real, visible state: the UI tells the viewer their
      // messaging is not set up yet rather than letting a send fail later.
      setState('error');
      return false;
    }
  }, [loggedIn, actorKey]);

  useEffect(() => {
    if (loggedIn && state === 'idle') void ensure();
  }, [loggedIn, state, ensure]);

  return {
    ready: state === 'ready',
    registering: state === 'registering',
    error: state === 'error',
    loggedIn,
    sessionUnavailable,
    ensure
  };
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
      const own = await getOrCreateKeypair(myActorKey);
      const { nonce, ciphertext } = await encrypt(myActorKey, input.recipientPublicKey, input.plaintext);
      const res = await fetch('/api/lite/dm/send', {
        method: 'POST',
        headers: JSON_POST,
        body: JSON.stringify({
          recipientActor: input.recipientActor,
          nonce,
          ciphertext,
          senderKeyVersion: own.keyVersion,
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
      if (!myActorKey) return { status: null, otherActorKey: null, messages: [] };
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
      return { status: body.status ?? null, otherActorKey, messages };
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
        const own = await getOrCreateKeypair(myActorKey);
        const { nonce, ciphertext } = await encrypt(myActorKey, publicKey, plaintext);
        const res = await fetch('/api/lite/dm/send', {
          method: 'POST',
          headers: JSON_POST,
          body: JSON.stringify({
            recipientActor: otherActorKey,
            nonce,
            ciphertext,
            senderKeyVersion: own.keyVersion,
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
