import { query } from '../db/pool';
import { ulid } from '../ids';

/**
 * DM messages (migration 0040).
 *
 * ★★★ `nonce` and `ciphertext` are OPAQUE BYTES. This module writes them verbatim and
 * reads them back verbatim (base64-encoded for transport only); it never decodes,
 * inspects or logs the message content. Decryption happens exclusively in the browser
 * that holds the private key. If a change here ever needs to look INSIDE `ciphertext`,
 * that is the bug.
 *
 * `message_id` is a ULID (crypto-random, time-sortable), so a single DESC scan gives
 * newest-first order AND the keyset-pagination cursor (`message_id < before`).
 */

export interface DmMessageInput {
  threadId: string;
  senderKey: string;
  /** Opaque AEAD nonce bytes (24 for XChaCha20-Poly1305). Never interpreted. */
  nonce: Buffer;
  /** Opaque AEAD ciphertext bytes. Never interpreted. */
  ciphertext: Buffer;
  senderKeyVersion: number;
  recipientKeyVersion: number;
}

export interface DmMessage {
  messageId: string;
  threadId: string;
  senderKey: string;
  nonceBase64: string;
  ciphertextBase64: string;
  senderKeyVersion: number;
  recipientKeyVersion: number;
  createdAt: Date;
  readAt: Date | null;
}

interface MessageRow {
  message_id: string;
  thread_id: string;
  sender_key: string;
  nonce: Buffer;
  ciphertext: Buffer;
  sender_key_version: number;
  recipient_key_version: number;
  created_at: Date;
  read_at: Date | null;
}

function mapMessage(row: MessageRow): DmMessage {
  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    senderKey: row.sender_key,
    // base64 of the stored bytes — verbatim ciphertext for the client to decrypt, not a
    // plaintext decode.
    nonceBase64: row.nonce.toString('base64'),
    ciphertextBase64: row.ciphertext.toString('base64'),
    senderKeyVersion: row.sender_key_version,
    recipientKeyVersion: row.recipient_key_version,
    createdAt: row.created_at,
    readAt: row.read_at
  };
}

export async function insertMessage(
  input: DmMessageInput
): Promise<{ messageId: string; createdAt: Date }> {
  const messageId = ulid();
  const { rows } = await query<{ created_at: Date }>(
    `INSERT INTO lumen_dm_message
       (message_id, thread_id, sender_key, nonce, ciphertext, sender_key_version, recipient_key_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING created_at`,
    [
      messageId,
      input.threadId,
      input.senderKey,
      input.nonce,
      input.ciphertext,
      input.senderKeyVersion,
      input.recipientKeyVersion
    ]
  );
  return { messageId, createdAt: rows[0].created_at };
}

/**
 * A page of a thread's messages, newest first. `before` is a ULID cursor: pass the
 * oldest `messageId` from the previous page to fetch the next older page.
 *
 * The participant check is the CALLER's responsibility (the service enforces it before
 * calling this) — this repository takes a `threadId` it trusts has been authorised.
 */
export async function listMessages(
  threadId: string,
  opts: { limit: number; before?: string }
): Promise<DmMessage[]> {
  const { rows } = await query<MessageRow>(
    `SELECT message_id, thread_id, sender_key, nonce, ciphertext,
            sender_key_version, recipient_key_version, created_at, read_at
       FROM lumen_dm_message
      WHERE thread_id = $1
        AND ($2::text IS NULL OR message_id < $2)
      ORDER BY message_id DESC
      LIMIT $3`,
    [threadId, opts.before ?? null, opts.limit]
  );
  return rows.map(mapMessage);
}

/**
 * How many messages the actor has NOT read: INCOMING (sender != actor) messages in
 * threads the actor participates in, with read_at still null. The thread join is the
 * authorisation boundary — an actor only ever counts messages in their own threads,
 * and never their own sent messages. Content is never touched.
 */
export async function countUnreadForActor(actorKey: string): Promise<number> {
  const { rows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM lumen_dm_message m
       JOIN lumen_dm_thread t ON t.thread_id = m.thread_id
      WHERE (t.actor_a_key = $1 OR t.actor_b_key = $1)
        AND m.sender_key <> $1
        AND m.read_at IS NULL`,
    [actorKey]
  );
  return rows[0]?.n ?? 0;
}

/**
 * Mark the actor's unread INCOMING messages read (read_at = now). Scoped to one thread
 * when threadId is given, otherwise every thread the actor participates in. Only ever
 * touches messages the actor RECEIVED (sender != actor) that are not already read, so
 * read_at records first-read and a repeat call is a no-op. Returns the number newly
 * marked. Never touches content.
 */
export interface UnreadSender {
  senderKey: string;
  at: Date;
}

/**
 * The distinct senders who have UNREAD incoming messages to the actor, newest message
 * per sender first — for the notifications bell ("New message from @X"). One row per
 * sender (not per message) so a chatty sender does not flood the bell. Content is never
 * touched. The thread join is the authorisation boundary.
 */
export async function unreadSendersForActor(actorKey: string, limit: number): Promise<UnreadSender[]> {
  const { rows } = await query<{ sender_key: string; at: Date }>(
    `SELECT DISTINCT ON (m.sender_key) m.sender_key, m.created_at AS at
       FROM lumen_dm_message m
       JOIN lumen_dm_thread t ON t.thread_id = m.thread_id
      WHERE (t.actor_a_key = $1 OR t.actor_b_key = $1)
        AND m.sender_key <> $1
        AND m.read_at IS NULL
      ORDER BY m.sender_key, m.message_id DESC
      LIMIT $2`,
    [actorKey, limit]
  );
  return rows.map((r) => ({ senderKey: r.sender_key, at: r.at }));
}

export async function markReadForActor(actorKey: string, threadId?: string): Promise<number> {
  const { rows } = await query<{ message_id: string }>(
    `UPDATE lumen_dm_message m
        SET read_at = now()
       FROM lumen_dm_thread t
      WHERE t.thread_id = m.thread_id
        AND (t.actor_a_key = $1 OR t.actor_b_key = $1)
        AND m.sender_key <> $1
        AND m.read_at IS NULL
        AND ($2::text IS NULL OR m.thread_id = $2)
      RETURNING m.message_id`,
    [actorKey, threadId ?? null]
  );
  return rows.length;
}
