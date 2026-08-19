import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { STATE_QUERY, HEAD_QUERY } from '@/blog/features/prediction-market/lib/vsc-gql';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceMagiGqlRate } from '@/blog/lib/lite/antispam/rate-limit';
import { consumeLocalGlobal, consumeLocalPerIp } from '@/blog/lib/lite/antispam/local-rate-limit';
import { withRetry } from '@transaction/lib/retry';

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
 *
 * ★ `MAX_VARIABLES_BYTES` ADDED (2026-08-12) — sibling fix to the same finding
 * on the creator-tokens proxy: `MAX_STATE_KEYS` bounds `keys` COUNT, not SIZE,
 * and was credited with bounding our amplification of the upstream when it
 * does not — proven live there, a single ~900 KB key sailed straight through
 * a 100-item array and reached the real upstream. See `MAX_VARIABLES_BYTES`'s
 * own comment for the sizing (this route's own key builders never carry two
 * accounts in one key, so the creator-tokens proxy's worst case is the wider
 * one — the same number is used here so the two mirrors do not diverge).
 */

const ALLOWED_QUERIES = new Set<string>([STATE_QUERY, HEAD_QUERY]);

/** Bounds how long this server will hold a connection open for a wedged upstream node. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/** Mirrors getStateByKeys' own documented range (schema.graphql:813) — never our own guess. */
const MAX_STATE_KEYS = 100;

/**
 * Byte-size ceiling on the forwarded `variables`, alongside (not instead of)
 * `MAX_STATE_KEYS` above — that cap only bounds how many entries `keys`
 * holds, nothing bounds how big any one entry is.
 *
 * Same value as the creator-tokens proxy (app/api/creator-tokens/gql/route.ts)
 * — deliberately, since the two are mirrors and must not diverge. That
 * route's own key builders (reads.ts) carry the wider worst case (two
 * 160-byte accounts in one key, e.g. kBal/kMatured — ~325 bytes/key, ~32.5 KB
 * at MAX_STATE_KEYS); this route's key builders (vsc-market-data-source.ts:
 * rk/rkOutcomePool/rkStake/rkStakeTotal/rkClaimed) never carry more than one
 * account per key, so this route's own legitimate worst case is smaller
 * still. 64 KiB leaves real headroom over either route's actual traffic
 * while staying nowhere near the ~900 KB single-key payload proven
 * (adversarial review, 2026-08-11) to sail through the key-COUNT-only cap.
 */
const MAX_VARIABLES_BYTES = 64 * 1024;

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

  // Measured against the exact JSON this route forwards below (`variables:
  // variablesObj`'s underlying value) — not an estimate. Catches an
  // oversized value on ANY field, not just an oversized `keys` array, so a
  // single giant string still trips this even where the key-count check
  // below would never fire (e.g. HEAD_QUERY's empty variables, or a huge
  // contractId).
  const variablesBytes = Buffer.byteLength(JSON.stringify(variablesObj), 'utf8');
  if (variablesBytes > MAX_VARIABLES_BYTES) {
    return NextResponse.json(
      { errors: [{ message: `variables must be at most ${MAX_VARIABLES_BYTES} bytes` }] },
      { status: 400 }
    );
  }

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
  // ★ GLOBAL CEILING + FAIL-CLOSED FALLBACK (audit anomaly AN-34, 2026-08-19).
  // Applied here as well as on the creator-tokens proxy because these two
  // routes are deliberate mirrors and their own docs say so — fixing one and
  // not the other is how they drift. See that route, and
  // lib/lite/antispam/local-rate-limit.ts, for the full argument: a bare
  // `catch { proceed }` meant that with the limiter store down or simply never
  // provisioned, the per-IP cap was not degraded but ABSENT.
  if (!consumeLocalGlobal('prediction_market_gql')) {
    logger.warn('prediction-market gql proxy: global in-process ceiling hit — shedding load');
    return NextResponse.json({ errors: [{ message: 'rate limited' }] }, { status: 429 });
  }

  const ip = getClientIp(req);
  try {
    if (!(await enforceMagiGqlRate(ip, 'prediction_market'))) {
      return NextResponse.json({ errors: [{ message: 'rate limited' }] }, { status: 429 });
    }
  } catch (err) {
    if (!consumeLocalPerIp(ip, 'prediction_market_gql')) {
      return NextResponse.json({ errors: [{ message: 'rate limited' }] }, { status: 429 });
    }
    logger.warn({ err }, 'prediction-market gql proxy: durable rate limiter unavailable, using in-process fallback');
  }

  // Pinned after the guard above: TypeScript does not carry that narrowing into
  // a nested function, and `fetchUpstream` closes over this — same fix as the
  // creator-tokens proxy's own `upstreamUrl`.
  const upstreamUrl: string = gqlUrl;

  async function fetchUpstream(): Promise<{ status: number; text: string; contentType: string }> {
    const upstream = await fetch(upstreamUrl, {
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
    return {
      status: upstream.status,
      text,
      contentType: upstream.headers.get('content-type') ?? 'application/json'
    };
  }

  try {
    // ★ A6 retry rollout (2026-08-18): idempotent read (GraphQL STATE/HEAD query,
    // never a mutation — see `ALLOWED_QUERIES` above). Kept tight (2 attempts, 1s
    // budget) against this route's own 10s `UPSTREAM_TIMEOUT_MS`, matching the
    // creator-tokens proxy this route deliberately mirrors.
    const { status, text, contentType } = await withRetry(fetchUpstream, {
      label: 'prediction_market_gql',
      attempts: 2,
      budgetMs: 1_000
    });
    // Pass the upstream body + status straight through. The client's own
    // postGql (vsc-gql.ts) already knows how to read a GraphQL {data,errors}
    // envelope and treat a non-ok status as a failure — duplicating that
    // parsing here would be a second copy that could disagree with the first.
    return new NextResponse(text, {
      status,
      headers: { 'Content-Type': contentType }
    });
  } catch (error) {
    logger.error(error, 'Prediction market GQL proxy: upstream unreachable');
    return NextResponse.json({ errors: [{ message: 'upstream unreachable' }] }, { status: 502 });
  }
}
