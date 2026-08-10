import { NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireLiteUser } from '@/blog/lib/lite/http/actor';
import { loadRetentionFacts } from '@/blog/lib/lite/retention/facts-query';
import { computeLiteRetention } from '@/blog/lib/lite/retention/compute';
import { toLiteRetentionResponse } from '@/blog/lib/lite/retention/wire';

const logger = getLogger('app');

/**
 * GET /api/lite/retention — the signed-in LITE user's own rank, streak and gates.
 *
 * ★ WHY THIS ROUTE EXISTS.
 *
 * The ladder is chain-derived, so `/api/streak/[user]` answers `404 account not found`
 * for anyone without a Hive account, and `use-retention.ts` disables the whole feature
 * for lite accounts rather than fire a call that can never succeed. The result is that
 * lite users — the audience the product is FOR, who by design earn no rewards at all —
 * see no rank, no streak, no progress, nothing. They gave up the money on purpose; they
 * should not silently have given up the status too. This computes the same ladder from
 * the data Lumen already owns.
 *
 * SESSION-SCOPED BY CONSTRUCTION. It takes NO username parameter and there is nothing
 * in the request that selects a subject: the answer is always about `session.user`.
 * That is not only an authorisation choice, it removes the enumeration surface the
 * chain route has to defend with a username regex, a rate limiter and a negative cache
 * — none of which are needed when the caller cannot name anyone but themselves. Anyone
 * later tempted to add `?user=` should add a separate, rate-limited public route rather
 * than parameterise this one.
 *
 * `requireLiteUser` (not `requireActiveLiteUser`): reading your own standing is not
 * participation. A suspended account may still see where it stands, the same reasoning
 * `/api/lite/profile` uses. A REVOKED session is still refused — the epoch is checked.
 *
 * COST: one Postgres statement, every arm on an index added by migration 0025. No chain
 * call, no Hive API, no fan-out, no cache needed — so none of the failure modes the
 * chain route had to grow bounds for (the 639-second `/api/streak/lordbutterfly` walk)
 * exist here. Nothing to time out, nothing to negative-cache, nothing to evict.
 */
export async function GET(): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const session = await getLiteSession();
  const actor = await requireLiteUser(session.user, session);
  if (!actor.ok) return actor.response;

  try {
    const facts = await loadRetentionFacts(actor.user.userId);
    if (!facts) {
      // requireLiteUser already resolved the row, so this means it vanished between
      // the two reads. Say so rather than serving a rank computed from nothing.
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // The body is structurally the shared `RetentionSummaryResponse`, discriminated by
    // `provenance.source === 'lumen'` — see wire.ts. Existing retention components
    // render it unchanged; only a consumer comparing lite rungs to chain rungs needs
    // to branch, and that one must.
    return NextResponse.json(
      toLiteRetentionResponse(computeLiteRetention(actor.user.displayName, facts))
    );
  } catch (error) {
    logger.error(error, 'Lite retention summary failed for %s', actor.user.userId);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
