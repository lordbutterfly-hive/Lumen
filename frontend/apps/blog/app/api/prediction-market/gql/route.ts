import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { STATE_QUERY, HEAD_QUERY } from '@/blog/features/prediction-market/lib/vsc-gql';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceMagiGqlRate } from '@/blog/lib/lite/antispam/rate-limit';

const logger = getLogger('app');

/**
 * Same-origin proxy for the Magi (VSC) GraphQL endpoint the prediction-market
 * feature reads from — sibling fix to job J5's creator-tokens proxy
 * (app/api/creator-tokens/gql/route.ts), same bug, same design, applied here
 * before this feature is ever provisioned rather than after it breaks live.
 *
 * See `vsc-gql.ts`'s own doc on `postGql` for the full story: the browser
 * used to `fetch()` REACT_APP_VSC_MARKET_GQL_URL directly. CSP already
 * allows that origin when the var is set (packages/middleware/lib/csp.ts) —
 * CSP was never the blocker. The node itself sends no
 * Access-Control-Allow-Origin header, so every browser would be refused the
 * request at the CORS PREFLIGHT before CSP was ever consulted. A browser
 * cannot self-grant CORS permission the far server never sent, so the only
 * real fix is to stop making the browser hold the cross-origin connection at
 * all.
 *
 * This route re-issues the SAME query server-to-server — no CORS applies
 * between two servers — against the upstream read here from
 * `process.env.REACT_APP_VSC_MARKET_GQL_URL` directly. That var is ALSO
 * mirrored into the browser's `window.__ENV` by @beam-australia/react-env,
 * but this route deliberately ignores anything a client might send as an
 * upstream target and only ever reads its own server env — accepting a
 * client-supplied URL would turn a read-only chain proxy into an open SSRF
 * relay.
 *
 * ONLY the two fixed queries the real client ever sends are forwarded,
 * allowlisted by exact string match against vsc-gql.ts's own exported query
 * constants (the single source of truth, so the two can never drift apart) —
 * never arbitrary client-supplied GraphQL. That keeps this endpoint from
 * becoming a blank-check relay into the rest of the Magi node's schema.
 *
 * ★ RATE-LIMITED + `keys`-BOUNDED (adversarial review, 2026-08-11) — sibling
 * fix to the creator-tokens proxy (app/api/creator-tokens/gql/route.ts), same
 * finding, same fix. See that route's doc for the full reasoning:
 * `enforceMagiGqlRate` is the same per-IP daily-counter helper every other
 * public route in this repo uses, scoped to its own bucket so this route's
 * traffic can never starve (or be starved by) the creator-tokens proxy's; and
 * `MAX_STATE_KEYS` mirrors getStateByKeys' own documented 1..100-key range
 * rather than trusting the upstream's rejection to be our only bound.
 */

const ALLOWED_QUERIES = new Set<string>([STATE_QUERY, HEAD_QUERY]);

/** Bounds how long this server will hold a connection open for a wedged upstream node. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/** Mirrors getStateByKeys' own documented range (schema.graphql:813) — never our own guess. */
const MAX_STATE_KEYS = 100;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gqlUrl = process.env.REACT_APP_VSC_MARKET_GQL_URL;
  if (!gqlUrl) {
    // Mirrors getMarketConfig()'s own "unprovisioned" posture — honest
    // unavailable, never a silent fake. In practice the client-side config
    // check already refuses to build a real data source at all once this is
    // unset (it falls back to the Mock), so this only fires if the client
    // and server envs ever drift apart.
    return NextResponse.json({ errors: [{ message: 'prediction market GQL endpoint not configured' }] }, { status: 503 });
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
  // Only STATE_QUERY carries `keys`; HEAD_QUERY sends none, so this is skipped
  // rather than forced, and cannot itself reject a legitimate HEAD_QUERY call.
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
    if (!(await enforceMagiGqlRate(getClientIp(req), 'prediction_market'))) {
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
      // Same reasoning as the creator-tokens proxy (route.ts there, measured
      // live 2026-08-11): without this, Next's Data Cache can serve a stale
      // response — including a stale error status — back for a second
      // identical-body request instead of re-querying the node. This is
      // chain state read for a live market; every call must hit the real
      // node fresh. The client's own react-query cache (use-market.ts) is
      // the only cache this data path may have.
      cache: 'no-store'
    });
    const text = await upstream.text();
    // Pass the upstream body + status straight through. The client's own
    // postGql (vsc-gql.ts) already knows how to read a GraphQL {data,errors}
    // envelope and treat a non-ok status as a failure — duplicating that
    // parsing here would be a second copy that could disagree with the first.
    return new NextResponse(text, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' }
    });
  } catch (error) {
    logger.error(error, 'Prediction market GQL proxy: upstream unreachable');
    return NextResponse.json({ errors: [{ message: 'upstream unreachable' }] }, { status: 502 });
  }
}
