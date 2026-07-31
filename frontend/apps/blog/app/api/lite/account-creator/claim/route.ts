import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardAccountCreator } from '@/blog/lib/lite/http/guard';
import { liteConfig } from '@/blog/lib/lite/config';
import { withAdvisoryLock } from '@/blog/lib/lite/db/pool';
import { runActClaimOnce } from '@/blog/lib/lite/upgrade/act-claim';
import { ensureAccountCreator } from '@/blog/lib/lite/upgrade/hive-account-creator';
import { hasAccountCreator } from '@/blog/lib/lite/upgrade/account-creator';

/** Arbitrary but fixed key: all ACT claims across all processes contend on this one. */
const CLAIM_LOCK = 971_020_302;

const logger = getLogger('app');

/** Hard ceiling per call, so one request can never claim unbounded. */
const MAX_CLAIMS = 10;

/**
 * POST /api/lite/account-creator/claim — ops trigger for the ACT pool.
 *
 * `runActClaimOnce` has existed since the upgrade flow was written and had no caller,
 * so the token pool never filled and every upgrade would have failed at the last step.
 * This is that caller: a scheduler hits it the same way it hits the publisher drain,
 * and each call tops the pool up towards `LITE_ACT_MIN_POOL`, one claim at a time.
 *
 * Claiming ahead of demand is the point. The claim itself is RC-expensive and the
 * creator account is deliberately balance-free, so doing it lazily at upgrade time
 * makes a user wait on Resource Credits; doing it on a schedule makes it invisible.
 * (`createClaimedAccount` still claims in-line as a last resort — this endpoint is
 * what stops that path from ever being the normal one.)
 *
 * AUTH: `x-lite-account-creator-token` (F-L4) — a DEDICATED secret, distinct from the
 * posting-only publisher-drain token. This endpoint reaches `claim_account`, an
 * ACTIVE-authority operation, so it must not share a secret with POSTING-tier ops: a
 * leaked drain token must not transitively drive active-authority work. The blast radius
 * is still bounded (a zero-fee `claim_account` only converts the balance-free creator
 * account's Resource Credits into a token; it moves no funds), but the authority tiers
 * are now separated so the higher one can be rotated on its own.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardAccountCreator(req);
  if (blocked) return blocked;

  ensureAccountCreator();
  if (!hasAccountCreator()) {
    return NextResponse.json({ error: 'no_account_creator' }, { status: 503 });
  }

  // Defaults to ONE claim per call, like the drain. Claims must be spaced by a block
  // interval (see CLAIM_INTERVAL_MS — consecutive claims are otherwise the same
  // transaction and Hive rejects the duplicate), so a large `max` is a request that
  // takes `max * 3.5s` to answer. A cron ticking regularly is the intended shape;
  // `max` is for an operator filling an empty pool on purpose.
  const body = (await req.json().catch(() => ({}))) as { max?: number };
  const max = Math.min(Math.max(1, Number(body?.max) || 1), MAX_CLAIMS);

  // One claim run at a time, cluster-wide. Overlapping runs would each read the same
  // pre-claim pool size and overshoot the target, burning RC the creator account
  // needs. Skipping is correct: the pool is still there on the next tick.
  //
  // Even serialised, the last claim of a run can overshoot by one: a broadcast is
  // accepted into the mempool before `pending_claimed_accounts` moves, so the next
  // iteration may re-read a pre-claim count. The surplus is a token that simply waits
  // in the pool for the next upgrade — worth an occasional extra claim, not worth
  // blocking a whole run on chain confirmation.
  let claimed: number | null;
  try {
    claimed = await withAdvisoryLock(CLAIM_LOCK, async () => {
      let count = 0;
      for (let i = 0; i < max; i++) {
        const { claimed: didClaim } = await runActClaimOnce();
        if (!didClaim) break; // pool is at or above the floor — stop early
        count += 1;
      }
      return count;
    });
  } catch (error) {
    // Out of RC, a rejected broadcast, an unreachable node. A scheduler deserves a
    // reason it can put in an alert, not a stack trace; the message carries only the
    // creator's account name and the chain's own error, never key material.
    logger.error(error, 'ACT pool top-up failed');
    return NextResponse.json(
      { error: 'claim_failed', message: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }

  if (claimed === null) {
    return NextResponse.json({ status: 'skipped', reason: 'another claim run is in progress' });
  }

  if (claimed > 0) logger.info('ACT pool top-up claimed %d token(s)', claimed);
  return NextResponse.json({ status: 'ok', claimed, minPool: liteConfig.actMinPool });
}
