import { getPostsRanked } from '@transaction/lib/bridge-api';
import { getLogger } from '@ui/lib/logging';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { mergeLumenEngagement } from '@/blog/lib/lite/repositories/engagement-repository';
import { filterBannedEntries } from '@/blog/lib/moderation/banned-authors';
import { filterBlockedForViewer, viewerBlockedKeySet } from '@/blog/lib/lite/social/block-filter';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { readViewerFeed, feedBands, feedVersion } from '@/blog/lib/feed/feed-cache';
import { DEFAULT_OBSERVER } from '@/blog/lib/utils';
import type { InitialFeedSeed, InitialFeedPage } from '@/blog/components/observer-provider';

const logger = getLogger('app');

const PREFETCH_LIMIT = 20;
const PREFETCH_TIMEOUT_MS = 3_000;
const FEED_BODY_CHARS = 4000;
const BODY_IMAGE_PATTERNS = [
  /!\[[^\]]*\]\([^)\s]+\)/,
  /<img\s+[^>]*src="[^"]+"[^>]*>/i,
  /https?:\/\/\S+\.(?:png|jpe?g|webp|gif)/i
];

function trimBody(body: string): string {
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

function cursorOf(entries: Entry[]): { author: string; permlink: string } | null {
  const last = entries[entries.length - 1];
  if (!last) return null;
  return { author: last._lite?.chainAuthor || last.author, permlink: last.permlink };
}

function trimForSSR(entries: Entry[]): Entry[] {
  return entries.map((entry) => ({
    ...entry,
    active_votes: [],
    body: trimBody(entry.body ?? '')
  }));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void promise.catch(() => undefined);
  }
}

async function prefetchTrending(): Promise<Entry[] | null> {
  const posts = await getPostsRanked('trending', '', '', '', DEFAULT_OBSERVER, PREFETCH_LIMIT);
  if (!posts || posts.length === 0) return null;
  const merged = await mergeLumenEngagement(posts);
  return trimForSSR(filterBannedEntries(merged));
}

async function prefetchStoredFeed(viewer: string): Promise<InitialFeedSeed | null> {
  const stored = await readViewerFeed(viewer);
  if (!stored || stored.entries.length === 0) return null;
  // The API route refuses to serve a stored feed past the abandon ceiling
  // (it falls back to trending + starts a rebuild). The SSR seed must do the
  // same, or a stale feed would be served as initialData with staleTime:
  // Infinity and the client would never discover the staleness.
  const age = Date.now() - stored.at;
  if (age >= feedBands().abandonMs) return null;
  // A version mismatch means the ranking WEIGHTS changed; the content is stale
  // even though the timestamp looks recent.
  if (stored.version !== feedVersion()) return null;
  let entries = filterBannedEntries(stored.entries);
  // Apply the viewer's block list server-side so blocked authors never appear
  // in the SSR HTML. Degrades open on failure, same as the API route.
  try {
    const session = await getLiteSession();
    const blockedKeys = await viewerBlockedKeySet(session.user).catch(() => new Set<string>());
    if (blockedKeys.size > 0) {
      entries = await filterBlockedForViewer(entries, blockedKeys);
    }
  } catch {
    // Block list unavailable: serve unfiltered, same as the API route's own catch.
  }
  if (entries.length === 0) return null;
  const page: InitialFeedPage = {
    entries: trimForSSR(entries),
    source: 'recsys',
    personalised: true,
    nextCursor: cursorOf(entries)
  };
  return { page, at: stored.at };
}

/**
 * Prefetch the home feed for SSR. Returns null on any failure -- the client
 * falls back to its own fetch, identical to today's behavior.
 *
 * Anonymous: trending posts from the Hive node, same as the API route's fallback.
 * Signed-in: the viewer's stored ranking from Postgres/memory, if one exists.
 */
export async function prefetchHomeFeed(viewer: string): Promise<InitialFeedSeed | null> {
  try {
    if (viewer) {
      return await withTimeout(prefetchStoredFeed(viewer), PREFETCH_TIMEOUT_MS);
    }
    const entries = await withTimeout(prefetchTrending(), PREFETCH_TIMEOUT_MS);
    if (!entries || entries.length === 0) return null;
    const page: InitialFeedPage = {
      entries,
      source: 'trending-fallback',
      degraded: 'anonymous',
      personalised: false,
      nextCursor:
        entries.length > 0
          ? { author: entries[entries.length - 1].author, permlink: entries[entries.length - 1].permlink }
          : null
    };
    return { page, at: Date.now() };
  } catch (error) {
    logger.warn('feed-prefetch: SSR prefetch failed, client will fetch: %o', error);
    return null;
  }
}
