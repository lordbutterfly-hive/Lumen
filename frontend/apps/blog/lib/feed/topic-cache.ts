import type { Entry } from '@hive/common-hiveio-packages/wax';
import type { FeedLane } from '@/blog/lib/feed/feed-cache';

/**
 * ★★★ THE TOPIC FEED CACHE, SHARED BETWEEN THE API ROUTE AND THE TOPIC PAGE
 * (2026-09-03, snappiness phase 4). It used to live inside
 * app/api/feed/for-you/route.ts, where only that handler could read it, so a
 * reader opening /topics/<tag> always paid: shell first, hydrate, then a
 * second round trip to the very route that already held the answer. The page
 * now seeds itself from this cache when the topic is warm, so the posts are in
 * the first paint and the first click is one round trip (see
 * app/topics/[tag]/page.tsx). Cold topics behave exactly as before.
 *
 * ★ ON `globalThis`, NOT A MODULE-LEVEL Map. Next bundles server code per
 * route; a module imported by both the route and the page can end up as TWO
 * copies with two Maps that never see each other (lib/feed/viewer-warmer.ts
 * documents the same trap and the same cure). The process-wide slot is the only
 * thing both copies share.
 *
 * Semantics are unchanged from the route's own cache: five minutes, bounded at
 * 200 keys by insertion order, keyed by `viewer|topic`, entries stored as the
 * route built them (banned authors already removed, bodies untrimmed).
 */
export const TOPIC_CACHE_MS = 300_000;
export const TOPIC_CACHE_MAX = 200;

export interface TopicFeedEntry {
  entries: Entry[];
  ranked: number;
  lanes: FeedLane[];
  at: number;
}

const SLOT = '__lumenTopicFeedCache';
function store(): Map<string, TopicFeedEntry> {
  const g = globalThis as unknown as Record<string, Map<string, TopicFeedEntry> | undefined>;
  if (!g[SLOT]) g[SLOT] = new Map<string, TopicFeedEntry>();
  return g[SLOT] as Map<string, TopicFeedEntry>;
}

export function topicKeyFor(viewer: string, topic: string): string {
  return `${viewer}|${topic}`;
}

export function rememberTopicFeed(key: string, entries: Entry[], ranked: number, lanes: FeedLane[]): void {
  const cache = store();
  // Bounded so a crawler walking every tag cannot grow this without limit.
  // Map preserves insertion order, so the oldest key is the first one.
  if (cache.size >= TOPIC_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { entries, ranked, lanes, at: Date.now() });
}

/** The cached feed for `key` if it is still fresh, else null. */
export function peekTopicFeed(key: string, now: number = Date.now()): TopicFeedEntry | null {
  const hit = store().get(key);
  if (!hit) return null;
  if (now - hit.at >= TOPIC_CACHE_MS) return null;
  return hit;
}

export function forgetTopicFeed(key: string): void {
  store().delete(key);
}

/** Visible for tests. */
export function resetTopicFeedCache(): void {
  store().clear();
}

/*
 * Body trimming and lane attachment, moved here from the route so the page seed
 * and the API answer are shaped by the SAME code. The comments that explain
 * them stayed with their first home; this is the mechanism only.
 */
export const FEED_BODY_CHARS = 4000;
export const BODY_IMAGE_PATTERNS = [
  /!\[[^\]]*\]\([^)\s]+\)/,
  /<img\s+[^>]*src="[^"]+"[^>]*>/i,
  /https?:\/\/\S+\.(?:png|jpe?g|webp|gif)/i
];

export function trimFeedBody(body: string): string {
  if (body.length <= FEED_BODY_CHARS) return body;
  const head = body.slice(0, FEED_BODY_CHARS);
  const rescued: string[] = [];
  for (const pattern of BODY_IMAGE_PATTERNS) {
    if (pattern.test(head)) continue;
    const found = body.match(pattern);
    if (found) rescued.push(found[0]);
  }
  return rescued.length > 0 ? `${head}\n\n${rescued.join('\n')}` : head;
}

export type RankedEntry = Entry & {
  _rank?: { lane: string | null; score: number; rank: number; engagers: number | null };
};

export function attachLanes(entries: Entry[], lanes?: FeedLane[] | null): Entry[] {
  if (!lanes || lanes.length === 0) return entries;
  const byKey = new Map(lanes.map((lane) => [lane.key, lane]));
  return entries.map((entry) => {
    const lane = byKey.get(`${entry.author}/${entry.permlink}`);
    if (!lane) return entry;
    const withRank: RankedEntry = {
      ...entry,
      _rank: { lane: lane.source, score: lane.score, rank: lane.rank, engagers: lane.engagers }
    };
    return withRank;
  });
}

export function cursorOf(entries: Entry[]): { author: string; permlink: string } | null {
  const last = entries[entries.length - 1];
  if (!last) return null;
  return { author: last._lite?.chainAuthor || last.author, permlink: last.permlink };
}

/**
 * ★★ THE ANONYMOUS TOPIC FEED IS THE FALLBACK, BY DESIGN. For a signed-out
 * reader the route never asks the ranker ("no signed-in viewer to rank for");
 * it serves the newest posts of the tag from the chain and memoises them for
 * a minute (`fallbackCache` in the route, keyed `created|<tag>|<observer>`,
 * served stale while refreshing). That memo, not the ranked cache above, is
 * what an anonymous page must seed from, and it is the SAME memo, shared the
 * same way (process-wide slot; see the note at the top of this file).
 */
export interface FallbackFeedEntry {
  entries: Entry[];
  at: number;
}

const FALLBACK_SLOT = '__lumenFallbackFeedCache';
export function fallbackMemo(): Map<string, FallbackFeedEntry> {
  const g = globalThis as unknown as Record<string, Map<string, FallbackFeedEntry> | undefined>;
  if (!g[FALLBACK_SLOT]) g[FALLBACK_SLOT] = new Map<string, FallbackFeedEntry>();
  return g[FALLBACK_SLOT] as Map<string, FallbackFeedEntry>;
}

export function fallbackKeyFor(sort: 'created' | 'trending', tag: string, observer: string): string {
  return `${sort}|${tag}|${observer}`;
}

/**
 * The page seed for an ANONYMOUS reader: exactly what the route answers a
 * signed-out `?tag=<topic>` from its fallback memo (`entries`, `source`,
 * `degraded`, `nextCursor`), votes stripped and bodies trimmed as the route
 * does for a signed-out viewer, cut to one page. A memo past its minute is
 * still used (the route serves it too, while refreshing) up to SEED_MAX_AGE_MS;
 * TopicShell refreshes any seed older than a minute once at mount. Signed-in
 * readers are never seeded from here (their answer carries their block list
 * and votes, which only the route applies).
 */
/** A memo older than this is not worth seeding: the client fetches instead. */
export const SEED_MAX_AGE_MS = 10 * 60_000;

export function anonymousTopicSeed(topic: string, limit = 30, observer = 'hive.blog', now: number = Date.now()) {
  const memoStore = fallbackMemo();
  const key = fallbackKeyFor('created', topic, observer);
  const memo = memoStore.get(key);
  if (!memo || memo.entries.length === 0) return null;
  if (now - memo.at > SEED_MAX_AGE_MS) return null;
  // Being served counts as recently used (the route's `touchFallback` does the
  // same), or the hottest topics would sit at the head of the LRU and be the
  // first evicted (found in review).
  memoStore.delete(key);
  memoStore.set(key, memo);
  const sliced = memo.entries.slice(0, limit);
  const entries = sliced.map((entry) => ({ ...entry, active_votes: [], body: trimFeedBody(entry.body ?? '') }));
  return {
    page: { entries, source: 'trending-fallback', degraded: 'anonymous', nextCursor: cursorOf(sliced) },
    at: memo.at
  };
}
