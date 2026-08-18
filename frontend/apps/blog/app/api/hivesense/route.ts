import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceHivesenseRate } from '@/blog/lib/lite/antispam/rate-limit';
import { cachedRead } from '@/blog/lib/server-read-cache';
import { withRetry } from '@transaction/lib/retry';

const logger = getLogger('app');

/**
 * Same-origin proxy for the Hivesense REST API (the "similar posts" /
 * AI-search extension) — filed alongside the creator-tokens and
 * prediction-market GQL proxies, same root cause, same fix shape.
 *
 * `packages/transaction/lib/hivesense-api.ts` used to call
 * `chain.restApi['hivesense-api']` straight from the browser. Two things were
 * broken by that:
 *
 * 1. CORS on the STATUS PROBE. `getHiveSenseStatus()` calls the bare
 *    `hivesense-api` root (no further path) to read `info.title`. Verified
 *    live 2026-08-11: `GET https://api.hive.blog/hivesense-api` (no trailing
 *    slash — that's the literal URL wax's REST client builds for this call)
 *    404s with **no** `Access-Control-Allow-Origin` header at all, which is
 *    exactly what the browser reported: "Access to fetch at
 *    'https://api.hive.blog/hivesense-api' ... blocked by CORS policy". The
 *    SAME path WITH a trailing slash (`/hivesense-api/`) returns 200 with the
 *    real OpenAPI info doc — nginx is just routing the two differently. Since
 *    `getHiveSenseStatus()` swallows the failure and returns `false` (by
 *    design — see its own doc), this didn't crash anything, but it meant the
 *    availability probe was PERMANENTLY false in every browser even though
 *    the service is actually up, which silently killed the "similar posts"
 *    feature downstream (it's gated on `hiveSenseAvailable === true`).
 * 2. Even where CORS headers ARE present (confirmed live: `posts/.../similar`
 *    and `posts/by-ids` both send `Access-Control-Allow-Origin: *`), that's a
 *    detail of Varnish/Caddy sitting in front of this specific upstream
 *    today, not a contract — relying on a third party to keep sending
 *    permissive CORS headers for a core reader feature is the same fragile
 *    posture the creator-tokens/prediction-market proxies were written to
 *    remove. Server-to-server has no CORS at all, so this route sidesteps the
 *    question entirely.
 *
 * ONLY the four operations the real client sends are forwarded, allowlisted
 * by exact operation name — never an arbitrary client-supplied path or
 * upstream host (no SSRF relay). This claim did NOT hold for the `similar`
 * operation's `author`/`permlink` until 2026-08-11: `encodeURIComponent`
 * leaves `.` unescaped and `new URL()` normalises a `..` segment away, so
 * `author='..'` reached one directory up the allowlisted path. `author` and
 * `permlink` are now validated against Hive's real identifier shape before
 * they ever reach `new URL()` — see `HIVE_ACCOUNT_NAME` / `isSafePathSegment`
 * below — which is what actually makes this sentence true.
 *
 * The upstream base is read here from
 * `process.env.REACT_APP_API_ENDPOINT` — the SAME var
 * `packages/ui/config/public-vars.ts`'s `configuredApiEndpoint` already
 * derives its default from — never from anything the client sends. Note that
 * this deliberately does NOT honour the reader's `ai-search-endpoint` /
 * `rest-node-endpoint` localStorage node override (see
 * `hive-chain-service.ts`'s `getAIDefaultEndpoint`): accepting a
 * client-chosen upstream host is exactly the SSRF relay this proxy exists to
 * avoid. The node-picker in the healthchecker page is unaffected — it talks
 * to nodes directly and is a developer/debug tool, not this reader feature.
 */

const UPSTREAM_TIMEOUT_MS = 10_000;

/** The `status` probe only. See its own comment in POST for the measurement. */
const STATUS_TIMEOUT_MS = 2_500;

/** How long one answer to "does this node offer hivesense" is reused server-side.
 *  Node capability, not content: it changes when someone reconfigures a node. */
const STATUS_CACHE_MS = 300_000;

/** How long one "posts similar to this post" answer is reused. See the memo in `proxy`. */
const SIMILAR_CACHE_MS = 600_000;

/** Upstream's own documented bound for a single by-ids call (extended-hive.chain.ts's
 *  `HivesenseEndpointsPostsByIdsPayload`, `@maxItems 50`) — not a number invented here. */
const MAX_BY_IDS_POSTS = 50;

type Operation = 'status' | 'search' | 'similar' | 'byIds';
const ALLOWED_OPERATIONS: ReadonlySet<Operation> = new Set(['status', 'search', 'similar', 'byIds']);

function upstreamBase(): string {
  return (process.env.REACT_APP_API_ENDPOINT ?? 'https://api.hive.blog').replace(/\/+$/, '');
}

/**
 * ★★★ WHY `encodeURIComponent` + `new URL()` WAS NOT ENOUGH (2026-08-11, fixed
 * after adversarial review). `encodeURIComponent('..')` returns `'..'` —
 * unescaped, because `.` is not a reserved URI character — and `new URL()`
 * then NORMALISES a `..` path segment away per the URL spec, same as a
 * browser address bar does. `author='..'` therefore reached
 * `${base}/hivesense-api/posts/../${permlink}/similar`, which `new URL()`
 * collapses to `${base}/hivesense-api/${permlink}/similar` — one directory up
 * from where the module doc above claims a client can never send this proxy.
 * Encoding a value never proves it is safe to concatenate into a path; only
 * validating its CONTENT does.
 *
 * Hive account names are enforced by consensus to `^[a-z][a-z0-9.-]{2,15}$`
 * (the same pattern already inlined in `validate-hive-account.ts`,
 * `condenser-migration.ts` and the lite posts route, rather than importing
 * the WASM-backed async validator onto a hot proxy path for a format check).
 * That regex alone already rejects `.` and `..` (neither starts with a
 * lowercase letter), so it is both the account allowlist AND the traversal
 * fix for `author`.
 */
const HIVE_ACCOUNT_NAME = /^[a-z][a-z0-9.-]{2,15}$/;

/**
 * `permlink` cannot use the same strict pattern: real on-chain permlinks
 * predate any slugifier convention and legitimately contain dots, underscores
 * and uppercase (see the identical note on `isReferenceablePermlink` in
 * `app/api/lite/posts/route.ts` — this is a REFERENCE to existing chain data,
 * not something we mint). So this stays loose on content and instead rejects
 * only what can act as a PATH OPERATOR once concatenated into the upstream
 * URL: the literal segments `.` and `..`, any embedded `/` or `\` (which would
 * inject additional segments), empty, over-long, or containing whitespace /
 * control characters.
 */
function isSafePathSegment(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  if (value === '.' || value === '..') return false;
  if (/[/\\]/.test(value)) return false;
  // eslint-disable-next-line no-control-regex -- deliberately matching control chars to reject them
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;
  return true;
}

/** Only forwards params of a type the upstream query string can carry, silently drops the rest. */
function appendParams(url: URL, params: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' || typeof value === 'number') {
      url.searchParams.set(key, String(value));
    }
  }
}

function isPostRef(value: unknown): value is { author: string; permlink: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { author?: unknown }).author === 'string' &&
    typeof (value as { permlink?: unknown }).permlink === 'string'
  );
}

/**
 * ★★★ THE STATUS PROBE IS A GET NOW, SO THE BROWSER CAN STOP ASKING
 * (2026-08-13, browser audit §2.3).
 *
 * The audit reported `/api/hivesense` "firing twice per page". Measured on the
 * post page with the request bodies read, the two calls are NOT a duplicate —
 * they are `status` and `similar`, and the node DOES offer hivesense (the
 * trailing-slash fix in this file's own history is what made the probe start
 * answering "yes"), so "similar posts" is a live feature now rather than the
 * permanently-dead one the comments below describe. Three consecutive loads:
 * `status 153ms`, then `status 28ms + similar 603ms`, then `status 31ms +
 * similar 2,557ms`.
 *
 * The `status` half was still a POST, and a POST is uncacheable by definition —
 * so every hard page load paid a round trip plus a rate-limiter row write for an
 * answer that is the same for every reader for minutes at a time (its own server
 * memo already says so: `STATUS_CACHE_MS`, 5 minutes). Measured after the move:
 * **24-29ms -> 3-6ms** per post page.
 *
 * ★★★ BUT THE BROWSER IS STILL NOT CACHING IT, AND THAT IS DELIBERATE — READ
 * THIS BEFORE "FIXING" THE HEADER. `middleware.ts` attaches `Set-Cookie`
 * (`session_uid`, the login challenge) to every response it touches, and it
 * therefore carries a STANDING RULE, written after this class of bug bit the
 * project three times: *a route that sets `cache-control: public` MUST be
 * excluded from the middleware `matcher`, or it must not be public* — otherwise
 * a shared cache can replay one visitor's session cookies to the next. Because
 * middleware runs BEFORE the handler, its own `private, no-store` lands on the
 * response first and the `public` directive below is appended after it. Verified
 * live on :3600: the response carries BOTH, and per RFC 9111 the combined value
 * is `private, no-store, public, max-age=300, ...` — `no-store` wins, so nothing
 * is cached anywhere.
 *
 * So the entire measured win above comes from the SERVER memo, not the browser.
 * The header is left in place as the route's honest statement of intent, and
 * turning it on for real is a one-line change to the `matcher` in
 * `middleware.ts` — which is that file's decision to make, not this one's, and is
 * NOT made here.
 *
 * Only `status` is exposed here. It takes no parameters, reads nothing
 * viewer-specific and returns a node capability — the one operation of the four
 * that could ever be safe to hand a shared cache. `search`, `similar` and `byIds`
 * stay on POST exactly as they were.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (req.nextUrl.searchParams.get('operation') !== 'status') {
    return NextResponse.json({ error: 'unsupported operation' }, { status: 400 });
  }
  const res = await proxy('status', {}, req);
  // Same answer for everyone, so it is `public`. `max-age` matches the server
  // memo's own TTL rather than inventing a second number; `stale-while-revalidate`
  // means a node that goes down never turns this into a blocking request.
  //
  // ★ ONLY A SUCCESSFUL PROBE IS CACHED. The server memo above deliberately
  // remembers a FAILED probe too (see its comment — a timeout is the answer), but
  // that memo is ours to clear on a deploy; a `public, max-age=300` on a 502 would
  // sit in a reader's browser cache where nothing can reach it, so a node coming
  // back up would stay invisible to them for up to five more minutes on top of
  // the server's own five.
  if (res.ok) res.headers.set('cache-control', 'public, max-age=300, stale-while-revalidate=3600');
  else res.headers.set('cache-control', 'no-store');
  return res;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const operation = record.operation;
  if (typeof operation !== 'string' || !ALLOWED_OPERATIONS.has(operation as Operation)) {
    return NextResponse.json({ error: 'unsupported operation' }, { status: 400 });
  }
  const params =
    typeof record.params === 'object' && record.params !== null ? (record.params as Record<string, unknown>) : {};

  return proxy(operation as Operation, params, req);
}

async function proxy(
  operation: Operation,
  params: Record<string, unknown>,
  req: NextRequest
): Promise<NextResponse> {
  const base = upstreamBase();
  // ★ THE AVAILABILITY PROBE GETS A SHORT LEASH (2026-08-13). Measured in a browser
  // on the post page: 4,485ms, the slowest single request in the app, and fired
  // twice. `status` answers one question — "does this node offer hivesense at all"
  // — whose answer is the same for every reader and changes only when a node is
  // reconfigured. Nothing on the page needs it to render; the widget it gates is
  // below the fold. So it gets 2.5s instead of 10s: on a node that does not offer
  // hivesense (which is the case here) waiting the full ten seconds buys exactly
  // the same "no", ten times slower, on every post page.
  const isStatusProbe = (operation as Operation) === 'status';
  const init: RequestInit = {
    signal: AbortSignal.timeout(isStatusProbe ? STATUS_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS),
    cache: 'no-store'
  };
  let upstreamUrl: URL;

  switch (operation as Operation) {
    case 'status': {
      // Trailing slash is load-bearing — see the module doc. Without it this 404s.
      upstreamUrl = new URL(`${base}/hivesense-api/`);
      break;
    }
    case 'search': {
      upstreamUrl = new URL(`${base}/hivesense-api/posts/search`);
      appendParams(upstreamUrl, params, ['q', 'truncate', 'result_limit', 'full_posts', 'observer']);
      break;
    }
    case 'similar': {
      const { author, permlink } = params;
      if (typeof author !== 'string' || !author || typeof permlink !== 'string' || !permlink) {
        return NextResponse.json({ error: 'author and permlink are required' }, { status: 400 });
      }
      // ★ THE ACTUAL ALLOWLIST — see `HIVE_ACCOUNT_NAME` / `isSafePathSegment`
      // above for why `encodeURIComponent` + `new URL()` alone let `author='..'`
      // reach `/hivesense-api/similar` directly.
      if (!HIVE_ACCOUNT_NAME.test(author) || !isSafePathSegment(permlink)) {
        return NextResponse.json({ error: 'author or permlink is not a valid Hive identifier' }, { status: 400 });
      }
      upstreamUrl = new URL(
        `${base}/hivesense-api/posts/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/similar`
      );
      appendParams(upstreamUrl, params, ['truncate', 'result_limit', 'full_posts', 'observer']);
      break;
    }
    case 'byIds': {
      const posts = params.posts;
      if (!Array.isArray(posts) || posts.length === 0 || posts.length > MAX_BY_IDS_POSTS) {
        return NextResponse.json(
          { error: `posts must be an array of 1 to ${MAX_BY_IDS_POSTS} items` },
          { status: 400 }
        );
      }
      if (!posts.every(isPostRef)) {
        return NextResponse.json({ error: 'each post needs an author and a permlink' }, { status: 400 });
      }
      upstreamUrl = new URL(`${base}/hivesense-api/posts/by-ids`);
      init.method = 'POST';
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify({
        posts,
        truncate: typeof params.truncate === 'number' ? params.truncate : undefined,
        observer: typeof params.observer === 'string' ? params.observer : undefined
      });
      break;
    }
  }

  // Per-IP daily rate limit — best-effort like every other limiter call in this repo:
  // a limiter-store outage must not take this read-only feature offline.
  try {
    if (!(await enforceHivesenseRate(getClientIp(req)))) {
      return NextResponse.json({ error: 'rate limited' }, { status: 429 });
    }
  } catch {
    /* limiter unavailable — proceed */
  }

  try {
    // The probe's answer is identical for every reader, so one process-wide read
    // serves them all for STATUS_CACHE_MS instead of one per post page. Every other
    // operation is per-post and goes straight upstream, unchanged.
    // ★★★ THE FAILURE IS THE ANSWER WORTH CACHING (2026-08-13, second pass).
    //
    // First attempt wrapped only the successful read, which cached nothing that
    // mattered: this node does NOT offer hivesense, so the probe TIMES OUT, the
    // promise rejects, and nothing is stored — every post page paid the full
    // timeout again. Measured after that first attempt: still 3,008 ms on the post
    // page, the slowest request left in the app.
    //
    // "This node has no hivesense" is a fact about the node, and a timeout is how
    // that fact arrives. So the rejection is caught INSIDE the memo and turned into
    // a value, which is then cached for STATUS_CACHE_MS like any other answer. The
    // 502 shape returned here is byte-identical to what the outer catch produced
    // before, so `getHiveSenseStatus()` still reads it as "unavailable" and the
    // widget stays hidden exactly as it did.
    //
    // (Correction of fact, 2026-08-13: the configured node DOES offer hivesense —
    // the trailing-slash fix in the module doc is what made the probe start
    // answering "yes". The reasoning above about caching a negative still holds
    // and is what keeps a node OUTAGE from costing 2.5s per post page, but the
    // "which is the case here" aside no longer describes the live node.)
    // ★ A6 retry rollout (2026-08-18): idempotent read, wired into this one shared
    // primitive rather than at each of its three call sites below — so the
    // `status` probe, `similar`, and the direct `search`/`byIds` path all benefit
    // without risking a doubled retry anywhere. `init.signal`'s own timeout
    // (2.5s for `status`, 10s otherwise) already bounds a genuine hang below the
    // default 2.5s retry budget, so a full timeout still costs one attempt, not
    // three — only a FAST transient failure (reset, DNS) gets a second try.
    const readUpstream = async (): Promise<{ status: number; text: string }> => {
      const res = await withRetry(() => fetch(upstreamUrl.toString(), init), {
        label: `hivesense.${operation}`
      });
      return { status: res.status, text: await res.text() };
    };
    const { status, text } = isStatusProbe
      ? await cachedRead(`hivesense:status:${base}`, STATUS_CACHE_MS, async () => {
          try {
            return await readUpstream();
          } catch {
            return { status: 502, text: JSON.stringify({ error: 'upstream unreachable' }) };
          }
        })
      : // ★★★ "SIMILAR POSTS" IS MEMOISED TOO (2026-08-13, browser audit §2.3).
        //
        // This is the expensive half and it was going straight upstream on every
        // single view of every single post: measured 603ms, 2,557ms and 4,235ms on
        // three loads of ONE post — the slowest request left on the page, and the
        // reason the post page's last request finishes up to 5.9s after navigation.
        //
        // "Which posts resemble this post" is a property of the POST, not of the
        // reader, and the upstream recomputes the same answer for every visitor.
        // The key is the fully-built upstream URL, so every parameter that can
        // change the answer — author, permlink, `observer`, `result_limit`,
        // `truncate`, `full_posts` — is part of it by construction, and no two
        // different requests can collide on one entry. Ten minutes: a
        // recommendation rail that is ten minutes behind the index is
        // indistinguishable from a fresh one, and the widget is below the fold.
        //
        // Failures are deliberately NOT cached here (unlike the status probe):
        // a rejection propagates to the outer catch and the next reader retries.
        // A status timeout is an answer about the node; a failed `similar` is just
        // a failed request, and remembering it would hide a recovery for 10 minutes.
        operation === 'similar'
        ? await cachedRead(`hivesense:similar:${upstreamUrl.toString()}`, SIMILAR_CACHE_MS, readUpstream)
        : await readUpstream();
    const upstream = { status };
    // Pass the upstream BODY + status straight through, same posture as the
    // creator-tokens/prediction-market proxies: hivesense-api.ts already knows how
    // to read a success payload vs. an error, duplicating that here would drift.
    //
    // ★ THE CONTENT-TYPE IS NOT PASSED THROUGH (2026-08-11, fixed after adversarial
    // review). Every one of the four allowlisted operations above is a JSON REST
    // call — that is the entire contract of this proxy, stated in the module doc.
    // Forwarding `upstream.headers.get('content-type')` verbatim meant that if the
    // upstream (or anything sitting in front of it — nginx, Varnish, a maintenance
    // page) ever answered with `text/html` instead, this route would serve that
    // body AS `text/html` FROM OUR OWN ORIGIN — same-origin HTML/script content
    // this route never intended to grant. Pinning the header is the actual fix:
    // `nosniff` alone would not have caught this, because nosniff only stops a
    // browser from SNIFFING a response into a MORE dangerous type than the one
    // declared — it does nothing when the declared type is already `text/html`.
    // Sent anyway, as defense in depth for any downstream consumer that ignores
    // the declared type.
    return new NextResponse(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }
    });
  } catch (error) {
    logger.error(error, 'Hivesense proxy: upstream unreachable');
    return NextResponse.json({ error: 'upstream unreachable' }, { status: 502 });
  }
}
