import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { STATE_QUERY, STATE_QUERY_HEX, HEAD_QUERY } from '@/blog/features/creator-tokens/lib/vsc/reads';
import { BALANCE_QUERY } from '@/blog/lib/lite/wallet/magi-balance';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceMagiGqlRate } from '@/blog/lib/lite/antispam/rate-limit';
import { consumeLocalGlobal, consumeLocalPerIp } from '@/blog/lib/lite/antispam/local-rate-limit';
import { cachedRead } from '@/blog/lib/server-read-cache';
import { withRetry } from '@transaction/lib/retry';

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
 *
 * ★ `MAX_VARIABLES_BYTES` ADDED (2026-08-12) — the cap above bounds `keys`
 * COUNT, not SIZE, and was credited with bounding our amplification of the
 * upstream when it does not: proven live, a single ~900 KB key sailed
 * straight through a 100-item array (well under `MAX_STATE_KEYS`) and reached
 * the real upstream, which returned 200. See `MAX_VARIABLES_BYTES`'s own
 * comment for how that limit was sized.
 */

// BALANCE_QUERY added 2026-08-19. `lib/lite/wallet/magi-balance.ts` used to
// fetch the node directly from the browser, which CORS and (since 2026-08-11)
// CSP both refuse — see that file's own doc for why the failure was silent and
// left the Buy button enabled for someone who could not pay. It is imported by
// identity, like the three above, so the proxy and the caller cannot drift.
const ALLOWED_QUERIES = new Set<string>([STATE_QUERY, STATE_QUERY_HEX, HEAD_QUERY, BALANCE_QUERY]);

/**
 * Bounds how long this server will hold a connection open for a wedged upstream node.
 *
 * ★ LOWERED FROM 10_000 (2026-08-13, O4-stuck-states.md item 5). Measured live: a
 * failing upstream answers this proxy in 9.11 s, which is the DOMINANT term in the
 * "bare spinner for 8-13 s" defect on `/creators/[handle]` -- `readMarket`
 * (`vsc-data-source.ts`) catches every rejection and never lets `marketQuery`
 * itself retry, so React Query's retry policy was never the driver here; this
 * timeout was. 5 s keeps real, working responses unaffected (this route talks to
 * one Magi node over a normal request/response call, not a slow indexer scan) while
 * cutting the dead-air wait for a wedged one roughly in half.
 */
const UPSTREAM_TIMEOUT_MS = 5_000;

/** Mirrors getStateByKeys' own documented range (schema.graphql:813) — never our own guess. */
const MAX_STATE_KEYS = 100;

/**
 * Byte-size ceiling on the forwarded `variables`, alongside (not instead of)
 * `MAX_STATE_KEYS` above — that cap only bounds how many entries `keys`
 * holds, nothing bounds how big any one entry is.
 *
 * Sized from what THIS app's own key builders can legitimately produce
 * (reads.ts), not a guessed round number: the widest single key this client
 * ever builds carries TWO accounts — kBal (`mb|<did>|<did>`) and kMatured
 * (`bal|<did>|<did>`) — each up to isWellFormedDid's own 160-byte max
 * (mirroring core/util.go's MaxAccountLen), so ~4 + 160 + 1 + 160 = 325 bytes
 * worst case. At MAX_STATE_KEYS (100) that's ~32.5 KB of key content alone;
 * add contractId and JSON array/object framing and the largest query this
 * client could ever legitimately send is still under 33 KB. 64 KiB leaves
 * that real ~2x headroom while staying nowhere near the ~900 KB single-key
 * payload proven (adversarial review, 2026-08-11) to sail through the
 * key-COUNT-only cap — that payload is ~14x over this limit.
 *
 * Shared verbatim with the prediction-market proxy (app/api/prediction-market/gql/route.ts):
 * that route's own key builders (vsc-market-data-source.ts) never carry two
 * accounts in one key, so its legitimate worst case is smaller than this —
 * using the same number keeps the two deliberate mirrors from diverging.
 */
const MAX_VARIABLES_BYTES = 64 * 1024;

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
  // ★ GLOBAL CEILING FIRST (audit anomaly AN-34, 2026-08-19). A per-IP cap of
  // any kind is defeated by using more IPs, so nothing here bounded how much
  // this server could amplify against the Magi node in total. This does, and it
  // applies on every request rather than only when the durable limiter is
  // unwell. See lib/lite/antispam/local-rate-limit.ts for the sizing argument.
  if (!consumeLocalGlobal('creator_tokens_gql')) {
    logger.warn('creator-tokens gql proxy: global in-process ceiling hit — shedding load');
    return NextResponse.json({ errors: [{ message: 'rate limited' }] }, { status: 429 });
  }

  const ip = getClientIp(req);
  try {
    if (!(await enforceMagiGqlRate(ip, 'creator_tokens'))) {
      return NextResponse.json({ errors: [{ message: 'rate limited' }] }, { status: 429 });
    }
  } catch (err) {
    // ★ NO LONGER A BARE FAIL-OPEN (AN-34). This used to be
    // `catch { /* limiter unavailable — proceed */ }`, which meant that with
    // the lite-accounts Postgres backend down — or simply never provisioned —
    // the per-IP cap was not degraded but ABSENT, and this route was
    // completely unbounded per caller. The original reasoning was right that a
    // store outage must not take chain reads offline; what it missed is that
    // "best effort" then means "no effort" in exactly the conditions a limiter
    // is for.
    //
    // The durable counter stays authoritative. This only takes over when it
    // cannot answer, and it is honestly weaker: per-process, resets on deploy.
    // A floor, not a replacement.
    if (!consumeLocalPerIp(ip, 'creator_tokens_gql')) {
      return NextResponse.json({ errors: [{ message: 'rate limited' }] }, { status: 429 });
    }
    logger.warn({ err }, 'creator-tokens gql proxy: durable rate limiter unavailable, using in-process fallback');
  }

  // ★ NO SESSION CHECK HERE, DELIBERATELY — recorded so it is not re-raised as
  // an oversight (it was, in the 2026-08-19 audit ledger, as half of AN-34).
  // This proxy serves PUBLIC chain reads to the token pages, which logged-out
  // visitors are meant to see; gating it on a session would break anonymous
  // browsing of every creator's market. It would also buy very little: sessions
  // are free to create, so an attacker gets one as easily as an IP. The
  // defensible bound on a public read proxy is the allowlist + the size caps +
  // the rate limits above, and that is what this route relies on.

  // ★★★ A 3-SECOND MEMO OF *SUCCESSFUL* READS, KEYED ON THE FULL BODY (2026-08-13).
  //
  // The `cache: 'no-store'` below and its comment stay exactly as they are — this
  // does not re-enable Next's Data Cache, which is what that comment is about. This
  // is our own map, and it is deliberately built to not have either of the two
  // failures that comment names:
  //
  //   - "a stale 502 that never clears once the node recovers" — only HTTP 200 is
  //     ever stored. An error is returned and forgotten, so the next caller retries
  //     the node immediately.
  //   - "if Next's cache key ever ignores the body, one creator's read served back
  //     for a DIFFERENT creator's query" — the key here IS the body: query text plus
  //     the exact variables. Two different creators cannot collide because their
  //     `keys` arrays differ, which is the whole content of the key.
  //
  // Why it is now worth having: measured in a browser on `/@ecency` (2026-08-13),
  // **9 POSTs to this route at 779-899ms each** — roughly 7 seconds of round trips on
  // one profile view, of which the `CreatorTokensHead` query alone is byte-identical
  // every time. 3s is one Hive-side block or so: long enough to collapse a single
  // page render's burst, short enough that a price the reader is watching is never
  // meaningfully behind, and far shorter than the client's own 30s refetch interval.
  // Pinned after the guard above: TypeScript does not carry that narrowing into a
  // nested function, and `fetchUpstream` closes over this.
  const upstreamUrl: string = gqlUrl;
  const cacheKey = `ct-gql:${upstreamUrl}:${JSON.stringify({ query, variables })}`;

  try {
    const cached = await cachedRead<{ status: number; text: string; contentType: string } | null>(
      cacheKey,
      3_000,
      async () => {
        const res = await fetchUpstream();
        // Only a success is worth remembering — see above.
        return res.status === 200 ? res : null;
      }
    );
    if (cached) {
      return new NextResponse(cached.text, {
        status: cached.status,
        headers: { 'Content-Type': cached.contentType }
      });
    }
  } catch {
    /* fall through to a direct, uncached attempt */
  }

  async function fetchUpstream(): Promise<{ status: number; text: string; contentType: string }> {
    const upstream = await fetch(upstreamUrl, {
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
    return {
      status: upstream.status,
      text,
      contentType: upstream.headers.get('content-type') ?? 'application/json'
    };
  }

  try {
    // ★ A6 retry rollout (2026-08-18): only this LAST-RESORT call is retried, not
    // the one inside `cachedRead` above. That first call already runs on every
    // cache miss and this is the fallback for when IT failed — retrying both
    // would mean up to two independent retry groups back to back on one request.
    // Kept tight (2 attempts, 1s budget): `UPSTREAM_TIMEOUT_MS` here is 5s,
    // deliberately lowered (see its own comment) to cut the "bare spinner"
    // wait — a full default 3-attempt/2.5s-budget retry on top of that would
    // partially undo that fix for a genuinely wedged node.
    const direct = await withRetry(fetchUpstream, {
      label: 'creator_tokens_gql',
      attempts: 2,
      budgetMs: 1_000
    });
    return new NextResponse(direct.text, {
      status: direct.status,
      headers: { 'Content-Type': direct.contentType }
    });
  } catch (error) {
    logger.error(error, 'Creator tokens GQL proxy: upstream unreachable');
    return NextResponse.json({ errors: [{ message: 'upstream unreachable' }] }, { status: 502 });
  }
}
