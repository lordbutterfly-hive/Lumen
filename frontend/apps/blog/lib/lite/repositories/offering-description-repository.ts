import { query } from '../db/pool';

/**
 * The creator-written description for one posted service. Migration
 * `0045_offering_descriptions.sql` carries the full argument for why this is a
 * Lumen table rather than a contract field; the short version is that the chain
 * bounds the title at 64 BYTES and charges ~41 RC per byte, so 100 words of prose
 * on chain would cost ~25,000 RC per createOffering against 5,693 today.
 *
 * The chain owns the IDENTITY (title, price, the anti-rug band anchored to the
 * title). This owns the PROSE, and nothing settles against it.
 */

// The rule itself lives in a DB-free module so the Studio form and this route
// apply the SAME one without dragging the pg pool into the browser bundle.
export { MAX_DESCRIPTION_WORDS, MAX_DESCRIPTION_BYTES, descriptionProblem } from '@/blog/features/creator-tokens/lib/offering-description';

/**
 * Every description this creator has written, keyed by offering id.
 *
 * Returns an EMPTY MAP on any database failure rather than throwing: this feeds a
 * buyer-facing shop, and a Lumen DB hiccup must cost a paragraph of prose, never
 * the list of services someone came to buy. Same degrade-open posture as every
 * other optional read in this codebase.
 */
export async function descriptionsForCreator(creator: string): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const key = creator.trim();
  if (!key) return out;
  try {
    const rows = await query<{ offering_id: string; description: string }>(
      'SELECT offering_id, description FROM creator_offering_description WHERE creator = $1',
      [key]
    );
    for (const r of rows.rows) {
      const id = Number(r.offering_id);
      if (Number.isFinite(id)) out.set(id, r.description);
    }
  } catch {
    // Degrades open. See the doc above.
  }
  return out;
}

/**
 * Write (or, on empty text, clear) one description. Throws on a database failure:
 * unlike the read, a write that silently did nothing would tell a creator their
 * words were saved when they were not.
 */
export async function setOfferingDescription(
  creator: string,
  offeringId: number,
  description: string
): Promise<void> {
  const key = creator.trim();
  const text = description.trim();
  if (text === '') {
    await query('DELETE FROM creator_offering_description WHERE creator = $1 AND offering_id = $2', [
      key,
      offeringId
    ]);
    return;
  }
  await query(
    `INSERT INTO creator_offering_description (creator, offering_id, description, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (creator, offering_id)
     DO UPDATE SET description = EXCLUDED.description, updated_at = now()`,
    [key, offeringId, text]
  );
}
