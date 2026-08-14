import type { JsonMetadata } from '@hive/common-hiveio-packages/wax';

/**
 * What a SHORT post is on chain, and how everything downstream recognises it.
 *
 * ★★★ WHY A NOTE NEEDS A MARKER AT ALL (composer audit findings 7 and §9.6).
 *
 * A note has no title. Hive requires one, and so does every feed card ever
 * written, so the composer derives one by stripping markdown off the first line
 * and truncating it (`lib/short-post-title.ts`). That is a reasonable answer to
 * "Hive demands a title" and a terrible answer to "what should the reader see":
 * measured on chain, the note `hbd-temp/testing-the-lumen-short-form-composer`
 * has `title` and `body` that are the SAME SENTENCE, so its permalink page
 * printed a magazine-sized Lora headline and then repeated it verbatim as the
 * article, and its feed card printed it as a bold headline and again as the
 * excerpt underneath.
 *
 * The fix is not to send an empty title — a titleless post breaks every OTHER
 * Hive front end, and our own share cards and search results. The fix is to say
 * what kind of thing this is, so OUR renderers can choose a layout: one line of
 * text, no headline, no duplicated excerpt. `json_metadata.type = 'note'`.
 *
 * Absence of the marker means "ordinary article" — every post written before
 * 2026-08-14, and every post from any other front end, keeps rendering exactly
 * as it does today. Nothing has to be migrated.
 */
export const NOTE_METADATA_TYPE = 'note';

/**
 * Is this post a Lumen short-form note?
 *
 * Deliberately tolerant about the input: `json_metadata` arrives from the chain
 * as whatever the writing client put there, and several code paths in this app
 * hand it around before it has been parsed. Anything that is not an object with
 * `type === 'note'` is an ordinary article.
 */
export function isNotePost(jsonMetadata: JsonMetadata | undefined | null): boolean {
  if (!jsonMetadata || typeof jsonMetadata !== 'object') return false;
  return jsonMetadata.type === NOTE_METADATA_TYPE;
}

/** Longest slug we keep before the uniqueness suffix (audit §9.6). */
const MAX_SLUG = 48;

/**
 * A URL-safe slug of a note's title, for the readable half of its permlink.
 *
 * Hive permlinks accept lowercase letters, digits and hyphens and nothing else.
 * `normalize('NFD')` + combining-mark strip turns "Café" into "cafe" instead of
 * dropping the word; scripts with no latin decomposition (Cyrillic, CJK, Arabic)
 * legitimately reduce to nothing, and the caller falls back to `note` — which is
 * why the uniqueness suffix below is not optional decoration.
 */
export function slugifyNoteTitle(title: string): string {
  return (title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
}

/**
 * The permlink a note is published under.
 *
 * ★★★ THE SUFFIX IS THE WHOLE POINT (audit finding 8).
 *
 * The composer used to take `createPermlink(title, author)` from
 * `packages/transaction/lib/utils.ts`, which slugs the title and then asks
 * Hivemind — `getPostHeader(author, slug)` — whether that permlink already
 * exists, prefixing random noise only if it does. Two things are wrong with that
 * here. First, the existence check is a NETWORK READ wrapped in a bare
 * `catch (e) {}`: when it fails, `head` is undefined, the code concludes "free"
 * and returns the bare slug — so a transient API blip turns into a rejected
 * broadcast. Second, Hivemind indexes minutes behind the chain, so a note
 * published moments ago is not there to be found yet.
 *
 * That matters far more than it sounds, because of the OTHER bug the audit
 * found: publishing used to give no visible confirmation, so the single most
 * likely path through this code is a reader who believes it failed and presses
 * Post again. With a bare slug the retry collides and Hive rejects it — the one
 * user in the world who most needs the retry to work is the one it breaks for.
 *
 * `Date.now().toString(36)` is 8 characters, monotonic, and needs no round trip,
 * so the same words posted twice can never produce the same permlink. Verified
 * against the control build: before, `payload-probe-alpha-bravo-charlie-delta`;
 * after, the same slug plus a suffix.
 */
export function shortPostPermlink(title: string, now: number = Date.now()): string {
  const slug = slugifyNoteTitle(title) || NOTE_METADATA_TYPE;
  return `${slug}-${now.toString(36)}`;
}
