import { User } from '@smart-signer/types/common';
import {
  enforceDmSendRate,
  enforceDmNewThreadRate
} from '../antispam/rate-limit';
import { checkLiteActorById, checkSessionValidity } from '../auth/account-status';
import { isBannedAuthor } from '@/blog/lib/moderation/banned-authors';
import * as users from '../repositories/user-repository';
import { findByMethodAndRef } from '../repositories/credential-repository';
import { walletRefForDid } from '../wallet/did-credential';
import { isBlocked } from '../repositories/block-repository';
import { isFollowing } from '../repositories/follow-repository';
import * as dmKeys from '../repositories/dm-key-repository';
import * as dmThreads from '../repositories/dm-thread-repository';
import * as dmMessages from '../repositories/dm-message-repository';
import {
  FollowActor,
  actorKey,
  resolveFollowTarget,
  sameActor,
  sessionActor
} from '../social/follow-actor';
import { SessionRef } from '../types';

/**
 * ★★★ DIRECT MESSAGES — THE SERVER ORCHESTRATES METADATA ONLY, NEVER PLAINTEXT.
 *
 * Every `nonce` / `ciphertext` this module handles is an opaque byte string produced
 * and consumed by the browser (X25519 ECDH + XChaCha20-Poly1305, client-side). Nothing
 * here — nor in the repositories or routes beneath it — decodes, inspects, logs or
 * interprets it. The server's whole job is: authenticate the sender from the SESSION
 * (never a client-asserted actor), resolve the recipient, apply block/rate/request
 * policy, and store the ciphertext verbatim. If a change here ever needs to look inside
 * a ciphertext, that is the bug.
 *
 * Identity, blocking, rate-limiting and the request/open flow all reuse the existing
 * `follow-actor` / `block-repository` / `rate-limit` machinery UNMODIFIED, exactly as
 * `follow-service.ts` and `block-service.ts` do — this module is their sibling.
 */

/** 16 KiB, matched by the DB's `ck_dm_message_ciphertext` CHECK. */
export const MAX_CIPHERTEXT_BYTES = 16 * 1024;
/** XChaCha20-Poly1305 uses 24; bounded (not pinned) so the crypto lane can adjust. */
export const MAX_NONCE_BYTES = 64;
/** A 32-byte X25519 key is ~44 base64 / 64 hex chars; 256 is generous headroom. */
export const MAX_PUBLIC_KEY_CHARS = 256;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * base64 -> Buffer, rejecting anything that is not valid base64 or that exceeds the byte
 * cap. This is a TRANSPORT decode of already-encrypted bytes — the plaintext is never
 * present in this process — bounded before allocation so an oversized field cannot force
 * a large buffer.
 */
function decodeBounded(b64: unknown, maxBytes: number): Buffer | null {
  if (typeof b64 !== 'string' || b64.length === 0 || !BASE64_RE.test(b64)) return null;
  // base64 is 4 chars per 3 bytes; refuse before decoding if it cannot fit the cap.
  if (b64.length > Math.ceil(maxBytes / 3) * 4 + 8) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0 || buf.length > maxBytes) return null;
  return buf;
}

function isKeyVersion(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

/**
 * Who is acting, and may they. Mirrors `follow-service.actorFor` / `block-service`:
 *
 *  - The sender is always the SESSION actor (`sessionActor`), never a client claim.
 *  - Session revocation (account epoch + this device's sign-out) is checked ABOVE the
 *    status branch, so a revoked cookie can never write, whatever the action.
 *  - `requireActive` gates PARTICIPATION (sending): a suspended account may not send.
 *    Reads pass `requireActive = false` — a suspended user may still read their own
 *    messages — but are still revocation-checked.
 *  - A Hive login has no Lumen row; it is authenticated by a signed challenge at login.
 */
async function actorFor(
  sessionUser: User | undefined,
  requireActive: boolean,
  session: SessionRef
): Promise<{ ok: true; actor: FollowActor } | { ok: false; status: number; error: string }> {
  const actor = await sessionActor(sessionUser);
  if (!actor) return { ok: false, status: 401, error: 'unauthorized' };
  if (!actor.userId) return { ok: true, actor };

  const row = await users.findUserById(actor.userId);
  if (!row) return { ok: false, status: 401, error: 'session_revoked' };
  const revoked = await checkSessionValidity(row, session);
  if (revoked) return { ok: false, status: revoked.status, error: revoked.code };
  if (!requireActive) return { ok: true, actor };

  // `allowUpgraded`: a DM record has no on-chain equivalent, so an upgraded user must
  // still be able to send — same rationale follow-service gives for following a lite
  // user. Suspended/banned are refused here (participation).
  const check = await checkLiteActorById(actor.userId, { allowUpgraded: true, ...session });
  if (!check.ok) return { ok: false, status: check.status, error: check.code };
  return { ok: true, actor };
}

// ── recipient / lookup resolution ──────────────────────────────────────────────

/**
 * The chain existence check, replicated from `follow-actor.hiveAccountExists` (which is
 * private and must stay UNMODIFIED). Runtime import for the reason that module documents:
 * the chain client pulls in `@hiveio/wax`, which has no CJS export map, so a static import
 * would make this module unloadable outside the Next bundle. Only a definite "exists"
 * counts — an API hiccup is never read as existence.
 */
async function hiveAccountExists(name: string): Promise<boolean> {
  const { checkAccountExists } = await import('@transaction/lib/validation/existence/account');
  const existence = await checkAccountExists(name);
  return existence.status === 'exists';
}

export type DmActorResolution =
  | { ok: true; actor: FollowActor }
  | { ok: false; error: 'not_found' | 'invalid_name' };

/**
 * ★★★ RESOLVE A DM COUNTERPARTY FROM EITHER FORM THE FRONTEND SENDS.
 *
 * First contact sends a BARE handle (display name / Hive account name); an in-thread key
 * lookup or a reply sends the thread's stored ACTOR-KEY form — `u:<userId>` for a lite
 * counterparty (who has no Hive handle to send instead) or `h:<hiveName>` for a Hive one.
 * `resolveFollowTarget` only accepts a bare name, so without this every lite-user thread
 * and every in-thread reply would fail to resolve.
 *
 *  - `u:<id>`   -> the Lumen user must exist (by id) -> actor {userId}. NOT canonicalised
 *                 through a name: the id IS the identity and is exactly what the thread
 *                 key already holds.
 *  - `h:<name>` -> a real Hive account (or a Lumen account that owns that Hive name) ->
 *                 actor {hive}, returned verbatim (NOT canonicalised to a userId) so it
 *                 matches the `h:` key already stored in the thread.
 *  - `did:pkh:…` -> the Lumen account that has that wallet bound -> actor {userId}.
 *                 A Meritum escrow names its buyer only by wallet, so this is how a
 *                 creator reaches a wallet buyer. A wallet no Lumen account holds is
 *                 `not_found`, which the compose screen shows as "not set up yet".
 *  - anything else -> `resolveFollowTarget`, exactly as first contact does today.
 *
 * Returns the same `{ ok, actor } | { ok:false, error }` shape `resolveFollowTarget` does,
 * so both call sites below are drop-in.
 */
export async function resolveDmActor(param: string): Promise<DmActorResolution> {
  const raw = param.trim();
  if (!raw) return { ok: false, error: 'invalid_name' };

  // Before the bare-name fallthrough, which would lowercase the DID (corrupting a
  // base58 address) and then ask Hive whether an account by that name exists.
  if (raw.startsWith('did:pkh:')) {
    const ref = walletRefForDid(raw);
    if (!ref) return { ok: false, error: 'invalid_name' };
    const credential = await findByMethodAndRef(ref.method, ref.externalRef);
    if (!credential) return { ok: false, error: 'not_found' };
    return { ok: true, actor: { userId: credential.userId } };
  }

  const uMatch = /^u:(.+)$/.exec(raw);
  if (uMatch) {
    // Case-sensitive: a Lumen user id is a ULID and actorKey() never lowercases it.
    const userId = uMatch[1];
    const user = await users.findUserById(userId);
    if (!user) return { ok: false, error: 'not_found' };
    return { ok: true, actor: { userId } };
  }

  const hMatch = /^h:(.+)$/.exec(raw);
  if (hMatch) {
    // actorKey() stores `h:` || lower(hive); normalise identically so the resolved key
    // matches the thread's stored key exactly.
    const hive = hMatch[1].toLowerCase();
    const owned = await users.findUserByHiveAccountName(hive);
    if (owned || (await hiveAccountExists(hive))) return { ok: true, actor: { hive } };
    return { ok: false, error: 'not_found' };
  }

  const resolved = await resolveFollowTarget(raw);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return { ok: true, actor: resolved.actor };
}

// ── keys ─────────────────────────────────────────────────────────────────────

export type RegisterKeyOutcome =
  | { ok: true; publicKey: string; keyVersion: number }
  | { ok: false; status: number; error: string };

/** Matches the DB's `ck_dm_key_backup`. A backup is a few hundred characters. */
export const MAX_BACKUP_CHARS = 4096;

/**
 * Register or rotate the CALLER'S OWN public key. Only the public half is ever sent, plus
 * optionally a BACKUP of the private half that the browser has already encrypted (to the
 * account's own posting key, or under a wallet-signature key). The backup is opaque here:
 * bounded by size, stored verbatim, never opened and never logged.
 */
export async function registerOwnKey(
  sessionUser: User | undefined,
  session: SessionRef,
  publicKey: unknown,
  backup?: unknown,
  startOver = false
): Promise<RegisterKeyOutcome> {
  const from = await actorFor(sessionUser, true, session);
  if (!from.ok) return from;
  if (isBannedAuthor(from.actor.hive)) return { ok: false, status: 403, error: 'account_banned' };
  if (
    typeof publicKey !== 'string' ||
    publicKey.length === 0 ||
    publicKey.length > MAX_PUBLIC_KEY_CHARS
  ) {
    return { ok: false, status: 400, error: 'invalid_public_key' };
  }
  const hasBackup = backup !== undefined && backup !== null;
  if (hasBackup && (typeof backup !== 'string' || backup.length === 0 || backup.length > MAX_BACKUP_CHARS)) {
    return { ok: false, status: 400, error: 'invalid_backup' };
  }
  try {
    const stored = await dmKeys.registerPublicKey(
      from.actor,
      publicKey,
      typeof backup === 'string' ? backup : null,
      startOver
    );
    return { ok: true, publicKey: stored.publicKey, keyVersion: stored.keyVersion };
  } catch (error) {
    // 409: this account already has a different key; only an explicit start over replaces it.
    if (error instanceof dmKeys.KeyReplaceRefusedError) return { ok: false, status: 409, error: 'key_exists' };
    throw error;
  }
}

export type OwnKeyOutcome =
  | { ok: true; key: { publicKey: string; keyVersion: number; backup: string | null } | null }
  | { ok: false; status: number; error: string };

/**
 * The CALLER'S OWN current key and its backup, so a device without the private half can
 * restore it. Owner only: the backup cannot be opened without the account's posting key
 * or wallet, but nobody else has a reason to hold it. Readable while suspended, like the
 * caller's own messages.
 */
export async function getOwnKey(sessionUser: User | undefined, session: SessionRef): Promise<OwnKeyOutcome> {
  const from = await actorFor(sessionUser, false, session);
  if (!from.ok) return from;
  return { ok: true, key: await dmKeys.getOwnKeyWithBackup(from.actor) };
}

/**
 * The public key a named identity had at one version, or null. What lets someone keep
 * reading a conversation after the OTHER side started over: their old messages were
 * sealed with the other side's key at the version stamped on each message.
 */
export async function lookupPublicKeyAtVersion(
  actorName: string,
  keyVersion: number
): Promise<{ publicKey: string; keyVersion: number } | null> {
  const target = await resolveDmActor(actorName);
  if (!target.ok) return null;
  return dmKeys.getPublicKeyAtVersion(target.actor, keyVersion);
}

/** The public key registered for a named identity, or null if unregistered / unknown. */
export async function lookupPublicKey(
  actorName: string
): Promise<{ publicKey: string; keyVersion: number } | null> {
  const target = await resolveDmActor(actorName);
  if (!target.ok) return null;
  return dmKeys.getPublicKey(target.actor);
}

// ── send ─────────────────────────────────────────────────────────────────────

export interface SendMessageInput {
  recipientActor: unknown;
  nonce: unknown;
  ciphertext: unknown;
  senderKeyVersion: unknown;
  recipientKeyVersion: unknown;
}

export type SendMessageOutcome =
  | {
      ok: true;
      threadId: string;
      status: dmThreads.DmThreadStatus;
      messageId: string;
      createdAt: string;
    }
  | { ok: false; status: number; error: string };

export async function sendMessage(
  sessionUser: User | undefined,
  session: SessionRef,
  input: SendMessageInput
): Promise<SendMessageOutcome> {
  const from = await actorFor(sessionUser, true, session);
  if (!from.ok) return from;
  const sender = from.actor;

  // A globally banned chain account writes nothing into Lumen — same rule follow/block
  // apply, so a ban cannot be walked around via the DM table.
  if (isBannedAuthor(sender.hive)) return { ok: false, status: 403, error: 'account_banned' };

  // Validate the OPAQUE payload by size and shape ONLY — never by content.
  if (typeof input.recipientActor !== 'string' || input.recipientActor.trim().length === 0) {
    return { ok: false, status: 400, error: 'recipient_required' };
  }
  const ciphertext = decodeBounded(input.ciphertext, MAX_CIPHERTEXT_BYTES);
  if (!ciphertext) return { ok: false, status: 400, error: 'invalid_ciphertext' };
  const nonce = decodeBounded(input.nonce, MAX_NONCE_BYTES);
  if (!nonce) return { ok: false, status: 400, error: 'invalid_nonce' };
  if (!isKeyVersion(input.senderKeyVersion) || !isKeyVersion(input.recipientKeyVersion)) {
    return { ok: false, status: 400, error: 'invalid_key_version' };
  }

  // Charged BEFORE resolving the recipient — resolving an unknown name costs a Hive API
  // call, and limiting afterwards would leave that as free ammunition (follow-service).
  if (!(await enforceDmSendRate(sender))) return { ok: false, status: 429, error: 'rate_limited' };

  const target = await resolveDmActor(input.recipientActor);
  if (!target.ok) return { ok: false, status: 404, error: target.error };
  const recipient = target.actor;
  if (sameActor(sender, recipient)) return { ok: false, status: 400, error: 'cannot_dm_self' };

  // Blocking is symmetric for messaging: if EITHER side has blocked the other, no
  // message. The map calls for isBlocked(recipient, sender); the reverse is added so a
  // user cannot message someone they themselves have blocked.
  if (await isBlocked(recipient, sender)) return { ok: false, status: 403, error: 'blocked' };
  if (await isBlocked(sender, recipient)) return { ok: false, status: 403, error: 'blocked' };

  // ★★ SEALED TO THE RECIPIENT'S CURRENT KEY OR NOT STORED (2026-09-25). Threads decrypt
  // with the recipient's current key first, so a message sealed to a version they have
  // since replaced (a compose dialog open across their start over) would be unreadable to
  // BOTH sides. The version always comes from this server's own key read, so a mismatch
  // means the sender's copy is stale: the client re-reads and seals again.
  const recipientCurrent = await dmKeys.getPublicKey(recipient);
  if (!recipientCurrent) return { ok: false, status: 409, error: 'recipient_no_key' };
  if (recipientCurrent.keyVersion !== input.recipientKeyVersion) {
    return { ok: false, status: 409, error: 'recipient_key_changed' };
  }

  const senderKey = actorKey(sender);
  const recipientKey = actorKey(recipient);

  // Decide status only for a brand-new thread. A stranger's first message lands as a
  // 'request'; a message to someone who already follows the sender goes straight to
  // 'open'. A new thread also spends the stricter new-thread budget.
  let initialStatus: dmThreads.DmThreadStatus = 'open';
  const existing = await dmThreads.getThreadByPair(senderKey, recipientKey);
  if (!existing) {
    const wanted = await isFollowing(recipient, sender);
    initialStatus = wanted ? 'open' : 'request';
    if (!(await enforceDmNewThreadRate(sender))) {
      return { ok: false, status: 429, error: 'rate_limited' };
    }
  }

  const { thread } = await dmThreads.upsertThread({ senderKey, recipientKey, initialStatus });
  const stored = await dmMessages.insertMessage({
    threadId: thread.threadId,
    senderKey,
    nonce,
    ciphertext,
    senderKeyVersion: input.senderKeyVersion,
    recipientKeyVersion: input.recipientKeyVersion
  });

  return {
    ok: true,
    threadId: thread.threadId,
    status: thread.status,
    messageId: stored.messageId,
    createdAt: stored.createdAt.toISOString()
  };
}

// ── read: threads ──────────────────────────────────────────────────────────────

/** One message payload as sent to the client — all fields OPAQUE except timestamps. */
export interface DmMessageView {
  messageId: string;
  senderActorKey: string;
  nonce: string;
  ciphertext: string;
  senderKeyVersion: number;
  recipientKeyVersion: number;
  createdAt: string;
  readAt: string | null;
}

/**
 * The name to show for each actor key: the Lumen handle a `u:` account uses TODAY (so a
 * rename shows at once), or the Hive name of an `h:` one. Same lookup the bell's DM rows
 * make. A missing account maps to nothing, and the client falls back to its old label.
 */
async function namesFor(keys: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = Array.from(new Set(keys.filter((k) => k.startsWith('u:')).map((k) => k.slice(2))));
  const found = ids.length ? await users.findUsersByIds(ids) : [];
  for (const u of found) names.set(`u:${u.userId}`, u.displayName);
  for (const k of keys) if (k.startsWith('h:')) names.set(k, k.slice(2));
  return names;
}

export interface DmThreadView {
  threadId: string;
  status: dmThreads.DmThreadStatus;
  otherActorKey: string;
  /** The other side's Lumen handle (or Hive name); null if it cannot be found. */
  otherName: string | null;
  isRequester: boolean;
  lastMessageAt: string;
  lastMessage: DmMessageView | null;
}

export type ListThreadsOutcome =
  | { ok: true; threads: DmThreadView[] }
  | { ok: false; status: number; error: string };

const THREADS_LIMIT = 100;

export async function listThreads(
  sessionUser: User | undefined,
  session: SessionRef
): Promise<ListThreadsOutcome> {
  const from = await actorFor(sessionUser, false, session);
  if (!from.ok) return from;

  const callerKey = actorKey(from.actor);
  const items = await dmThreads.listThreadsWithLastMessage(callerKey, { limit: THREADS_LIMIT });
  const names = await namesFor(items.map((t) => t.otherKey));

  return {
    ok: true,
    threads: items.map((t) => ({
      threadId: t.threadId,
      status: t.status,
      otherActorKey: t.otherKey,
      otherName: names.get(t.otherKey) ?? null,
      isRequester: t.isRequester,
      lastMessageAt: t.lastMessageAt.toISOString(),
      lastMessage: t.lastMessage
        ? {
            messageId: t.lastMessage.messageId,
            senderActorKey: t.lastMessage.senderKey,
            nonce: t.lastMessage.nonceBase64,
            ciphertext: t.lastMessage.ciphertextBase64,
            senderKeyVersion: t.lastMessage.senderKeyVersion,
            recipientKeyVersion: t.lastMessage.recipientKeyVersion,
            createdAt: t.lastMessage.createdAt.toISOString(),
            readAt: t.lastMessage.readAt ? t.lastMessage.readAt.toISOString() : null
          }
        : null
    }))
  };
}

export type ThreadWithOutcome =
  | { ok: true; threadId: string | null }
  | { ok: false; status: number; error: string };

/**
 * The caller's existing conversation with one person, named in any form
 * `resolveDmActor` takes (a Meritum buyer arrives as `h:<name>` or `did:pkh:…`).
 * Lets "Message" open the thread that already exists instead of starting over.
 * Only the caller's OWN thread id is returned, never the other side's actor key: for a
 * wallet that key is a Lumen user id, and handing it out would link the wallet to the
 * account for anyone who asked.
 */
export async function findThreadWith(
  sessionUser: User | undefined,
  session: SessionRef,
  param: string
): Promise<ThreadWithOutcome> {
  const from = await actorFor(sessionUser, false, session);
  if (!from.ok) return from;
  const target = await resolveDmActor(param);
  if (!target.ok) return { ok: true, threadId: null };
  const thread = await dmThreads.getThreadByPair(actorKey(from.actor), actorKey(target.actor));
  return { ok: true, threadId: thread?.threadId ?? null };
}

// ── read: one thread's messages ────────────────────────────────────────────────

const MESSAGES_DEFAULT_LIMIT = 50;
const MESSAGES_MAX_LIMIT = 100;

export type ListMessagesOutcome =
  | {
      ok: true;
      threadId: string;
      status: dmThreads.DmThreadStatus;
      otherActorKey: string;
      otherName: string | null;
      messages: DmMessageView[];
    }
  | { ok: false; status: number; error: string };

export async function listThreadMessages(
  sessionUser: User | undefined,
  session: SessionRef,
  threadId: string,
  opts: { limit?: number; before?: string }
): Promise<ListMessagesOutcome> {
  const from = await actorFor(sessionUser, false, session);
  if (!from.ok) return from;

  const callerKey = actorKey(from.actor);
  const thread = await dmThreads.getThreadById(threadId);
  if (!thread) return { ok: false, status: 404, error: 'not_found' };

  // ★★★ PARTICIPANT GATE. A caller may only read a thread it is one of the two sides
  // of — a 404-for-non-participants would leak thread existence, so 403 once existence
  // is already established for a participant is fine, but a non-participant must not be
  // able to distinguish "not yours" from "does not exist".
  if (thread.actorAKey !== callerKey && thread.actorBKey !== callerKey) {
    return { ok: false, status: 404, error: 'not_found' };
  }

  const limit =
    typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(Math.floor(opts.limit), MESSAGES_MAX_LIMIT)
      : MESSAGES_DEFAULT_LIMIT;
  const before = typeof opts.before === 'string' && opts.before.length > 0 ? opts.before : undefined;

  const messages = await dmMessages.listMessages(threadId, { limit, before });
  const otherActorKey = thread.actorAKey === callerKey ? thread.actorBKey : thread.actorAKey;
  const names = await namesFor([otherActorKey]);
  return {
    ok: true,
    threadId,
    status: thread.status,
    otherActorKey,
    otherName: names.get(otherActorKey) ?? null,
    messages: messages.map((m) => ({
      messageId: m.messageId,
      senderActorKey: m.senderKey,
      nonce: m.nonceBase64,
      ciphertext: m.ciphertextBase64,
      senderKeyVersion: m.senderKeyVersion,
      recipientKeyVersion: m.recipientKeyVersion,
      createdAt: m.createdAt.toISOString(),
      readAt: m.readAt ? m.readAt.toISOString() : null
    }))
  };
}

// ── read: unread count + mark read ───────────────────────────────────────────

export type UnreadOutcome =
  | { ok: true; count: number }
  | { ok: false; status: number; error: string };

/** How many unread INCOMING messages the caller has across all their threads. */
export async function unreadDmCount(
  sessionUser: User | undefined,
  session: SessionRef
): Promise<UnreadOutcome> {
  const from = await actorFor(sessionUser, false, session);
  if (!from.ok) return from;
  const count = await dmMessages.countUnreadForActor(actorKey(from.actor));
  return { ok: true, count };
}

export type MarkReadOutcome =
  | { ok: true; marked: number }
  | { ok: false; status: number; error: string };

/**
 * Mark the caller's unread incoming messages read. `threadId` scopes it to one thread
 * (opening that conversation); omit it to mark everything read (opening the Messages
 * inbox). Idempotent — a repeat call marks nothing.
 */
export async function markDmsRead(
  sessionUser: User | undefined,
  session: SessionRef,
  opts: { threadId?: string } = {}
): Promise<MarkReadOutcome> {
  const from = await actorFor(sessionUser, false, session);
  if (!from.ok) return from;
  const marked = await dmMessages.markReadForActor(actorKey(from.actor), opts.threadId);
  return { ok: true, marked };
}
