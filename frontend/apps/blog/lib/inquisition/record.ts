import 'server-only';
import { getLogger } from '@ui/lib/logging';
import { downvoteTally, downvotesCast, profileRecord, type ProfileRecord } from './boards-sql';
import { removedByVoter, voteLedger } from './vote-ledger';
import { steemPostsSinceFork } from './crossposting';
import {
  HEARTBEAT_MS,
  claimBuild,
  isClaimed,
  readRecord,
  recordStale,
  releaseBuild,
  touchClaim,
  writeRecord
} from './board-store';

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
export interface SlowHalf {
  record: ProfileRecord & Record<string, unknown>;
  /**
   * True when at least one expensive figure came back `null` for a reason other than
   * "there is nothing there". See `writeRecord` — a record with a hole in it must not be
   * stored as the finished article for a week.
   */
  partial: boolean;
}

export async function slowHalf(
  account: string,
  base: ProfileRecord,
  previous?: Record<string, unknown>
): Promise<SlowHalf> {
  const [tally, ledger, steem, cast, removedByThem] = await Promise.all([
    downvoteTally(account).catch(() => null),
    /*
     * ★★ THE BACKGROUND LANE, BECAUSE NOBODY IS WAITING ON THIS CALL AND 60s IS NOT
     * ENOUGH FOR A BIG ACCOUNT (2026-09-20). `voteLedger`'s reader lane caps each of its
     * three statements at 60s, which is right when a reader is blocked on it and wrong
     * here: @acidyo's ledger did not finish, so its REMOVED, top-three and SELF-REWARD
     * were stored empty and then served as dashes for a week. This path is the fill that
     * runs behind the response and the weekly warm that runs behind nobody, so it takes
     * the slow lane's longer ceiling and queues behind board builds if it must.
     */
    voteLedger(account, 'background').catch(() => null),
    steemPostsSinceFork(account).catch(() => null),
    downvotesCast(account).catch(() => null),
    // ★ Answered-with-NULL and did-not-answer are different things (2026-09-22): the
    // first is a finished figure ("no valued removal"), the second is the only reason
    // to try again tonight. `removedByVoter` throws on the second, so only that one
    // becomes `null` here.
    removedByVoter(account).then((value) => ({ value })).catch(() => null)
  ]);

  /*
   * ★★★ A SUM OVER NO ROWS IS NULL, AND NULL MEANT "COULD NOT ASK" (found 2026-09-20,
   * owner: "for acidyo it doesnt show removed hbd or self reward").
   *
   * `SUM(...)` returns NULL when nothing matched, which this layer deliberately reads as
   * "not computable" rather than as $0 — right for a failed query, wrong for an account
   * that has simply never been downvoted or never cast one. The counts are the tiebreak:
   * if the tally says zero downvotes were received, then zero HBD was removed, and that
   * is a fact worth printing rather than a dash. Only a null with a non-zero count beside
   * it is genuinely missing.
   */
  const removedUsd = ledger ? (tally?.downvotes === 0 ? 0 : ledger.removedUsd) : null;
  const removedFromOthersUsd = cast?.downvotes === 0 ? 0 : removedByThem ? removedByThem.value : null;

  /*
   * ★★ A FIGURE THAT DID NOT ANSWER KEEPS THE LAST ONE WE HAD, AS A MINIMUM (2026-09-23,
   * owner: "fill those 13 as best as possible, with the max you extracted with a +").
   * The biggest accounts' whole-history sums cannot finish inside the query cap, so they
   * are summed offline in slices (scripts/inquisition) and written into the record; a
   * weekly refresh that times out again used to put the dash straight back. Now it keeps
   * the previous figure and marks it a floor ("+"), which stays true: these totals only
   * grow. A figure computed fresh is exact again. Carried figures are not "partial", so a
   * query known not to finish is not retried every day.
   */
  const prev = previous ?? {};
  const prevNum = (key: string): number | null => {
    const v = prev[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const carryLedger = ledger === null && prevNum('removedUsd') !== null;
  const carryRemoved =
    removedByThem === null && cast?.downvotes !== 0 && prevNum('removedFromOthersUsd') !== null;
  const carrySteem = steem === null && prevNum('steemPosts') !== null;

  // ★ A silent null is not a behaviour (2026-09-22: 102 records on disk were partial and
  // the log held three lines). Every half that did not answer is named here, once per
  // fill, so the nightly warm log says WHICH query is the one that never finishes.
  const missing = [
    tally === null ? 'downvote tally' : '',
    ledger === null ? `vote ledger${carryLedger ? ' (kept the previous figure)' : ''}` : '',
    steem === null ? `steem walk${carrySteem ? ' (kept the previous figure)' : ''}` : '',
    cast === null ? 'cast tally' : '',
    removedByThem === null && cast?.downvotes !== 0
      ? `removed by them (did not answer${carryRemoved ? '; kept the previous figure' : ''})`
      : ''
  ].filter(Boolean);
  if (missing.length > 0) {
    logger.warn(`inquisition: record for @${account} is partial, missing ${missing.join(', ')}`);
  }

  return {
    record: {
      ...base,
      downvotes: tally ? tally.downvotes : null,
      downvoters: tally ? tally.downvoters : 0,
      lastDownvote: tally?.lastDownvote ? new Date(tally.lastDownvote).toISOString() : null,
      removedUsd: carryLedger ? prevNum('removedUsd') : removedUsd,
      removedUsdFloor: carryLedger,
      topDownvoters: ledger ? ledger.topDownvoters : carryLedger ? (prev.topDownvoters as { account: string; usd: number }[] | undefined) ?? [] : [],
      topByCount: ledger ? ledger.topByCount : carryLedger ? (prev.topByCount as { account: string; votes: number }[] | undefined) ?? [] : [],
      selfRewardUsd: ledger ? ledger.selfRewardUsd : carryLedger ? prevNum('selfRewardUsd') : null,
      selfRewardPct: ledger ? ledger.selfRewardPct : carryLedger ? prevNum('selfRewardPct') : null,
      // ★ The other direction, which the record used to leave out entirely.
      castVotes: cast ? cast.downvotes : null,
      castTargets: cast ? cast.targets : 0,
      lastCast: cast?.lastCast ? new Date(cast.lastCast).toISOString() : null,
      removedFromOthersUsd: carryRemoved ? prevNum('removedFromOthersUsd') : removedFromOthersUsd,
      removedFromOthersFloor: carryRemoved,
      steemPosts: steem ? steem.posts : carrySteem ? prevNum('steemPosts') : null,
      // ★ The walk's own saturation flag. Dropping it printed a floor as a total. A carried
      // count is a floor too.
      steemPartial: steem ? steem.partial : carrySteem,
      steemLastPost: steem ? steem.lastPost : carrySteem ? ((prev.steemLastPost as string | null) ?? null) : null
    },
    // ★ PARTIAL MEANS "A QUERY DID NOT ANSWER", never "the answer was NULL" (2026-09-22).
    // A ledger whose sum is NULL (no post of this account ever paid AND survived its
    // downvotes) and a removed-by-them that is NULL for the same reason are finished
    // figures that render as "not computed"; marking them partial retried them every
    // night for nothing and kept 40-odd records "partial" indefinitely.
    partial:
      tally === null ||
      (ledger === null && !carryLedger) ||
      (steem === null && !carrySteem) ||
      cast === null ||
      (removedByThem === null && cast?.downvotes !== 0 && !carryRemoved)
  };
}

/*
 * ★★ ONE BUILD PER ACCOUNT PER PROCESS, so a profile opened in four tabs does not start
 * four identical twenty-second computations.
 */
const INFLIGHT = Symbol.for('lumen.inquisition.record.inflight.v1');
const inflight = ((globalThis as Record<symbol, unknown>)[INFLIGHT] ??= new Set<string>()) as Set<string>;

/*
 * ★★★ AND ONE BUILD PER ACCOUNT ACROSS THE THREE WORKERS (2026-09-22). The in-memory set
 * above was all there was, on the theory that two workers warming the same record is a
 * little waste. The nightly warm made it a lot: it re-asks every 20 seconds, the master
 * hands each request to the next worker, and each worker found the file still stale and
 * started its own fill. The log shows @mack-bot, @meritocracy and @spaminator each
 * computed three times, three 300-second removed-by-voter queries apiece against a
 * database we do not own. `building` was per-process too, so the script could be told
 * "done" by a worker that simply was not the one filling.
 *
 * The boards solved this already with a lock file whose mtime is the claim, re-stamped
 * while the work runs; records now take the same claim under their own key.
 */
const claimKey = (account: string) => `rec-${account}`;

/** Whether a fill for this account is running in ANY worker right now. */
export function isFilling(account: string): boolean {
  return inflight.has(account) || isClaimed(claimKey(account));
}

/** Run `work` as the one worker filling `account`; false when another already is. */
async function underClaim(account: string, work: () => Promise<void>): Promise<boolean> {
  if (inflight.has(account) || !claimBuild(claimKey(account))) return false;
  inflight.add(account);
  const beat = setInterval(() => touchClaim(claimKey(account)), HEARTBEAT_MS);
  try {
    await work();
    return true;
  } finally {
    clearInterval(beat);
    releaseBuild(claimKey(account));
    inflight.delete(account);
  }
}

/**
 * `refreshBase` recomputes the fast half too (2026-09-22). A stale record used to be
 * refilled from its STORED fast half, so the mute count, the muters' stake, KE and HP
 * were computed once at first build and never again; only the slow half moved with the
 * weekly refresh. The fast half is about a second.
 */
export function fillInBackground(account: string, base: ProfileRecord, refreshBase = false): void {
  void underClaim(account, async () => {
    try {
      const fresh = refreshBase ? await profileRecord(account).catch(() => null) : null;
      // `base` is the stored record on a refresh, so it is also what a timeout falls back to.
      const filled = await slowHalf(account, fresh ?? base, base as unknown as Record<string, unknown>);
      writeRecord(account, filled.record, true, filled.partial);
    } catch (error) {
      logger.warn(`inquisition: background record fill failed for @${account}: ${String(error)}`);
    }
  });
}

/**
 * Compute a record end to end and store it. Used by the weekly warm pass, which has no
 * reader waiting and so has no reason to return half of one. False when there is no
 * account to build or another worker is already building it.
 */
export async function buildRecord(account: string): Promise<boolean> {
  let built = false;
  await underClaim(account, async () => {
    const base = await profileRecord(account);
    if (!base) return;
    const previous = readRecord<Record<string, unknown>>(account)?.record;
    const filled = await slowHalf(account, base, previous);
    writeRecord(account, filled.record, true, filled.partial);
    built = true;
  });
  return built;
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
