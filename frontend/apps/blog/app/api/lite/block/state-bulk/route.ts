import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceLookupRate } from '@/blog/lib/lite/antispam/rate-limit';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { blockStatesBulk, type BulkBlockStateInput } from '@/blog/lib/lite/social/block-service';
import { isBlockTargetKind } from '@/blog/lib/lite/social/block-actor';

const logger = getLogger('app');

/** Hard ceiling on one request's payload — matches `blockStatesBulk`'s own cap, so
 *  a request over the limit is truncated the same way server-side, not rejected. */
const MAX_TARGETS = 200;

/**
 * GET /api/lite/block/state-bulk?targets=<json> — `/api/lite/block/state`, batched.
 *
 * ★★★ THE N+1 FIX. See `use-lumen-block.ts`'s doc for the measured storm: the
 * per-target route was firing once per distinct author on a feed (20-30 requests
 * on one home load) and once per comment author on a thread (~100 on a heavy
 * page). This is the SAME question — "is the viewer blocking this person, and
 * should a Block control be offered at all" — asked for every author on a page in
 * one round trip instead of one request each. `use-lumen-block.ts` coalesces every
 * mounted card's request into a call here; `blockStatesBulk` does the batched
 * server-side work (see its own doc for the query count).
 *
 * `targets` is a JSON array of `[name, kind]` tuples — kept terse rather than an
 * array of `{target, kind}` objects because this travels in a query string and a
 * feed page's worth of authors (20-30, occasionally more on a big thread) should
 * comfortably stay well under any practical URL-length ceiling. `kind` is
 * `'hive' | 'lumen' | 'auto'`, same alphabet `isBlockTargetKind` already validates
 * for the single-item route; anything else degrades to `'auto'` rather than
 * rejecting the whole batch over one malformed pair.
 *
 * GET, not POST: this is a pure read with no side effects, exactly like the
 * single-item route it replaces the fan-out of, and it shares that route's
 * `guardRead`-only posture (no CSRF header required) rather than `guardWrite`'s —
 * a CSRF token defends a STATE CHANGE an attacker's page could trigger blind, and
 * there is no state change here to defend. Response is per-viewer (keyed off the
 * session cookie via `getLiteSession`), so — per this codebase's own standing rule
 * (`middleware.ts`) — it does NOT get `Cache-Control: public` and does NOT need a
 * middleware-matcher exclusion: it is dynamic by construction (Next.js never
 * statically caches a handler that reads cookies) and this route sets no
 * `Cache-Control` header at all, same as `state/route.ts` and `list/route.ts`
 * beside it.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const raw = req.nextUrl.searchParams.get('targets');
  if (!raw) return NextResponse.json({ error: 'targets_required' }, { status: 400 });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid_targets' }, { status: 400 });
  }
  if (!Array.isArray(parsed)) return NextResponse.json({ error: 'invalid_targets' }, { status: 400 });

  const items: BulkBlockStateInput[] = [];
  for (const entry of parsed.slice(0, MAX_TARGETS)) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [name, rawKind] = entry;
    if (typeof name !== 'string' || !name) continue;
    items.push({ target: name, kind: isBlockTargetKind(rawKind) ? rawKind : 'auto' });
  }
  if (items.length === 0) return NextResponse.json({ ok: true, states: [] });

  // The SAME signup-funnel per-IP budget the single-item route shares, but
  // consumed ONCE for the whole page's worth of targets rather than once per
  // author — the entire point of this route existing.
  if (!(await enforceLookupRate(getClientIp(req)))) {
    return NextResponse.json(
      { ok: false, states: items.map((i) => ({ ...i, available: false, blocking: false })) },
      { status: 429 }
    );
  }

  try {
    const session = await getLiteSession();
    const states = await blockStatesBulk(session.user, items);
    return NextResponse.json({ ok: true, states });
  } catch (error) {
    logger.error(error, 'Lumen bulk block state failed');
    // Degrade every entry to "no control, not blocking" — same posture as
    // `state/route.ts`'s own catch: a failed lookup must never claim a block that
    // may not exist, nor make every Block control on the page vanish into an
    // error state with no way to tell "unavailable" from "we don't know".
    return NextResponse.json({
      ok: false,
      states: items.map((i) => ({ ...i, available: false, blocking: false }))
    });
  }
}
