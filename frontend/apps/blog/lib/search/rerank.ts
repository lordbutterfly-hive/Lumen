/**
 * ★★ WHY A RE-RANK EXISTS (UX-AUDIT-TRIAGE 2026-08-17 rank 1, CONFIRMED High;
 * re-measured 2026-09-05).
 *
 * Hivemind's `search_api.find_text` orders "relevance" by Postgres `ts_rank`
 * alone: how often the words occur, nothing about when or whether anyone read
 * it. Measured 2026-09-05 for `photography`, the top five were dated 2018, 2017,
 * 2017, 2017, 2017 with payouts of $0, $0.5, $19, $4.6, $17; the first result was
 * literally titled "photography photography". For `splinterlands` the first was
 * "SPLINTERLANDS SPLINTERLANDS SP...". That is what a reader means by "search is
 * broken": the answer is technically a match and practically spam.
 *
 * There is no server-side knob for this (the sort options are `relevance` and
 * `created`, and `created` hits the node's statement timeout on any broad
 * term), so the fix is a re-rank of each page we receive:
 *
 *   score = 0.55 * relevance + 0.30 * recency + 0.15 * engagement
 *
 *   relevance  = 1 - position / n         (upstream order, still the biggest term)
 *   recency    = 1 / (1 + ageDays / 365)  (today 1.0, one year 0.5, eight years 0.11)
 *   engagement = min(1, log10(1 + votes + comments) / 3)   (1,000 reactions = 1.0)
 *
 * With 20 rows a position is worth 0.0275; the full recency swing (0.24) is
 * about nine positions. So a fresh, discussed post can climb over the old
 * repeated-keyword spam near the top, and the tail of the page cannot leap over
 * a strong keyword match. Stable sort, so equal scores keep upstream order.
 *
 * ★ PER PAGE, NEVER ACROSS PAGES. Infinite scroll appends pages; re-sorting the
 * whole list on every append would move rows the reader is looking at. And the
 * pagination cursor (`start_author`/`start_permlink`) MUST stay the last row of
 * the RAW upstream page, which is why the caller re-ranks only what it renders
 * (`search-results.tsx`) and never what it pages from.
 */

/** The fields the score reads; structural so the test needs no wax `Entry`. */
export interface RerankableEntry {
  created?: string;
  children?: number;
  net_votes?: number;
  stats?: { total_votes?: number };
}

const RELEVANCE_WEIGHT = 0.55;
const RECENCY_WEIGHT = 0.3;
const ENGAGEMENT_WEIGHT = 0.15;
const DAY_MS = 86_400_000;

/**
 * Hivemind timestamps have no zone suffix (`2024-06-20T08:25:03`) and are UTC.
 * `Date.parse` would read that as LOCAL time on a server not running in UTC, so
 * the `Z` is added when missing. An unparseable date scores as very old rather
 * than as "now", so a broken field cannot promote a row.
 */
export function ageDaysOf(created: string | undefined, nowMs: number): number {
  if (!created) return 365 * 20;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(created) ? created : `${created}Z`;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 365 * 20;
  return Math.max(0, (nowMs - t) / DAY_MS);
}

export function rerankScore(entry: RerankableEntry, position: number, count: number, nowMs: number): number {
  const relevance = count > 0 ? 1 - position / count : 1;
  const recency = 1 / (1 + ageDaysOf(entry.created, nowMs) / 365);
  const votes = Math.max(0, entry.stats?.total_votes ?? entry.net_votes ?? 0);
  const comments = Math.max(0, entry.children ?? 0);
  const engagement = Math.min(1, Math.log10(1 + votes + comments) / 3);
  return RELEVANCE_WEIGHT * relevance + RECENCY_WEIGHT * recency + ENGAGEMENT_WEIGHT * engagement;
}

/** Returns a NEW array; the input (the raw page the cursor is read from) is untouched. */
export function rerankSearchPage<T extends RerankableEntry>(entries: readonly T[], nowMs: number = Date.now()): T[] {
  const count = entries.length;
  return entries
    .map((entry, position) => ({ entry, position, score: rerankScore(entry, position, count, nowMs) }))
    .sort((a, b) => b.score - a.score || a.position - b.position)
    .map((row) => row.entry);
}
