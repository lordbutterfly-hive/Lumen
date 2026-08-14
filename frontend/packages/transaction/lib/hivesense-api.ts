import { logger } from '@ui/lib/logger';
import { Entry, MixedPostsResponse, PostStub } from '@hive/common-hiveio-packages/wax';
import { isBannedAuthor, withoutBannedAuthors } from '@ui/config/lists/banned-authors';

const logStandarizedError = (methodName: string, error: unknown): null => {
  logger.error(error, `Error in ${methodName}`);
  throw new Error(`Error in ${methodName}`);
};

/**
 * ★ ROUTED THROUGH A SAME-ORIGIN PROXY, NOT `chain.restApi['hivesense-api']`
 * DIRECTLY (2026-08-11). This file used to call the wax REST client straight
 * from the browser. Verified live: `GET {node}/hivesense-api` (no trailing
 * slash — the literal URL wax's client builds for the status probe below)
 * 404s with NO `Access-Control-Allow-Origin` header at all, which the browser
 * reports as a CORS failure, not a 404 — `getHiveSenseStatus()` swallows that
 * (see its own doc) so nothing crashed, but the probe was PERMANENTLY `false`
 * in every browser even though the service is actually up, which silently
 * killed "similar posts" downstream (gated on `hiveSenseAvailable === true`
 * in content.tsx). The sibling sub-routes (`posts/.../similar`,
 * `posts/by-ids`) DO send permissive CORS headers today, but that's a detail
 * of whatever sits in front of the upstream, not a contract — same reasoning
 * that moved creator-tokens/prediction-market off direct browser calls.
 * Server-to-server has no CORS at all, so the proxy (`apps/blog/app/api/hivesense/route.ts`)
 * sidesteps the question entirely, and also happens to fix the trailing-slash
 * 404 (it requests the URL that actually resolves).
 *
 * Only exists to be called from a browser today (the sole live caller,
 * content.tsx, is `'use client'`) — the relative path below assumes a
 * same-origin fetch. If a server-side caller is ever added it will need an
 * absolute URL instead.
 */
const HIVESENSE_PROXY_PATH = '/api/hivesense';

type HivesenseOperation = 'status' | 'search' | 'similar' | 'byIds';

async function callHivesense<T>(operation: HivesenseOperation, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(HIVESENSE_PROXY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, params }),
    cache: 'no-store'
  });
  return readHivesenseResponse<T>(res);
}

/**
 * ★ THE STATUS PROBE GOES OVER GET (2026-08-13, browser audit §2.3).
 *
 * Every other operation here is a POST because it carries a body the proxy has
 * to validate. `status` carries nothing at all — it asks "does this node offer
 * hivesense", whose answer is the same for every reader and changes only when a
 * node is reconfigured. Sending it as a POST made it uncacheable by definition,
 * so every hard page load of every post page paid a round trip (measured 28-153ms
 * even on a warm server memo, plus a rate-limiter row write) for an answer the
 * browser could have kept. The proxy answers this one operation on GET with
 * `public, max-age=300`, so from the second page load onward there is no request.
 *
 * No `cache: 'no-store'` here, deliberately — that flag is exactly what would
 * throw the win away.
 */
async function getHivesenseStatusOverGet<T>(): Promise<T> {
  const res = await fetch(`${HIVESENSE_PROXY_PATH}?operation=status`);
  return readHivesenseResponse<T>(res);
}

async function readHivesenseResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Hivesense proxy returned non-JSON (status ${res.status})`);
    }
  }
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `Hivesense proxy error (status ${res.status})`;
    throw new Error(message);
  }
  return data as T;
}

/**
 * Is AI ("Hivesense") search available on the configured node?
 *
 * ★ ANSWERS THE QUESTION. DOES NOT THROW IT BACK.
 *
 * This is an availability probe, and "unavailable" is a perfectly good answer —
 * it is the whole point of asking. It used to rethrow, which meant that on any
 * node without the hivesense extension EVERY visit to /search fired the
 * failing request three times over — React Query retries a rejection. Measured
 * 2026-08-06 on the production build. The page behaved correctly throughout,
 * which is exactly why nobody chased it; it just looked broken to anyone who
 * opened dev tools.
 *
 * Kept at `debug`: on a node that simply lacks the extension this is expected,
 * not an error, and logging it as one buries real failures.
 */
export const getHiveSenseStatus = async (): Promise<boolean> => {
  try {
    const response = await getHivesenseStatusOverGet<{ info: { title: string } }>();
    return response?.info?.title === 'Hivesense';
  } catch (error) {
    logger.debug(error, 'hivesense-api not available on this node — AI search stays off');
    return false;
  }
};

// New API functions using the updated endpoints

export const searchPosts = async ({
  query,
  truncate = 100,
  result_limit = 100,
  full_posts = 10,
  observer
}: {
  query: string;
  truncate?: number;
  result_limit?: number;
  full_posts?: number;
  observer: string;
}): Promise<MixedPostsResponse | null> => {
  try {
    const response = await callHivesense<MixedPostsResponse>('search', {
      q: query,
      truncate,
      result_limit,
      full_posts,
      observer
    });
    // AI search is a SEPARATE upstream from `search-api.find_text`, so the ban
    // applied there does not reach it. `/search?ai=…` is a real, linked surface —
    // it needs its own application of the same predicate.
    return withoutBannedAuthors(response, (post) => (post as { author?: string })?.author);
  } catch (error) {
    return logStandarizedError('searchPosts', error);
  }
};

export const getSimilarPostsByPost = async ({
  author,
  permlink,
  truncate = 100,
  result_limit = 100,
  full_posts = 10,
  observer
}: {
  author: string;
  permlink: string;
  truncate?: number;
  result_limit?: number;
  full_posts?: number;
  observer: string;
}): Promise<MixedPostsResponse | null> => {
  try {
    if (isBannedAuthor(author)) return [];
    const response = await callHivesense<Entry[]>('similar', {
      author,
      permlink,
      truncate,
      result_limit,
      full_posts,
      observer
    });
    // "More like this" is a recommendation rail — precisely a place a banned
    // author must not be surfaced from someone else's post.
    return withoutBannedAuthors(response, (post) => (post as { author?: string })?.author);
  } catch (error) {
    return logStandarizedError('getSimilarPostsByPost', error);
  }
};

export const getPostsByIds = async ({
  posts,
  truncate = 100,
  observer
}: {
  posts: Array<{ author: string; permlink: string }>;
  truncate?: number;
  observer: string;
}): Promise<Entry[] | null> => {
  try {
    const response = await callHivesense<Entry[]>('byIds', {
      posts,
      truncate,
      observer
    });

    if (Array.isArray(response)) {
      // ★ WAS `post.post_id` truthiness — WRONG. `post_id` is typed as a
      // required `number` on `Entry` (extended-hive.chain.ts) but the real
      // Hivesense REST response never sends it: verified live 2026-08-11
      // against `posts/by-ids` and `posts/.../similar` on api.hive.blog,
      // `post_id` absent from every entry in every response checked (23
      // entries across 3 different posts / 2 endpoints). That truthiness
      // check silently dropped 100% of real results. `isPostStub` below
      // already does the real stub check (does the entry actually carry
      // `title`/`body`, i.e. is it a full post rather than an
      // author/permlink-only stub) — reuse that instead of a field the
      // upstream doesn't send.
      return withoutBannedAuthors(
        response.filter((post): post is Entry => Boolean(post) && !isPostStub(post as Entry | PostStub)),
        (post) => (post as Entry)?.author
      );
    }
    return response;
  } catch (error) {
    return logStandarizedError('getPostsByIds', error);
  }
};

// Helper function to check if a post is a stub (only has author/permlink)
export const isPostStub = (post: Entry | PostStub): post is PostStub => {
  return !('title' in post) && !('body' in post) && 'author' in post && 'permlink' in post;
};
