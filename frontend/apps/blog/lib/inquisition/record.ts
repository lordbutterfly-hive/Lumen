import 'server-only';
import { getLogger } from '@ui/lib/logging';
import { downvoteTally, profileRecord, type ProfileRecord } from './boards-sql';
import { voteLedger } from './vote-ledger';
import { steemPostsSinceFork } from './crossposting';
import { readRecord, recordStale, writeRecord } from './board-store';

const logger = getLogger('app');

/**
 * ════ BUILDING ONE ACCOUNT'S RECORD ════
 *
 * ★ THIS LIVES HERE AND NOT IN THE ROUTE because a Next.js route module may only export
 * route handlers and its own config; exporting a helper from one is a build error. The
 * weekly warm pass needs to build a record without going through HTTP, so the building
 * belongs in the library and the route becomes a caller like any other.
 */

/**
 * The slow half of a record: everything that is not one indexed lookup.
 *
 * The deduplicated downvote tally is 4.9s for @lighteye and 23.2s for @haejin, the vote
 * ledger is 12.1s on a modest account, and the Steem walk is up to six requests to
 * somebody else's node.
 *
 * ★ ALL THREE AT ONCE, BECAUSE THEY DO NOT CONTEND. The tally and the ledger are HiveSQL
 * on the reader lane, which has six slots; the Steem walk is a different service
 * entirely. Running them in sequence would add their latencies for no reason. Each is
 * allowed to fail on its own: one dash is not the whole record.
 */
export async function slowHalf(
  account: string,
  base: ProfileRecord
): Promise<ProfileRecord & Record<string, unknown>> {
  const [tally, ledger, steem] = await Promise.all([
    downvoteTally(account).catch(() => null),
    voteLedger(account).catch(() => null),
    steemPostsSinceFork(account).catch(() => null)
  ]);

  return {
    ...base,
    downvotes: tally ? tally.downvotes : null,
    downvoters: tally ? tally.downvoters : 0,
    lastDownvote: tally?.lastDownvote ? new Date(tally.lastDownvote).toISOString() : null,
    removedUsd: ledger ? ledger.removedUsd : null,
    topDownvoters: ledger?.topDownvoters ?? [],
    topByCount: ledger?.topByCount ?? [],
    selfRewardUsd: ledger ? ledger.selfRewardUsd : null,
    selfRewardPct: ledger ? ledger.selfRewardPct : null,
    steemPosts: steem ? steem.posts : null,
    // ★ The walk's own saturation flag. Dropping it printed a floor as a total.
    steemPartial: steem?.partial ?? false,
    steemLastPost: steem?.lastPost ?? null
  };
}

/*
 * ★★ ONE BUILD PER ACCOUNT PER PROCESS, so a profile opened in four tabs does not start
 * four identical twenty-second computations. Deliberately in memory rather than a lock
 * file: this is not trying to coordinate the three workers, only to stop one worker
 * racing itself. Two workers both warming the same cold record is a little waste; one
 * worker doing it four times is what a reader can cause by refreshing.
 */
const INFLIGHT = Symbol.for('lumen.inquisition.record.inflight.v1');
const inflight = ((globalThis as Record<symbol, unknown>)[INFLIGHT] ??= new Set<string>()) as Set<string>;

export function fillInBackground(account: string, base: ProfileRecord): void {
  if (inflight.has(account)) return;
  inflight.add(account);
  void (async () => {
    try {
      writeRecord(account, await slowHalf(account, base), true);
    } catch (error) {
      logger.warn(`inquisition: background record fill failed for @${account}: ${String(error)}`);
    } finally {
      inflight.delete(account);
    }
  })();
}

/**
 * Compute a record end to end and store it. Used by the weekly warm pass, which has no
 * reader waiting and so has no reason to return half of one.
 */
export async function buildRecord(account: string): Promise<boolean> {
  const base = await profileRecord(account);
  if (!base) return false;
  writeRecord(account, await slowHalf(account, base), true);
  return true;
}

/**
 * ════ THE WEEKLY WARM ════
 *
 * ★★★ THE FIRST PERSON TO OPEN A PROFILE SHOULD NOT BE THE ONE WHO PAYS FOR IT, at least
 * not for the profiles people actually open. Every row on the two downvote boards is a
 * link, and the reader who clicks one is the likeliest reader there is.
 *
 * ★★ BOUNDED, BECAUSE THE HONEST VERSION OF THIS IS UNAFFORDABLE. Warming all five
 * boards is ~500 accounts at roughly half a minute each, which is four hours of a
 * database we do not own, every week, to save a handful of readers thirty seconds. The
 * top of the two boards that carry profile links is 40 accounts and about twenty
 * minutes, once a week, and it covers the overwhelming majority of clicks. Everything
 * below it still works: the first reader gets the cheap half instantly and the rest
 * fills in behind them, and every reader after that is served from disk.
 *
 * ★ IT SKIPS WHAT IS ALREADY FRESH, so a re-run costs nothing, and it stops at the wall
 * clock rather than at a count, because one @spaminator-sized account can be worth ten
 * ordinary ones.
 */
const WARM_ROWS = 20;
const WARM_BUDGET_MS = 20 * 60 * 1000;

export async function warmRecords(accounts: string[], budgetMs = WARM_BUDGET_MS): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let warmed = 0;
  let skipped = 0;

  for (const account of accounts.slice(0, WARM_ROWS)) {
    if (Date.now() >= deadline) {
      logger.warn(
        `inquisition: record warm ran out of budget after ${warmed} built and ${skipped} already fresh`
      );
      return;
    }
    const stored = readRecord<ProfileRecord>(account);
    if (stored?.complete && !recordStale(stored)) {
      skipped += 1;
      continue;
    }
    try {
      if (await buildRecord(account)) warmed += 1;
    } catch (error) {
      // One account that cannot be built is not a reason to abandon the other nineteen.
      logger.warn(`inquisition: record warm failed for @${account}: ${String(error)}`);
    }
  }
  logger.info(`inquisition: record warm done, ${warmed} built and ${skipped} already fresh`);
}
