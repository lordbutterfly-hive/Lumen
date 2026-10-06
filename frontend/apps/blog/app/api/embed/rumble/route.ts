import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { cachedRead } from '@/blog/lib/server-read-cache';
import { embedIdFromOembed, parseRumblePage, rumbleOembedUrl } from '@/blog/lib/post/rumble-embed';

const logger = getLogger('app');

const UPSTREAM_TIMEOUT_MS = 6_000;

/** A page's player id never changes, so a day in this process keeps Rumble out of every
 *  repeat view. A removed video (no id) is asked again after the same day. */
const CACHE_MS = 24 * 60 * 60 * 1000;

/**
 * Cap on calls to Rumble per minute, per process. Every cache MISS costs one call, and
 * the page id comes from the request, so without a cap anyone could walk random ids
 * through this route and get our server's IP rate-limited or blocked by Rumble for
 * every reader. Real traffic is a few lookups per post view at most.
 */
const MAX_UPSTREAM_PER_MINUTE = 30;
let windowStart = 0;
let windowCount = 0;
function takeUpstreamSlot(): boolean {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  windowCount++;
  return windowCount <= MAX_UPSTREAM_PER_MINUTE;
}

/**
 * ★ The deadline covers the BODY read too, not just the headers, and asks for an
 * uncompressed answer. A fetch whose timeout fires mid-decompression can leave the body
 * read hanging forever on Node 20 and 22 (the Meritum lookup wedge, 2026-09-25), so the
 * whole read races our own timer, whose abort also ends the wait.
 */
async function lookupEmbedId(url: string): Promise<string | null> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error('rumble oembed timed out'));
    }, UPSTREAM_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      (async () => {
        const res = await fetch(url, {
          signal: ac.signal,
          cache: 'no-store',
          headers: { accept: 'application/json', 'accept-encoding': 'identity' }
        });
        // An unknown or removed video is an answer (no player), not a failure.
        if (res.status === 404 || res.status === 410) return null;
        if (!res.ok) throw new Error(`rumble oembed answered ${res.status}`);
        return embedIdFromOembed(await res.json());
      })(),
      deadline
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/embed/rumble?page=<pageId>-<title> -> { embedId: string | null }
 *
 * Maps a Rumble page link to its player id (see lib/post/rumble-embed.ts for why that
 * needs a lookup). The answer is the same for every reader and reads no cookie, so it is
 * served `public` and this route is excluded from the cookie-minting middleware
 * (middleware.ts matcher, the standing rule written there).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const page = parseRumblePage(request.nextUrl.searchParams.get('page'));
  if (!page) {
    return NextResponse.json({ error: 'bad_page' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }
  try {
    const embedId = await cachedRead(`rumble-embed:${page.pageId}`, CACHE_MS, async () => {
      if (!takeUpstreamSlot()) throw new Error('rumble lookup budget spent for this minute');
      return lookupEmbedId(rumbleOembedUrl(page));
    });
    return NextResponse.json(
      { embedId },
      { headers: { 'cache-control': embedId ? 'public, max-age=86400, s-maxage=604800' : 'public, max-age=3600' } }
    );
  } catch (error) {
    // The post keeps its "Watch on Rumble" link, which is what it showed before.
    logger.warn(error, 'rumble embed lookup failed for %s', page.pageId);
    return NextResponse.json({ error: 'rumble_unavailable' }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}
