import { query } from '../db/pool';
import { ulid } from '../ids';

/**
 * DM threads (migration 0040).
 *
 * One row per unordered pair of identities. The two `actor_key`s are stored SORTED
 * (`actor_a_key < actor_b_key`), so the same two people always collapse onto one thread
 * regardless of who wrote first. `requester_key` records the side that opened a
 * 'request'; a reply from the OTHER side promotes it to 'open' (the message-request
 * pattern — a stranger's first DM waits until the recipient answers).
 *
 * Nothing here touches plaintext. The last-message helper carries the OPAQUE ciphertext
 * bytes back to the caller base64-encoded for the browser to decrypt; the server never
 * decodes them.
 */

export type DmThreadStatus = 'request' | 'open';

interface ThreadRow {
  thread_id: string;
  actor_a_key: string;
  actor_b_key: string;
  requester_key: string;
  status: DmThreadStatus;
  last_message_at: Date;
  created_at: Date;
}

export interface DmThread {
  threadId: string;
  actorAKey: string;
  actorBKey: string;
  requesterKey: string;
  status: DmThreadStatus;
  lastMessageAt: Date;
  createdAt: Date;
}

function mapThread(row: ThreadRow): DmThread {
  return {
    threadId: row.thread_id,
    actorAKey: row.actor_a_key,
    actorBKey: row.actor_b_key,
    requesterKey: row.requester_key,
    status: row.status,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at
  };
}

/** Canonical sorted pair — the same two keys always yield the same (a, b). */
export function sortedPair(k1: string, k2: string): { a: string; b: string } {
  return k1 < k2 ? { a: k1, b: k2 } : { a: k2, b: k1 };
}

export async function getThreadByPair(k1: string, k2: string): Promise<DmThread | null> {
  const { a, b } = sortedPair(k1, k2);
  const { rows } = await query<ThreadRow>(
    `SELECT * FROM lumen_dm_thread WHERE actor_a_key = $1 AND actor_b_key = $2`,
    [a, b]
  );
  return rows[0] ? mapThread(rows[0]) : null;
}

export async function getThreadById(threadId: string): Promise<DmThread | null> {
  const { rows } = await query<ThreadRow>(`SELECT * FROM lumen_dm_thread WHERE thread_id = $1`, [
    threadId
  ]);
  return rows[0] ? mapThread(rows[0]) : null;
}

/**
 * Create the thread if absent, else touch `last_message_at` and promote a 'request' to
 * 'open' the moment the side that is NOT the requester sends into it.
 *
 * `initialStatus` decides the status only for a BRAND-NEW thread (the service sets it to
 * 'open' for a wanted conversation, 'request' for a stranger's). On an existing thread
 * the status is preserved except for the request -> open promotion above.
 */
export async function upsertThread(args: {
  senderKey: string;
  recipientKey: string;
  initialStatus: DmThreadStatus;
}): Promise<{ thread: DmThread; created: boolean }> {
  const { a, b } = sortedPair(args.senderKey, args.recipientKey);
  const { rows } = await query<ThreadRow & { inserted: boolean }>(
    `INSERT INTO lumen_dm_thread
       (thread_id, actor_a_key, actor_b_key, requester_key, status, last_message_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (actor_a_key, actor_b_key) DO UPDATE
       SET last_message_at = now(),
           status = CASE
             WHEN lumen_dm_thread.status = 'request'
               AND lumen_dm_thread.requester_key <> EXCLUDED.requester_key
               THEN 'open'
             ELSE lumen_dm_thread.status
           END
     RETURNING *, (xmax = 0) AS inserted`,
    // requester_key = the sender: on a new thread they are the requester; on an existing
    // one EXCLUDED.requester_key is compared against the stored requester to promote it.
    [ulid(), a, b, args.senderKey, args.initialStatus]
  );
  const row = rows[0];
  const { inserted, ...threadRow } = row;
  return { thread: mapThread(threadRow), created: inserted };
}

export interface DmThreadLastMessage {
  messageId: string;
  senderKey: string;
  nonceBase64: string;
  ciphertextBase64: string;
  senderKeyVersion: number;
  recipientKeyVersion: number;
  createdAt: Date;
  readAt: Date | null;
}

export interface DmThreadListItem {
  threadId: string;
  status: DmThreadStatus;
  otherKey: string;
  isRequester: boolean;
  lastMessageAt: Date;
  createdAt: Date;
  lastMessage: DmThreadLastMessage | null;
}

interface ThreadListRow extends ThreadRow {
  message_id: string | null;
  sender_key: string | null;
  nonce: Buffer | null;
  ciphertext: Buffer | null;
  sender_key_version: number | null;
  recipient_key_version: number | null;
  m_created_at: Date | null;
  read_at: Date | null;
}

/**
 * Every thread this caller is a participant in, newest first, each with its last
 * message's OPAQUE ciphertext for a client-decrypted preview. One LATERAL join fetches
 * the latest message per thread in a single query rather than N follow-ups.
 *
 * ★ The `nonce`/`ciphertext` Buffers are re-encoded to base64 verbatim — a transport
 * encoding of the already-encrypted bytes, NOT a decode of any plaintext.
 */
export async function listThreadsWithLastMessage(
  callerKey: string,
  opts: { limit: number }
): Promise<DmThreadListItem[]> {
  const { rows } = await query<ThreadListRow>(
    `SELECT t.thread_id, t.actor_a_key, t.actor_b_key, t.requester_key, t.status,
            t.last_message_at, t.created_at,
            m.message_id, m.sender_key, m.nonce, m.ciphertext,
            m.sender_key_version, m.recipient_key_version,
            m.created_at AS m_created_at, m.read_at
       FROM lumen_dm_thread t
       LEFT JOIN LATERAL (
         SELECT message_id, sender_key, nonce, ciphertext, sender_key_version,
                recipient_key_version, created_at, read_at
           FROM lumen_dm_message msg
          WHERE msg.thread_id = t.thread_id
          ORDER BY msg.message_id DESC
          LIMIT 1
       ) m ON true
      WHERE t.actor_a_key = $1 OR t.actor_b_key = $1
      ORDER BY t.last_message_at DESC
      LIMIT $2`,
    [callerKey, opts.limit]
  );
  return rows.map((r) => ({
    threadId: r.thread_id,
    status: r.status,
    otherKey: r.actor_a_key === callerKey ? r.actor_b_key : r.actor_a_key,
    isRequester: r.requester_key === callerKey,
    lastMessageAt: r.last_message_at,
    createdAt: r.created_at,
    lastMessage:
      r.message_id && r.nonce && r.ciphertext
        ? {
            messageId: r.message_id,
            senderKey: r.sender_key ?? '',
            nonceBase64: r.nonce.toString('base64'),
            ciphertextBase64: r.ciphertext.toString('base64'),
            senderKeyVersion: r.sender_key_version ?? 0,
            recipientKeyVersion: r.recipient_key_version ?? 0,
            createdAt: r.m_created_at ?? r.last_message_at,
            readAt: r.read_at
          }
        : null
  }));
}
