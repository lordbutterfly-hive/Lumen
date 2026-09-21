import { query } from '../db/pool';

/**
 * The buyer's message attached to one Meritum request. Migration
 * `0048_creator_ask_notes.sql` carries the full argument for why this is a
 * Lumen table rather than a contract field; the short version is that an
 * escrow carries ONE 128-byte reference for the question and the dialog
 * deliberately mints a short hash of the text, not the text.
 *
 * The chain owns the RECEIPT (contentHash). This owns the WORDS, filed under
 * that receipt, and the route refuses any words that do not hash to it — so a
 * row here is checkable against the escrow it belongs to.
 */

// The rules live in a DB-free module so the client hook and this route apply
// the SAME ones without dragging the pg pool into the browser bundle.
export { MAX_ASK_NOTE_CHARS, askReferenceOf, noteTextProblem } from '@/blog/lib/meritum/ask-note';

export interface AskNoteRow {
  creator: string;
  contentHash: string;
  asker: string;
  text: string;
  /** ISO-8601 with zone, from the row's TIMESTAMPTZ. */
  createdAt: string;
}

/**
 * File one message under (creator, contentHash).
 *
 * Resolves true when the row is now this asker's — inserted fresh, or
 * re-written by the SAME asker (a retry after a timeout, or the identical
 * question asked again). Resolves false when a DIFFERENT asker already holds
 * the reference: the row's `asker` is never rewritten, because the creator
 * reads it as "who sent this", and the first filing is the one the chain's
 * first escrow for that reference belongs to.
 *
 * Throws on a database failure: unlike the read, a write that silently did
 * nothing would tell a buyer their message went with the request when it did
 * not.
 */
export async function putAskNote(input: { creator: string; contentHash: string; asker: string; text: string }): Promise<boolean> {
  const result = await query(
    `INSERT INTO creator_ask_note (creator, content_hash, asker, text)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (creator, content_hash)
     DO UPDATE SET text = EXCLUDED.text
     WHERE creator_ask_note.asker = EXCLUDED.asker`,
    [input.creator, input.contentHash, input.asker, input.text]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * The notes filed under these references for one creator. An unknown
 * reference simply has no row. THROWS on a database failure, deliberately —
 * the route turns that into `unavailable: true`, because the reader must be
 * able to tell "no message was attached" from "we could not look", and the
 * degrade-to-empty posture the description repository takes would erase that
 * difference for a buyer checking whether their words arrived.
 */
export async function notesFor(creator: string, hashes: string[]): Promise<AskNoteRow[]> {
  if (hashes.length === 0) return [];
  const { rows } = await query<{ creator: string; content_hash: string; asker: string; text: string; created_at: Date }>(
    `SELECT creator, content_hash, asker, text, created_at
       FROM creator_ask_note
      WHERE creator = $1 AND content_hash = ANY($2::text[])`,
    [creator, hashes]
  );
  return rows.map((r) => ({
    creator: r.creator,
    contentHash: r.content_hash,
    asker: r.asker,
    text: r.text,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at)
  }));
}
