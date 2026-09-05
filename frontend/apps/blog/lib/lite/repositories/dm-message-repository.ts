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
