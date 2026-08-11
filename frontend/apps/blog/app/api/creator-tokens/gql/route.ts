import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { STATE_QUERY, STATE_QUERY_HEX, HEAD_QUERY } from '@/blog/features/creator-tokens/lib/vsc/reads';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceMagiGqlRate } from '@/blog/lib/lite/antispam/rate-limit';

const logger = getLogger('app');

/**
 * Same-origin proxy for the Magi (VSC) GraphQL endpoint the creator-tokens
 * feature reads from — job J5, owner-reported 2026-08-11: the header pill
 * never showed the "Launch your token" CTA it demonstrably has, because this
 * read never resolved.
 *
 * See `reads.ts`'s own doc on `postGql` for the full story: the browser used
 * to `fetch()` REACT_APP_CREATOR_TOKENS_GQL_URL (magi-test.techcoderx.com)
 * directly. CSP already allows that origin (packages/middleware/lib/csp.ts,
 * 2026-08-06) — CSP was never the blocker. The node itself sends no
 * Access-Control-Allow-Origin header, so every browser refused the request at
 * the CORS PREFLIGHT before CSP was ever consulted. A browser cannot
 * self-grant CORS permission the far server never sent, so the only real fix
 * is to stop making the browser hold the cross-origin connection at all.
 *
 * This route re-issues the SAME query server-to-server — no CORS applies
 * between two servers — against the upstream read here from
 * `process.env.REACT_APP_CREATOR_TOKENS_GQL_URL` directly. That var is ALSO
 * mirrored into the browser's `window.__ENV` by @beam-australia/react-env
 * (that mirroring is what let the browser dial the raw host directly before
 * this fix), but this route deliberately ignores anything a client might send
 * as an upstream target and only ever reads its own server env — accepting a
 * client-supplied URL would turn a read-only chain proxy into an open SSRF
 * relay.
 *
 * ONLY the three fixed queries the real client ever sends are forwarded,
 * allowlisted by exact string match against reads.ts's own exported query
 * constants (the single source of truth, so the two can never drift apart) —
 * never arbitrary client-supplied GraphQL. That keeps this endpoint from
 * becoming a blank-check relay into the rest of the Magi node's schema.
 *
 * ★ RATE-LIMITED + `keys`-BOUNDED (adversarial review, 2026-08-11). Confirmed
 * NOT an open relay (fixed upstream, exact-match allowlist) — but nothing
 * previously bounded how FAST a caller could drive this server into hitting
 * the Magi node, nor how large a `keys` array they could forward. Both are
 * closed the same way the rest of this repo closes them: `enforceMagiGqlRate`
 * is the SAME per-IP daily-counter helper every other public route in this repo
 * uses (see `lib/lite/antispam/rate-limit.ts`), and `MAX_STATE_KEYS` is the
 * upstream's OWN documented bound (`getStateByKeys` accepts 1..100 keys per
 * call — reads.ts's `readState` already cites this, schema.graphql:813) rather
 * than a number invented here — relying on the upstream to reject an oversized
 * `keys` array (as it does today) means our amplification is bounded only by
 * someone else's validation, which is the actual defect.
 */

const ALLOWED_QUERIES = new Set<string>([STATE_QUERY, STATE_QUERY_HEX, HEAD_QUERY]);

/** Bounds how long this server will hold a connection open for a wedged upstream node. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/** Mirrors getStateByKeys' own documented range (schema.graphql:813) — never our own guess. */
const MAX_STATE_KEYS = 100;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gqlUrl = process.env.REACT_APP_CREATOR_TOKENS_GQL_URL;
  if (!gqlUrl) {
    // Mirrors getCreatorTokensConfig()'s own "unprovisioned" posture — honest
    // unavailable, never a silent fake. In practice the client-side config
    // check already refuses to build a data source at all once this is unset,
    // so this only fires if the client and server envs ever drift apart.
    return NextResponse.json({ errors: [{ message: 'creator tokens GQL endpoint not configured' }] }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ errors: [{ message: 'invalid JSON body' }] }, { status: 400 });
  }

  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const query = record.query;
  const variables = record.variables;

  if (typeof query !== 'string' || !ALLOWED_QUERIES.has(query)) {
    return NextResponse.json({ errors: [{ message: 'unsupported query' }] }, { status: 400 });
  }

  const variablesObj = typeof variables === 'object' && variables !== null ? (variables as Record<string, unknown>) : {};
  // Only STATE_QUERY / STATE_QUERY_HEX carry `keys`; HEAD_QUERY sends none, so this
  // is skipped rather than forced, and cannot itself reject a legitimate HEAD_QUERY call.
  if ('keys' in variablesObj) {
    const keys = variablesObj.keys;
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_STATE_KEYS) {
      return NextResponse.json(
        { errors: [{ message: `keys must be an array of 1 to ${MAX_STATE_KEYS} items` }] },
        { status: 400 }
      );
    }
  }

  // Per-IP daily rate limit — see enforceMagiGqlRate's doc for sizing and why this
  // is its own bucket. Best-effort like every other limiter call in this repo: this
  // route works whether or not the lite-accounts Postgres backend is provisioned, so
  // a limiter-store outage must not take chain reads offline — only the limiter falls
  // open, not the allowlist or the upstream-config check above.
  try {
    if (!(await enforceMagiGqlRate(getClientIp(req), 'creator_tokens'))) {
      return NextResponse.json({ errors: [{ message: 'rate limited' }] }, { status: 429 });
    }
  } catch {
    /* limiter unavailable — proceed */
  }

  try {
    const upstream = await fetch(gqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: typeof variables === 'object' && variables !== null ? variables : {} }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      // ★ MEASURED LIVE (2026-08-11): without this, Next's Data Cache served a
      // SECOND identical-body request back in 0ms instead of re-querying the
      // node — confirmed by timing two back-to-back calls against the real
      // (currently 502'ing) upstream. This is chain state read for a live
      // price/position: a cached response is either a stale 502 that never
      // clears once the node recovers, or — worse, if Next's cache key ever
      // ignores the body — one creator's read served back for a DIFFERENT
      // creator's query against the same URL+method. Every call must hit the
      // real node fresh; the client's own react-query staleTime/refetchInterval
      // (use-token-price-chip.ts) is the only cache this data path may have.
      cache: 'no-store'
    });
    const text = await upstream.text();
    // Pass the upstream body + status straight through. The client's own
    // postGql (reads.ts) already knows how to read a GraphQL {data,errors}
    // envelope and treat a non-ok status as a failure — duplicating that
    // parsing here would be a second copy that could disagree with the first.
    return new NextResponse(text, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' }
    });
  } catch (error) {
    logger.error(error, 'Creator tokens GQL proxy: upstream unreachable');
    return NextResponse.json({ errors: [{ message: 'upstream unreachable' }] }, { status: 502 });
  }
}
