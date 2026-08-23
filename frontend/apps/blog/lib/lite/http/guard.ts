import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { liteConfig } from '../config';
import { hasCsrfHeader } from './csrf';

/** Constant-time string compare (avoids a timing side-channel on the token). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Preconditions shared by every lite route. Returns a ready NextResponse to
 * short-circuit with, or null to proceed.
 *
 * The feature stays dark (503) until infra is provisioned + the flag is set —
 * so merging this code cannot expose an unfinished backend by accident.
 */

function disabledResponse(): NextResponse {
  return NextResponse.json({ error: 'lite_accounts_disabled' }, { status: 503 });
}

/** For mutating routes (POST): enabled + CSRF header. */
export function guardWrite(req: NextRequest): NextResponse | null {
  if (!liteConfig.enabled || !liteConfig.databaseUrl) return disabledResponse();
  if (!hasCsrfHeader(req)) {
    return NextResponse.json({ error: 'missing_csrf_header' }, { status: 403 });
  }
  return null;
}

/** For read-only routes (GET): enabled only. */
export function guardRead(): NextResponse | null {
  if (!liteConfig.enabled || !liteConfig.databaseUrl) return disabledResponse();
  return null;
}

/**
 * For the publisher drain endpoint: enabled + a valid shared token (constant-time).
 * This is the ops trigger a scheduler (cron/queue) calls to push queued posts to
 * Hive — it is NOT reachable by a browser session and is disabled outright when
 * `LITE_PUBLISHER_TOKEN` is unset, so it cannot be left open by accident.
 */
export function guardPublisher(req: NextRequest): NextResponse | null {
  if (!liteConfig.enabled || !liteConfig.databaseUrl) return disabledResponse();
  const token = req.headers.get('x-lite-publisher-token') ?? '';
  if (!liteConfig.publisherToken || !safeEqual(token, liteConfig.publisherToken)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

/**
 * For moderation routes: enabled + a valid shared token (constant-time).
 *
 * A token rather than a user role because there is no admin account model yet, and a
 * shared secret an operator holds is honest about that — better than inventing a
 * half-role system that looks like authorisation but isn't.
 */
export function guardModerator(req: NextRequest): NextResponse | null {
  if (!liteConfig.enabled || !liteConfig.databaseUrl) return disabledResponse();
  const token = req.headers.get('x-lite-moderator-token') ?? '';
  if (!liteConfig.moderatorToken || !safeEqual(token, liteConfig.moderatorToken)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

/**
 * For the ACT-claim endpoint: enabled + a valid shared token (constant-time).
 *
 * SEPARATE from guardPublisher (F-L4). The claim route reaches `claim_account`, an
 * ACTIVE-authority operation, whereas the publisher drain is POSTING-only. Sharing one
 * secret across both authority tiers means a leaked posting-drain token also authorises
 * active-authority ops; a distinct `LITE_ACCOUNT_CREATOR_TOKEN` keeps the higher tier
 * rotatable on its own. Disabled outright when the token is unset.
 */
export function guardAccountCreator(req: NextRequest): NextResponse | null {
  if (!liteConfig.enabled || !liteConfig.databaseUrl) return disabledResponse();
  const token = req.headers.get('x-lite-account-creator-token') ?? '';
  if (!liteConfig.accountCreatorToken || !safeEqual(token, liteConfig.accountCreatorToken)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

/** For recsys ingestion routes: enabled + a valid shared token (constant-time). */
export function guardRecsys(req: NextRequest): NextResponse | null {
  if (!liteConfig.enabled || !liteConfig.databaseUrl) return disabledResponse();
  const token = req.headers.get('x-lite-recsys-token') ?? '';
  if (!liteConfig.recsysToken || !safeEqual(token, liteConfig.recsysToken)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

/**
 * The largest JSON body any ordinary lite write may send.
 *
 * Sized off the biggest legitimate one: an advanced post caps title at 255 and
 * body at 100,000 characters (`content/pre-screen.ts`), and multi-byte UTF-8
 * plus tags and JSON framing can carry that well past 100 KB of bytes. 512 KiB
 * leaves real headroom for the largest honest post while refusing anything that
 * is obviously not one. Uploads are exempt: `upload/route.ts` is multipart and
 * does its own `content-length` check for a different, larger limit.
 */
export const MAX_JSON_BODY_BYTES = 512 * 1024;

/**
 * Refuse an oversized body BEFORE it is buffered and parsed.
 *
 * ★ THE ORDER IS THE POINT (audit D1-12, 2026-08-20). Every lite write route
 * called `await req.json()` first and checked length afterwards — so the whole
 * body was already read into memory and parsed before any limit applied, and
 * the post-parse caps in `pre-screen.ts` bounded what was STORED, not what was
 * ALLOCATED. There is no backstop behind them either: no body limit in
 * `next.config.js` (the Server Actions setting does not apply to route
 * handlers), and none in the Caddyfile. The three chain proxies already guard
 * this carefully; the ordinary routes never got it.
 *
 * `content-length` can be absent or lied about, so this is a cheap first gate,
 * not the only one — a chunked body that overruns still fails at the parse. It
 * removes the trivial case, which is the one an attacker actually sends.
 */
export function guardBodySize(req: NextRequest, maxBytes = MAX_JSON_BODY_BYTES): NextResponse | null {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }
  return null;
}

/**
 * ★ THE STREAM-BOUNDED READ (2026-08-23). Use this instead of `guardBodySize` wherever an
 * UNAUTHENTICATED caller can reach the route.
 *
 * `guardBodySize` above trusts `content-length`, and an attacker chooses whether to send
 * one. A `Transfer-Encoding: chunked` request with no `content-length` yields
 * `Number('') === 0`, which is not `> maxBytes`, so the header check passes and
 * `req.json()` then buffers the whole stream. Next's App Router imposes no body limit of
 * its own (there is no `bodyParser.sizeLimit` for route handlers), so the bound has to be
 * enforced while reading.
 *
 * This reads the stream itself, counting bytes, and cancels the moment the limit is
 * exceeded, so an oversized body is never fully buffered. Returns `null` for "too large";
 * the caller answers 413. An absent body reads as an empty string, matching what
 * `req.text()` would have produced.
 *
 * `guardBodySize` is kept for token- and session-guarded routes: there an attacker must
 * already hold a valid credential, and the cheap header check runs before any work.
 */
export async function readBoundedBody(
  req: NextRequest,
  maxBytes = MAX_JSON_BODY_BYTES
): Promise<string | null> {
  const body = req.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    // A transport failure mid-read is not an oversized body; treat it as an empty one and
    // let the caller's own parse-failure path answer.
    return '';
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** The 413 every bounded-read caller returns, so the shape cannot drift between them. */
export function payloadTooLarge(): NextResponse {
  return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
}

/**
 * `readBoundedBody` plus a JSON parse, which is what every caller actually wants.
 *
 * Returns `null` when the body was too large, so the caller answers 413. Returns
 * `{ body: null }` for an absent or unparseable body, exactly matching the
 * `req.json().catch(() => null)` shape these routes used before, so no route changes its
 * behaviour on malformed input.
 */
export async function readBoundedJson<T = Record<string, unknown>>(
  req: NextRequest,
  maxBytes = MAX_JSON_BODY_BYTES
): Promise<{ body: T | null } | null> {
  const raw = await readBoundedBody(req, maxBytes);
  if (raw === null) return null;
  if (raw.length === 0) return { body: null };
  try {
    return { body: JSON.parse(raw) as T };
  } catch {
    return { body: null };
  }
}
