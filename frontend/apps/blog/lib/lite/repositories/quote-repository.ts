import { createHash } from 'crypto';
import { Exec, query } from '../db/pool';
import { ulid } from '../ids';

/**
 * Quote reblogs, the index (migration 0050; spec v2 section 7.1). The chain holds the
 * text; this table is how Lumen finds a person's quote on a post and what moderation
 * acts on. Server-only.
 */

export type QuoteState = 'pending' | 'live' | 'removed' | 'hidden';

/** Who quoted: a Lumen user id or a Hive account, never both (`ck_one_quoter`). */
export type Quoter = { userId: string; hive?: undefined } | { hive: string; userId?: undefined };

export interface LumenQuote {
  quoteId: string;
  quoterUserId: string | null;
  quoterHive: string | null;
  quoterKey: string;
  targetAuthor: string;
  targetPermlink: string;
  quoteAuthor: string;
  quotePermlink: string;
  containerAuthor: string;
  containerPermlink: string;
  litePostId: string | null;
  bodyCache: string;
  state: QuoteState;
  createdAt: Date;
  updatedAt: Date;
}

interface QuoteRow {
  quote_id: string;
  quoter_user_id: string | null;
  quoter_hive: string | null;
  quoter_key: string;
  target_author: string;
  target_permlink: string;
  quote_author: string;
  quote_permlink: string;
  container_author: string;
  container_permlink: string;
  lite_post_id: string | null;
  body_cache: string;
  state: string;
  created_at: Date;
  updated_at: Date;
}

function map(r: QuoteRow): LumenQuote {
  return {
    quoteId: r.quote_id,
    quoterUserId: r.quoter_user_id,
    quoterHive: r.quoter_hive,
    quoterKey: r.quoter_key,
    targetAuthor: r.target_author,
    targetPermlink: r.target_permlink,
    quoteAuthor: r.quote_author,
    quotePermlink: r.quote_permlink,
    containerAuthor: r.container_author,
    containerPermlink: r.container_permlink,
    litePostId: r.lite_post_id,
    bodyCache: r.body_cache,
    state: r.state as QuoteState,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

/** The same key the table generates, for building lookups in code. */
export function quoterKeyOf(quoter: Quoter): string {
  return quoter.userId ? `u:${quoter.userId}` : `h:${String(quoter.hive).toLowerCase()}`;
}

/**
 * A Hive user's quote permlink, derived from the TARGET (spec v2 2.3): one quote per
 * person per post, so a retry after an unknown outcome is an edit of the same comment,
 * never a duplicate. `lumen-rq-` + the first 16 base36 characters of
 * sha256("<author>/<permlink>"). Cannot collide with a lite permlink, which is
 * `lumen-` + exactly 26 ULID characters (lib/lite/render/lite-post-id.ts).
 */
export function quotePermlinkFor(targetAuthor: string, targetPermlink: string): string {
  const digest = createHash('sha256').update(`${targetAuthor}/${targetPermlink}`).digest('hex');
  const base36 = BigInt(`0x${digest}`).toString(36).padStart(16, '0');
  return `lumen-rq-${base36.slice(0, 16)}`;
}

export interface NewQuote {
  quoter: Quoter;
  targetAuthor: string;
  targetPermlink: string;
  quoteAuthor: string;
  quotePermlink: string;
  containerAuthor: string;
  containerPermlink: string;
  litePostId?: string | null;
  bodyCache: string;
  state: 'pending' | 'live';
}

/**
 * Insert a quote, or return the one this person already has on this post (one per
 * person per post while it exists, `ux_quote_live`). `created: false` means the
 * existing row came back and nothing was written.
 */
export async function insertQuote(input: NewQuote, exec: Exec = query): Promise<{ quote: LumenQuote; created: boolean }> {
  const { rows } = await exec<QuoteRow>(
    `INSERT INTO lumen_quote
       (quote_id, quoter_user_id, quoter_hive, target_author, target_permlink, quote_author, quote_permlink,
        container_author, container_permlink, lite_post_id, body_cache, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (quoter_key, target_author, target_permlink) WHERE state IN ('pending', 'live', 'hidden')
     DO NOTHING
     RETURNING *`,
    [
      ulid(),
      input.quoter.userId ?? null,
      input.quoter.hive ?? null,
      input.targetAuthor,
      input.targetPermlink,
      input.quoteAuthor,
      input.quotePermlink,
      input.containerAuthor,
      input.containerPermlink,
      input.litePostId ?? null,
      input.bodyCache,
      input.state
    ]
  );
  if (rows[0]) return { quote: map(rows[0]), created: true };
  const existing = await findActive(input.quoter, input.targetAuthor, input.targetPermlink, exec);
  if (!existing) throw new Error('quote insert conflicted but no active row was found');
  return { quote: existing, created: false };
}

/** This person's current quote on this post (pending, live or hidden), if any. */
export async function findActive(
  quoter: Quoter,
  targetAuthor: string,
  targetPermlink: string,
  exec: Exec = query
): Promise<LumenQuote | null> {
  const { rows } = await exec<QuoteRow>(
    `SELECT * FROM lumen_quote
      WHERE quoter_key = $1 AND target_author = $2 AND target_permlink = $3
        AND state IN ('pending', 'live', 'hidden')`,
    [quoterKeyOf(quoter), targetAuthor, targetPermlink]
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function findById(quoteId: string): Promise<LumenQuote | null> {
  const { rows } = await query<QuoteRow>(`SELECT * FROM lumen_quote WHERE quote_id = $1`, [quoteId]);
  return rows[0] ? map(rows[0]) : null;
}

/** The quote whose on-chain comment is at these coordinates (newest first if re-created). */
export async function findByCoords(quoteAuthor: string, quotePermlink: string): Promise<LumenQuote | null> {
  const { rows } = await query<QuoteRow>(
    `SELECT * FROM lumen_quote WHERE quote_author = $1 AND quote_permlink = $2 ORDER BY seq DESC LIMIT 1`,
    [quoteAuthor, quotePermlink]
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function setState(quoteId: string, state: QuoteState, bodyCache?: string): Promise<LumenQuote | null> {
  const { rows } = await query<QuoteRow>(
    `UPDATE lumen_quote
        SET state = $2, body_cache = COALESCE($3, body_cache), updated_at = now()
      WHERE quote_id = $1
      RETURNING *`,
    [quoteId, state, bodyCache ?? null]
  );
  return rows[0] ? map(rows[0]) : null;
}

/**
 * Moderation of a whole account (spec v2 7.6): hide every quote by this Lumen user, or
 * restore them (a lite quote back to `live` once on Hive, else `pending`; a quote they
 * signed with their own Hive key back to `live`). Removed quotes stay removed.
 */
export async function setStateForUser(userId: string, hide: boolean): Promise<number> {
  const { rowCount } = hide
    ? await query(
        `UPDATE lumen_quote SET state = 'hidden', updated_at = now()
          WHERE quoter_user_id = $1 AND state IN ('pending', 'live')`,
        [userId]
      )
    : await query(
        `UPDATE lumen_quote q
            SET state = CASE
                  WHEN q.lite_post_id IS NULL THEN 'live'
                  WHEN (SELECT p.hive_permlink FROM lumen_post p WHERE p.post_id = q.lite_post_id) IS NULL THEN 'pending'
                  ELSE 'live'
                END,
                updated_at = now()
          WHERE q.quoter_user_id = $1 AND q.state = 'hidden'`,
        [userId]
      );
  return rowCount ?? 0;
}

/** A lite quote reached Hive (the publisher published its post): pending -> live. */
export async function markLitePublished(litePostId: string): Promise<void> {
  await query(
    `UPDATE lumen_quote SET state = 'live', updated_at = now()
      WHERE lite_post_id = $1 AND state = 'pending'`,
    [litePostId]
  );
}

/** The quote whose lite post this is moved to `state` (deleted, target gone, moderated). */
export async function setStateByLitePost(litePostId: string, state: QuoteState): Promise<void> {
  await query(
    `UPDATE lumen_quote SET state = $2, updated_at = now()
      WHERE lite_post_id = $1 AND state IN ('pending', 'live', 'hidden')`,
    [litePostId, state]
  );
}

/**
 * ONE question for a whole feed page: which of these (reblogger, post) pairs have a
 * live quote. Keyed by `<quoterKey>|<author>/<permlink>`.
 */
export async function liveQuotesForPairs(
  pairs: { quoterKey: string; targetAuthor: string; targetPermlink: string }[]
): Promise<Map<string, LumenQuote>> {
  const out = new Map<string, LumenQuote>();
  if (pairs.length === 0) return out;
  const { rows } = await query<QuoteRow>(
    `SELECT q.* FROM lumen_quote q
       JOIN unnest($1::text[], $2::text[], $3::text[]) AS p(k, a, pl)
         ON q.quoter_key = p.k AND q.target_author = p.a AND q.target_permlink = p.pl
      WHERE q.state = 'live'`,
    [pairs.map((p) => p.quoterKey), pairs.map((p) => p.targetAuthor), pairs.map((p) => p.targetPermlink)]
  );
  for (const r of rows) out.set(`${r.quoter_key}|${r.target_author}/${r.target_permlink}`, map(r));
  return out;
}

/** Live quotes of one post, newest first (the post page's "N quotes" list). */
export async function liveQuotesOfTarget(targetAuthor: string, targetPermlink: string, limit = 20): Promise<LumenQuote[]> {
  const { rows } = await query<QuoteRow>(
    `SELECT * FROM lumen_quote
      WHERE target_author = $1 AND target_permlink = $2 AND state = 'live'
      ORDER BY created_at DESC
      LIMIT $3`,
    [targetAuthor, targetPermlink, Math.max(1, Math.min(100, limit))]
  );
  return rows.map(map);
}

/** One person's live quotes, newest first, for the profile Posts tab. */
export async function liveQuotesByQuoter(quoterKey: string, before: Date | null, limit = 20): Promise<LumenQuote[]> {
  const { rows } = await query<QuoteRow>(
    `SELECT * FROM lumen_quote
      WHERE quoter_key = $1 AND state = 'live' AND ($2::timestamptz IS NULL OR created_at < $2)
      ORDER BY created_at DESC
      LIMIT $3`,
    [quoterKey, before, Math.max(1, Math.min(100, limit))]
  );
  return rows.map(map);
}

/** A quote of one of this person's posts, for their notifications (spec v2 7.7). */
export interface QuoteNotice {
  quote: LumenQuote;
  /** Who quoted, as the bell names them (Hive name, else Lumen handle). */
  quoterName: string;
}

/**
 * The newest live (or, for a lite quoter, still-publishing) quotes of this person's
 * posts, never their own (decision D6: quoting yourself notifies nobody). A Hive author
 * owns the posts under their name; a Lumen author owns the Lumen posts (published by
 * `publisher`) whose rows are theirs.
 */
export async function recentQuotesOfOwner(
  owner: { hive?: string; userId?: string },
  publisher: string,
  limit = 20
): Promise<QuoteNotice[]> {
  const ownKey = owner.userId ? `u:${owner.userId}` : `h:${String(owner.hive).toLowerCase()}`;
  const { rows } = owner.userId
    ? await query<QuoteRow & { quoter_name: string | null }>(
        `SELECT q.*, COALESCE(q.quoter_hive, u.hive_account_name, u.display_name) AS quoter_name
           FROM lumen_quote q
           JOIN lumen_post p ON p.post_id = lumen_permlink_post_id(q.target_permlink)
           LEFT JOIN lumen_user u ON u.user_id = q.quoter_user_id
          WHERE q.target_author = $2 AND p.user_id = $1 AND q.state IN ('live', 'pending') AND q.quoter_key <> $3
          ORDER BY q.created_at DESC
          LIMIT $4`,
        [owner.userId, publisher, ownKey, limit]
      )
    : await query<QuoteRow & { quoter_name: string | null }>(
        `SELECT q.*, COALESCE(q.quoter_hive, u.hive_account_name, u.display_name) AS quoter_name
           FROM lumen_quote q
           LEFT JOIN lumen_user u ON u.user_id = q.quoter_user_id
          WHERE q.target_author = $1 AND q.state IN ('live', 'pending') AND q.quoter_key <> $2
          ORDER BY q.created_at DESC
          LIMIT $3`,
        [String(owner.hive).toLowerCase(), ownKey, limit]
      );
  return rows.map((r) => ({ quote: map(r), quoterName: r.quoter_name ?? 'someone' }));
}

