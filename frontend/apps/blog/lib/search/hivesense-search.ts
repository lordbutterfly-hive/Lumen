import type { Entry } from '@hive/common-hiveio-packages/wax';
import { withoutBannedAuthors } from '@ui/config/lists/banned-authors';

/**
 * Server-side reads of the Hivesense REST API (the AI search extension that
 * exists ONLY on api.hive.blog; see `app/api/hivesense/route.ts` for the whole
 * history, including why the base is pinned rather than riding the main read
 * node). The proxy route talks to the same upstream for the browser; these
 * helpers exist for reads that happen INSIDE another route (`/api/search`'s
 * fallback, `/api/search/people`'s topic section), where going through our own
 * proxy would be a loopback self-fetch on the request path
 * (`feedback_no_self_fetch_in_render_path`).
 *
 * The base URL is duplicated from the proxy on purpose: Next forbids importing a
 * non-handler export from a route module, and a one-line env read is cheaper
 * than a third module both would import.
 *
 * ★ MEASURED BEFORE BEING GIVEN THIS ROLE (2026-09-05, api.hive.blog):
 * `posts/search` 2.6s to 13.5s per query and no better ranked than `find_text`
 * (0.1s to 1.6s) for keyword queries, so it is a FALLBACK for posts, not the
 * primary; `authors/search` 1.8s to 2.7s for 5 to 8 names, useful as a second,
 * separately fetched section of the People tab.
 */
function hivesenseBase(): string {
  return (process.env.REACT_APP_HIVESENSE_ENDPOINT ?? 'https://api.hive.blog').replace(/\/+$/, '');
}

const POSTS_TIMEOUT_MS = 10_000;
const AUTHORS_TIMEOUT_MS = 6_000;

/** Upstream's own bound (`result_limit` max 1000, but by-ids hydration caps at 50; one page is 20 to 50). */
const MAX_POSTS = 50;
const MAX_AUTHORS = 20;

/**
 * 50 full posts with bodies and votes measured ~75KB (`by-ids`, 20 posts);
 * 4MB is forty times that. Past it the upstream is not answering our question,
 * and a body this route would have to parse and hold is the one thing a
 * misbehaving upstream could make expensive for us.
 */
const MAX_BODY_BYTES = 4_000_000;

async function readJson(url: URL, timeoutMs: number, label: string): Promise<unknown> {
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new Error(`${label}: upstream body too large (${declared} bytes)`);
  }
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) throw new Error(`${label}: upstream body too large (${text.length} chars)`);
  if (!res.ok) throw new Error(`${label}: upstream HTTP ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: upstream returned non-JSON`);
  }
}

function isFullPost(value: unknown): value is Entry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { author?: unknown }).author === 'string' &&
    typeof (value as { permlink?: unknown }).permlink === 'string' &&
    'title' in value &&
    'body' in value
  );
}

/**
 * Semantic post search, full posts only. `result_limit === full_posts` so no
 * stubs come back: a stub would need a second `by-ids` round trip that the
 * caller (a fallback that already waited for one failure) cannot afford.
 */
export async function hivesenseSearchPosts(params: {
  q: string;
  limit: number;
  observer?: string;
}): Promise<Entry[]> {
  const limit = Math.max(1, Math.min(params.limit, MAX_POSTS));
  const url = new URL(`${hivesenseBase()}/hivesense-api/posts/search`);
  url.searchParams.set('q', params.q);
  url.searchParams.set('result_limit', String(limit));
  url.searchParams.set('full_posts', String(limit));
  url.searchParams.set('truncate', '0');
  if (params.observer) url.searchParams.set('observer', params.observer);
  const body = await readJson(url, POSTS_TIMEOUT_MS, 'hivesense posts/search');
  if (!Array.isArray(body)) throw new Error('hivesense posts/search: unexpected shape');
  // Sliced to what was asked BEFORE anything walks it: the upstream's own
  // `result_limit` is a request, not a promise.
  return withoutBannedAuthors(body.slice(0, limit).filter(isFullPost), (post) => post.author);
}

/** Accounts whose posts are thematically close to `topic`, in upstream order. */
export async function hivesenseAuthorsByTopic(topic: string, limit: number): Promise<string[]> {
  const bounded = Math.max(1, Math.min(limit, MAX_AUTHORS));
  const url = new URL(`${hivesenseBase()}/hivesense-api/authors/search`);
  url.searchParams.set('topic', topic);
  url.searchParams.set('result_limit', String(bounded));
  const body = await readJson(url, AUTHORS_TIMEOUT_MS, 'hivesense authors/search');
  if (!Array.isArray(body)) throw new Error('hivesense authors/search: unexpected shape');
  return body.slice(0, bounded).filter((name): name is string => typeof name === 'string' && name.length > 0);
}
