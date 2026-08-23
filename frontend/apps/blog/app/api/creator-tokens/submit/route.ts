import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceMagiGqlRate } from '@/blog/lib/lite/antispam/rate-limit';
import { consumeLocalGlobal, consumeLocalPerIp } from '@/blog/lib/lite/antispam/local-rate-limit';
import { NONCE_OPERATION, SUBMIT_OPERATION, TX_STATUS_OPERATION } from './operations';
import { guardBodySize } from '@/blog/lib/lite/http/guard';

const logger = getLogger('app');

/**
 * Same-origin proxy for the two Magi GraphQL operations the WALLET-SIGNED rail
 * needs: `getAccountNonce` (read) and `submitTransactionV1` (write).
 *
 * ★ WHY THIS IS A SEPARATE ROUTE AND NOT TWO MORE ENTRIES IN THE READ PROXY.
 * `app/api/creator-tokens/gql/route.ts` is documented, sized and rate-limited
 * as a READ proxy: its limiter budget assumes cheap, idempotent, repeatable
 * chain reads that a page may issue on every render. A transaction submit is
 * none of those things — it is non-idempotent, it consumes a nonce slot, it
 * costs the signer resource credits, and one accepted call has permanent
 * effect. Putting it behind the read route would have let a submit inherit a
 * read-shaped budget by accident, and would have quietly changed that route's
 * role from "cannot alter state" to "can". Both are the kind of change that is
 * invisible in a diff and obvious in an incident.
 *
 * Everything the read proxy gets right is kept: the upstream comes from server
 * env ONLY (a client-supplied target would make this an SSRF relay), the
 * operations are allowlisted by exact string match, and the body is bounded.
 *
 * ★ THE LIMITS HERE ARE DELIBERATELY TIGHTER THAN THE READ ROUTE'S. A human
 * signing transactions in a wallet cannot produce more than a few submits a
 * minute — every one requires a wallet prompt and a human confirmation. A
 * caller exceeding that is not a user.
 */

const ALLOWED = new Map<string, 'nonce' | 'submit' | 'status'>([
  [NONCE_OPERATION, 'nonce'],
  [SUBMIT_OPERATION, 'submit'],
  // A cheap, idempotent read, so it shares the generous nonce budget rather
  // than the submit one — confirming a transaction must never be rationed as
  // tightly as sending one, or a user cannot find out what happened to theirs.
  [TX_STATUS_OPERATION, 'status']
]);

/**
 * A serialized transaction is CBOR, base64'd. The node's own ingest bounds
 * what it will accept, but relying on the upstream's validation to bound OUR
 * amplification is exactly the defect the read proxy already had to fix. A
 * creator-tokens call with one op and one intent is ~600 bytes encoded; 128 KiB
 * is ~200x that, which leaves room for a multi-op transaction we do not build
 * today while staying far from anything that could be used as a relay.
 */
const MAX_BODY_BYTES = 128 * 1024;

/** Per-IP submits per minute. A wallet prompt gates every real one. */
const SUBMIT_PER_IP_PER_MIN = 20;
/** Total submits per minute across all callers — the bound that survives many IPs. */
const SUBMIT_GLOBAL_PER_MIN = 300;
/** Nonce reads are cheap and are issued before every submit, so they get more room. */
const NONCE_PER_IP_PER_MIN = 120;
const NONCE_GLOBAL_PER_MIN = 2_000;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gqlUrl = process.env.REACT_APP_CREATOR_TOKENS_GQL_URL;
  if (!gqlUrl) {
    return NextResponse.json(
      { errors: [{ message: 'creator tokens GQL endpoint not configured' }] },
      { status: 503 }
    );
  }


  // Refuse an oversized body before it is buffered and parsed. See guardBodySize.
  // A 512 KiB OUTER bound only. This route keeps its own, tighter post-parse cap; the
  // point here is that the tighter cap runs AFTER the body is already in memory, which
  // is the ordering defect guardBodySize exists to close.
  const tooBig = guardBodySize(req);
  if (tooBig) return tooBig;

  const raw = await req.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json(
      { errors: [{ message: `body must be at most ${MAX_BODY_BYTES} bytes` }] },
      { status: 413 }
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ errors: [{ message: 'invalid JSON body' }] }, { status: 400 });
  }

  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const query = record.query;
  const kind = typeof query === 'string' ? ALLOWED.get(query) : undefined;
  if (!kind) {
    return NextResponse.json({ errors: [{ message: 'unsupported operation' }] }, { status: 400 });
  }

  const variables =
    typeof record.variables === 'object' && record.variables !== null
      ? (record.variables as Record<string, unknown>)
      : {};

  // Shape-check the variables for the operation actually requested, so a
  // malformed submit is refused here rather than forwarded. The node would
  // reject it too, but forwarding garbage is amplification we control.
  if (kind === 'nonce') {
    if (typeof variables.account !== 'string' || variables.account.length === 0 || variables.account.length > 200) {
      return NextResponse.json({ errors: [{ message: 'account must be a non-empty string' }] }, { status: 400 });
    }
  } else if (kind === 'status') {
    if (typeof variables.id !== 'string' || variables.id.length === 0 || variables.id.length > 200) {
      return NextResponse.json({ errors: [{ message: 'id must be a non-empty string' }] }, { status: 400 });
    }
  } else {
    for (const field of ['tx', 'sig'] as const) {
      const v = variables[field];
      if (typeof v !== 'string' || v.length === 0) {
        return NextResponse.json({ errors: [{ message: `${field} must be a non-empty base64 string` }] }, { status: 400 });
      }
      // Standard and url-safe, padded or raw — the node accepts all four
      // (gql/gqlgen/base64.go:16-26), so this must not be narrower than that.
      if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(v)) {
        return NextResponse.json({ errors: [{ message: `${field} must be base64` }] }, { status: 400 });
      }
    }
  }

  // ── limits ────────────────────────────────────────────────────────────────
  // Global ceiling first: it is the only bound that survives a caller with many
  // IPs, and it applies on every request rather than only when the durable
  // limiter is unavailable.
  const scope = kind === 'submit' ? 'ct-submit' : 'ct-nonce';
  const globalLimit = kind === 'submit' ? SUBMIT_GLOBAL_PER_MIN : NONCE_GLOBAL_PER_MIN;
  if (!consumeLocalGlobal(scope, globalLimit)) {
    return NextResponse.json({ errors: [{ message: 'busy, retry shortly' }] }, { status: 429 });
  }

  const ip = getClientIp(req);
  const perIpLimit = kind === 'submit' ? SUBMIT_PER_IP_PER_MIN : NONCE_PER_IP_PER_MIN;
  if (!consumeLocalPerIp(ip, scope, perIpLimit)) {
    return NextResponse.json({ errors: [{ message: 'too many requests' }] }, { status: 429 });
  }

  // ★ THE ANSWER IS HONOURED, NOT DISCARDED. This function RETURNS a boolean
  // and throws only when the limiter store itself is unreachable — so
  // `await enforceMagiGqlRate(ip)` inside a try, ignoring the result, consumed
  // a token and then proceeded regardless, i.e. no durable limit at all on the
  // write path. That defeats the entire reason this route was split from the
  // read proxy. Caught in cross-session review, 2026-08-20.
  try {
    if (!(await enforceMagiGqlRate(ip, scope === 'ct-submit' ? 'creator_tokens_submit' : 'creator_tokens'))) {
      return NextResponse.json({ errors: [{ message: 'daily limit reached' }] }, { status: 429 });
    }
  } catch {
    // The durable (Postgres) limiter is optional in this deployment. The
    // in-process caps above already applied, so falling open here degrades the
    // limit rather than removing it — which is the whole reason those exist.
  }

  // ── forward ───────────────────────────────────────────────────────────────
  // ★ NO RETRY ON SUBMIT. The read proxy wraps its upstream call in `withRetry`
  // because a repeated read is free. A repeated SUBMIT is not: the node's
  // rejects #1-#21 all fire before anything is recorded (so the nonce is
  // unconsumed and the CLIENT may safely retry), but a datalayer or p2p failure
  // happens AFTER commit — retrying that re-submits a transaction that may
  // already have been accepted. Deciding that is the caller's business, with
  // the nonce in hand; this route must never make it silently.
  try {
    const upstream = await fetch(gqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      cache: 'no-store'
    });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  } catch (error) {
    logger.error(error, 'creator-tokens submit proxy: upstream request failed');
    return NextResponse.json(
      { errors: [{ message: 'the Magi node could not be reached' }] },
      { status: 502 }
    );
  }
}
