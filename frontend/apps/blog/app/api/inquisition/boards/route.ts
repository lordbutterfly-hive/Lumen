import { NextResponse, type NextRequest } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { warmRecords } from '@/blog/lib/inquisition/record';
import {
  BOARD_ROWS,
  MONEY_BUDGET_MS,
  MONEY_ROWS,
  TOP_TARGET_BUDGET_MS,
  TOP_TARGET_CHUNK,
  TOP_TARGET_ROWS,
  keBoard,
  mostMuted,
  rankDownvoted,
  rankInquisitors,
  topCounterpart,
  type DownvotedRow,
  type InquisitorRow
} from '@/blog/lib/inquisition/boards-sql';
import { hiveSqlConfigured } from '@/blog/lib/inquisition/hivesql';
import { removedByVoter, removedForAuthor } from '@/blog/lib/inquisition/vote-ledger';
import { loadCrossposters, type CrosspostRow } from '@/blog/lib/inquisition/crossposting';
import {
  HEARTBEAT_MS,
  claimBuild,
  isClaimed,
  isComplete,
  isStale,
  mergeBoard,
  readBoard,
  releaseBuild,
  touchClaim,
  writeBoard,
  recordFailure,
  clearFailure,
  isFailing
} from '@/blog/lib/inquisition/board-store';
import { nowIso } from '@/blog/lib/inquisition/types';

const logger = getLogger('app');

export const dynamic = 'force-dynamic';

/**
 * ════ THE BOARDS, PUBLISHED IN STAGES ════
 *
 * ★★★ NO READER EVER WAITS ON A SLOW QUERY. Every board whose source is slower than a
 * page load is built OFF the request path: the first request starts the build and returns
 * immediately, the page polls, the rows arrive. That is the whole server-safety story for
 * this feature, and it is uniform — the muted and KE boards used to `await querySlow`
 * inline, which is 2.6s and 3.0s when HiveSQL is healthy and **245 seconds** when it is
 * not (240s request timeout + the 5s hard stop). A reader's tab must never be able to
 * hang for four minutes, and a worker must never hold a connection to somebody else's
 * free database for four minutes on their behalf.
 *
 * ★★★ AND THE BUILD IS NO LONGER ALL-OR-NOTHING, WHICH IS WHAT MADE "Counting..." LAST
 * TWENTY MINUTES. The two downvote boards are three passes of wildly different cost:
 *
 *     stage 1   the ranking, one GROUP BY over TxVotes          ~93-124s, measured
 *     stage 2   the top counterpart, one indexed TOP-1 per name  up to 4 min (budget)
 *     stage 3   the money column, one query per account          up to 14 min (budget)
 *
 * Stage 1 IS the board: account, count, targets or voters. Stages 2 and 3 are two COLUMNS
 * on it, and "this column is not computed" is a state the page already renders — a dash,
 * with a tooltip saying so. There was never a reason to withhold the ranking for eighteen
 * minutes waiting for them. Each stage now persists as it finishes (see `board-store.ts`),
 * so the rows appear in under two minutes instead of twenty, the columns fill in behind
 * them, and a restart at minute nineteen resumes instead of starting over.
 *
 * ★★ `building: true` NOW MEANS "STILL FILLING", NOT "NOTHING YET". The page polls while
 * that flag is set and renders whatever rows it has, so a reader watches the columns
 * arrive. It goes false when the last stage is done, which is when the client caches the
 * board and stops asking.
 *
 * ★★ THE QUERIES THEMSELVES LIVE IN `boards-sql.ts` AND ARE IMPORTED. They were briefly
 * copied into this file while the staged pipeline was built, because the two files were
 * being edited by different hands at once. Two copies of a query that ranks named people
 * is exactly the thing that drifts, so this route owns the ORCHESTRATION — what runs, in
 * what order, and when it is written to disk — and nothing else.
 *
 * ★★ `globalThis` IS PER WORKER PROCESS, NOT PER BOX. `cluster.js` runs three
 * `next-server` children and Node's `cluster` round-robins connections between them. The
 * claim that keeps one worker building and the file the stages are written to both live
 * on disk for exactly that reason — they are the only things the three workers share.
 *
 * ★ `force-dynamic` because the answer depends on a cache on disk, not on the request.
 * Without it Next would try to make this a static route at build time, when nothing is
 * warm and no upstream should be called.
 */

/**
 * ★★★ HOW LONG A FAILED BUILD IS LEFT ALONE, AND THIS NUMBER EXISTS BECAUSE RUNNING IT
 * WITH A DELIBERATELY WRONG HIVESQL PASSWORD EXPOSED A LOOP NO CODE READ WOULD HAVE
 * (2026-09-19).
 *
 * A failing build takes about 15s — the TDS connect timeout — and the page polls every
 * 3s. With no cooldown, the sequence is: poll sees `building`, build fails, `building`
 * goes false, the NEXT poll finds nothing fresh and starts another one, and reports
 * `building: true` again. Two consequences, both bad and neither visible in the code: the
 * reader never once sees the "could not be read" line that was written for exactly this
 * case — they get "Counting…" forever — and every polling tab opens a fresh connection to
 * somebody else's database every fifteen seconds, indefinitely.
 *
 * A minute of quiet after a failure fixes both: the reader is told the truth, and a
 * degraded HiveSQL is asked four times an hour instead of two hundred and forty. It is
 * applied by backdating the claim — see `releaseBuild`, which is where the constant was
 * never actually wired up before.
 */
/*
 * ★★★ THE TUNING CONSTANTS LIVE IN `boards-sql.ts` AND ARE IMPORTED, BECAUSE THIS FILE
 * USED TO KEEP ITS OWN COPIES AND THE COPIES SILENTLY WON (found 2026-09-20).
 *
 * `TOP_TARGET_ROWS`, `TOP_TARGET_CHUNK`, `TOP_TARGET_BUDGET_MS`, `MONEY_ROWS` and
 * `MONEY_BUDGET_MS` were declared in both files. Two of them had DIFFERENT values —
 * chunk 1 vs 4, and a 10-minute vs a 4-minute budget — and because `serve()` passes this
 * file's copies to `topCounterpart`, tuning the ones next to the query did nothing at
 * all. A whole round of "fixed the chunk size" was dead on arrival and the only reason
 * it surfaced is that a new log line printed four names in a chunk that was supposed to
 * hold one.
 *
 * Do not re-declare them here. A constant with two homes has no value, only a winner.
 */
const RETRY_AFTER_FAIL_MS = 60 * 1000;

/**
 * ════ THE SAME BUDGETS AS BEFORE, AND THEY ARE NOT NEGOTIABLE ════
 *
 * These are the wall clocks that stop one runaway account eating a whole build.
 * @spaminator has 1,769,156 downvotes to aggregate and a small account has a few hundred,
 * so the cost per row is two orders of magnitude uneven; without a budget the first two
 * rows consume everything and twenty-eight report nothing. Staging changes WHEN the work
 * is published, not how much of it is allowed to run.
 *
 * What staging does change is the consequence of hitting one: a budget that expires now
 * leaves a stored board with that column partly filled, instead of discarding the whole
 * build. Measured 2026-09-19: the 4-minute counterpart budget stopped the inquisitor
 * board at 20 of 25 rows and the downvoted board at 8 of 25. Those rows carry a real
 * counterpart; the rest report none, and the column header says so.
 */

/**
 * ★★ HOW OFTEN THE MONEY STAGE WRITES WHAT IT HAS. One account is ~19s, so three is about
 * a minute of work at risk from a kill — and a merge is a read, a patch of a 100-row
 * array and an atomic rename, which is far too cheap to be worth batching harder than
 * that. Every attempted account is recorded in the same write, so a restart resumes at
 * the next one rather than re-running the ones already paid for.
 */
const MONEY_FLUSH_EVERY = 3;

/**
 * ════ WHAT A BOARD IS, IN STAGES ════
 *
 * A board with `stages: 1` is a single query and publishes once. The two downvote boards
 * declare all three; every stage past the first is optional and may be skipped, budgeted
 * out or left half-done without costing the ones before it.
 */
interface StagedBoard<T> {
  /** How many stages this board has. Reaching this number is what "complete" means. */
  stages: number;
  /** Stage 1. `null` means the database did not answer; nothing is stored. */
  rank: () => Promise<{ rows: T[]; asOf: string } | null>;
  accountOf?: (row: T) => string;
  counterpart?: {
    direction: 'by-voter' | 'by-author';
    rows: number;
    merge: (row: T, top: { name: string; n: number }) => T;
  };
  money?: {
    kind: 'voter' | 'author';
    /**
     * A proxy for how expensive this row will be, used to attempt the cheap ones first.
     * The vote count is exactly that proxy: the query groups every one of them.
     */
    costOf?: (row: T) => number;
    rows: number;
    merge: (row: T, usd: number) => T;
  };
  /**
   * Copy the previous build's computed columns onto a freshly ranked row for the same
   * account, so a refresh never serves less than what it replaced. See stage 1.
   */
  carry?: (fresh: T, previous: T) => T;
}

/**
 * Run the stages that are not on disk yet, persisting after each one.
 *
 * ★★★ WHERE IT STARTS IS READ FROM THE FILE, NOT FROM MEMORY, which is the entire point:
 * a process that died during stage 3 left a stored board at `stage: 2` with twelve
 * accounts in `done`, and this picks it up at the thirteenth. A board that has gone stale
 * starts again from stage 1 instead, because then it is the DATA that is old, not the
 * build that is unfinished.
 */
async function buildStaged<T>(key: string, spec: StagedBoard<T>): Promise<void> {
  const accountOf = spec.accountOf;
  const stored = readBoard<T>(key);
  const resumable = stored !== null && !isStale(stored) && typeof stored.stage === 'number';
  let stage = resumable ? (stored?.stage ?? 0) : 0;

  // ── Stage 1: the ranking. Store and serve immediately.
  if (stage < 1) {
    const ranked = await spec.rank();
    // ★ AN UNANSWERED OR EMPTY RANKING IS A FAILED BUILD, NOT AN EMPTY BOARD. Throwing
    // here leaves yesterday's file in place and puts the retry behind a cooldown.
    if (!ranked || ranked.rows.length === 0) throw new Error(`rank failed: ${key}`);
    /*
     * ★★★ LAST WEEK'S COLUMNS ARE CARRIED ONTO THIS WEEK'S RANKING (found by audit,
     * 2026-09-20). A REFRESH MUST NEVER BE A DOWNGRADE.
     *
     * Stage 1 replaces the rows, and the fresh ranking has `removedUsd: null` and
     * `topSource: ''` on every one of them. Two consequences, both shipped:
     *
     *   - Every healthy weekly rebuild blanked the money column for the 15-25 minutes
     *     stages 2 and 3 take, on a board that had those figures a second earlier.
     *   - A rebuild whose later stages all failed marked itself complete with an empty
     *     money column and stamped it with today's date — so a week of good data was
     *     replaced by nothing, and the nothing was then served for another week.
     *
     * Carrying the old values across by ACCOUNT costs one map and means the worst a bad
     * refresh can do is leave last week's figures in place, which is exactly what the
     * comment on the failure path already promised was happening.
     */
    let rows = ranked.rows;
    const carry = spec.carry;
    if (carry && accountOf && stored?.rows?.length) {
      const previous = new Map(stored.rows.map((row) => [accountOf(row), row]));
      rows = rows.map((row) => {
        const old = previous.get(accountOf(row));
        return old ? carry(row, old) : row;
      });
    }
    writeBoard<T>(key, rows, ranked.asOf, { stage: 1, stages: spec.stages, done: [] });
    stage = 1;
  }

  // ── Stage 2: the counterpart column, merged into the rows already being served.
  if (stage < 2 && spec.counterpart && accountOf) {
    const rows = readBoard<T>(key)?.rows ?? [];
    const names = rows.slice(0, spec.counterpart.rows).map(accountOf);
    const best = await topCounterpart(
      names,
      spec.counterpart.direction,
      TOP_TARGET_BUDGET_MS,
      TOP_TARGET_CHUNK
    ).catch(() => new Map<string, { name: string; n: number }>());
    /*
     * ★★ THE STAGE IS MARKED DONE EVEN IF THE PASS FOUND NOTHING. The budget expiring, or
     * HiveSQL refusing every chunk, both mean this pass has had its turn; re-running it on
     * every poll would be the retry loop the cooldown exists to prevent. The column stays
     * empty — which reads as "not computed" — until the next full refresh.
     */
    mergeBoard<T>(
      key,
      (current) =>
        current.map((row) => {
          const top = best.get(accountOf(row));
          return top ? spec.counterpart!.merge(row, top) : row;
        }),
      { stage: 2 }
    );
    stage = 2;
  } else if (stage < 2 && spec.stages >= 2) {
    stage = 2;
  }

  // ── Stage 3: the money column, one account at a time, flushed as it goes.
  if (stage < 3 && spec.money && accountOf) {
    const from = readBoard<T>(key);
    if (!from) throw new Error(`lost between stages: ${key}`);
    const done = new Set<string>(from.done ?? []);
    /*
     * ★★★ CHEAPEST FIRST, BECAUSE THE GIANTS AT THE TOP SPEND THE BUDGET AND RETURN
     * NOTHING (found live 2026-09-20, owner: "the top inquisitior pages arent warm and
     * seem the same").
     *
     * The money pass used to walk the board in board order, and on TOP INQUISITORS the
     * board order IS the cost order: @spaminator with 1,745,482 downvotes, @mack-bot with
     * 545,424, @adm, @blacklist-a. Each one burns the full `PER_ACCOUNT_MS` and produces
     * `null`, so the first four rows ate ten of the fourteen budgeted minutes and the
     * column came out empty at the top -- five identical dashes where the most
     * interesting numbers on the board should be.
     *
     * Ordering by cost values the most rows per minute of somebody else's database. The
     * giants are attempted LAST, with whatever is left; if the budget runs out before
     * they are reached they are never marked `done`, so the next pass resumes with
     * exactly them and a fresh budget. Nothing is skipped, the cheap rows simply stop
     * being held hostage.
     */
    const costOf = spec.money.costOf ?? (() => 0);
    const queue = from.rows
      .slice(0, spec.money.rows)
      .filter((row) => !done.has(accountOf(row)))
      .sort((a, b) => costOf(a) - costOf(b))
      .map(accountOf);

    const deadline = Date.now() + MONEY_BUDGET_MS;
    const found = new Map<string, number>();
    let unflushed = 0;

    const flush = (finished: boolean): void => {
      mergeBoard<T>(
        key,
        (current) =>
          current.map((row) => {
            const usd = found.get(accountOf(row));
            return usd === undefined ? row : spec.money!.merge(row, usd);
          }),
        { stage: finished ? 3 : 2, done: [...done] }
      );
      found.clear();
      unflushed = 0;
    };

    /*
     * ★★★ RUNNING OUT OF BUDGET IS NOT FINISHING, AND CALLING IT FINISHING COST THE
     * MONEY COLUMN A WHOLE WEEK AT A TIME (found by audit, 2026-09-20).
     *
     * `flush(true)` used to run unconditionally after this loop, including when the loop
     * exited on the deadline. Measured on a cold process: the ledger cache starts empty,
     * each of these accounts takes up to `PER_ACCOUNT_MS`, and the 14-minute budget
     * reached **4 of 30** rows — which was then written with `stage: 3`, marked
     * complete, stamped with today's date and served untouched for seven days. A warm
     * process had filled 27 minutes earlier, so whether the board was any good came down
     * to whether the box had been restarted.
     *
     * The machinery to do this properly was already here and unused: `done` persists on
     * disk, so a board left at stage 2 resumes on the next poll with exactly the
     * accounts it has not attempted. It converges over a few passes instead of freezing
     * a bad first attempt for a week.
     */
    let outOfBudget = false;

    for (const name of queue) {
      // ★ THE WALL CLOCK STAYS. Whatever is reached carries a figure; the rest report
      // null, which renders as a dash. A number covering a fraction of an account is
      // worse than no number.
      if (Date.now() >= deadline) {
        outOfBudget = true;
        break;
      }
      let value: number | null = null;
      try {
        value =
          spec.money.kind === 'voter'
            ? await removedByVoter(name)
            // ★ The lean one-query form, not the whole profile ledger. See
            // `removedForAuthor`: this used to run three CTEs and use one of them.
            : await removedForAuthor(name);
      } catch {
        // One unreadable account does not fail the column for the rest.
      }
      // ★ ATTEMPTED, NOT ANSWERED. An account that timed out is recorded as done so a
      // restart does not spend the whole budget on the one row that cannot finish.
      done.add(name);
      if (value !== null) found.set(name, value);
      unflushed += 1;
      if (unflushed >= MONEY_FLUSH_EVERY) flush(false);
    }
    /*
     * ★★ A FINISHED MONEY BOARD WARMS ITS OWN TOP ROWS. Every row here is a link to a
     * profile, and this is the moment we know which twenty they are. Bounded and
     * skip-if-fresh, so a resumed build does not redo it. See `warmRecords`.
     */
    if (!outOfBudget && accountOf) {
      const top = (readBoard<T>(key)?.rows ?? []).map(accountOf);
      void warmRecords(top).catch((error) =>
        logger.warn(`inquisition: record warm for "${key}" failed: ${String(error)}`)
      );
    }
    if (outOfBudget) {
      logger.warn(
        `inquisition: "${key}" money pass ran out of budget with ${queue.length - done.size} ` +
          `of ${queue.length} accounts unattempted — staying incomplete so the next poll resumes`
      );
    }
    flush(!outOfBudget);
  }
}

/**
 * ════ ONE BOARD, BUILT ONCE, SERVED FROM DISK ════
 *
 * ★★★ THE READER IS NEVER MADE TO WAIT FOR A BUILD. Whatever is on disk is served
 * immediately, however old and however incomplete; a stale or unfinished board kicks a
 * build behind the response. See `board-store.ts` for why this is a file and not process
 * memory: three workers share it, and it survives a deploy.
 *
 * ★★ A BUILD THAT FINDS NOTHING NEVER OVERWRITES A GOOD BOARD. Stage 1 throws rather than
 * storing an empty ranking, so a failed or degraded refresh leaves yesterday's answer in
 * place rather than blanking the board and stamping it with today's date. That failure
 * mode cost this feature a full day of "Nothing to confess." once already.
 */
interface Building {
  running: boolean;
}
const BUILDING = Symbol.for('lumen.inquisition.building.v3');
const building = ((globalThis as Record<symbol, unknown>)[BUILDING] ??= {}) as Record<string, Building>;

function refreshInBackground<T>(key: string, spec: StagedBoard<T>): void {
  const state = (building[key] ??= { running: false });
  if (state.running) return;
  // ★ One worker builds; the others serve what is on disk.
  if (!claimBuild(key)) return;
  state.running = true;
  /*
   * ★★★ THE CLAIM IS KEPT ALIVE FOR AS LONG AS THE BUILD IS. The lock is a file with no
   * owner, so the only way to tell a running build from a killed one is that a running one
   * keeps saying so. Without this the claim would have to be longer than the longest
   * build, and a worker killed at second one would hold the board hostage for the rest of
   * that window — which, now that stages persist, would mean rows on disk and nobody left
   * to finish their columns.
   */
  const beat = setInterval(() => touchClaim(key), HEARTBEAT_MS);
  if (typeof beat.unref === 'function') beat.unref();
  void (async () => {
    try {
      await buildStaged(key, spec);
      // A build that got through is the end of any failure streak.
      clearFailure(key);
    } catch (error) {
      /*
       * ★★★ SAY SO. A BUILD THAT FAILS FOREVER USED TO DO IT IN COMPLETE SILENCE
       * (2026-09-20).
       *
       * The ranking query takes ~117s against an unloaded HiveSQL and the ceiling was
       * 240s, which is fine until the shared server has a slow ten minutes. Then the
       * query times out, `rankDownvoted` returns `null`, this throws, the cooldown
       * expires, and it all happens again — every five minutes, indefinitely, with no
       * log line anywhere. The board simply stayed empty and kept saying "building". It
       * was found by listing TCP connections to port 1433, which is not a diagnostic
       * anybody should need.
       */
      logger.error(
        error,
        `inquisition: board build failed for "${key}" — retrying after ${RETRY_AFTER_FAIL_MS}ms`
      );
      // ★ AND LEAVE A MARK. The cooldown keeps `isClaimed` true, so without this the
      // board reports "building" through every failure and a reader watches a spinner
      // forever against a database that is plainly down. See `recordFailure`.
      recordFailure(key);
      // ★ A COOLDOWN, NOT AN IMMEDIATE RELEASE — see RETRY_AFTER_FAIL_MS.
      releaseBuild(key, RETRY_AFTER_FAIL_MS);
    } finally {
      clearInterval(beat);
      state.running = false;
    }
  })();
}

/**
 * Serve a board: disk first, build behind.
 *
 * ★★ `building` MEANS "THERE IS MORE COMING", WHETHER OR NOT THERE ARE ROWS YET. The page
 * polls while it is set and renders whatever it has, so a board that is on stage 3 shows
 * its ranking and watches the money column fill. It is false only when every stage is
 * done, which is the point at which the client caches the answer and stops asking.
 */
function serve<T>(board: string, key: string, spec: StagedBoard<T>): NextResponse {
  const stored = readBoard<T>(key);
  const complete = isComplete(stored);
  if (isStale(stored) || !complete) refreshInBackground(key, spec);

  /*
   * ★★ NO ROWS PLUS "NOT BUILDING" IS THE ONE COMBINATION THAT LIES, because the page
   * renders it as "Nothing to confess." The claim is held on disk, so a build running on
   * another worker — or one stranded by a restart and not yet expired — still counts as
   * building here. The reader waits; they are never told the chain is clean.
   */
  const inFlight = building[key]?.running === true || isClaimed(key);

  if (!stored) {
    /*
     * ★★ NOTHING ON DISK AND A FAILURE STREAK IS `unavailable`, NOT `building`. The
     * client already knows how to render that ("the chain declines to testify"); it was
     * simply unreachable, because the cooldown keeps the claim warm and the claim was
     * the only thing `building` looked at.
     */
    if (isFailing(key)) {
      return NextResponse.json(
        { board, rows: [], building: false, unavailable: true },
        { headers: { 'cache-control': 'no-store' } }
      );
    }
    return NextResponse.json({ board, rows: [], building: inFlight }, { headers: { 'cache-control': 'no-store' } });
  }
  return NextResponse.json(
    {
      board,
      rows: stored.rows,
      asOf: stored.asOf,
      building: !complete && inFlight,
      // ★ The reader is told when they are looking at a copy that is being refreshed.
      refreshing: isStale(stored),
      // ★ Which stage the rows on screen have reached, for anyone debugging a half-filled
      // column. The page does not need it; the person asking "why is that a dash" does.
      stage: stored.stage ?? spec.stages,
      stages: spec.stages
    },
    {
      /*
       * ★★ A BOARD THAT IS STILL FILLING MUST NOT BE CACHED BY THE BROWSER. The page polls
       * every 3-10s; a minute of `max-age` on an incomplete board would hand every poll
       * the same half-built body back out of the HTTP cache and the columns would appear
       * to freeze until the tab was reloaded. (`middleware.ts` also stamps `private,
       * no-store` on this route, so this is belt and braces rather than the only guard.)
       */
      headers: { 'cache-control': complete ? 'private, max-age=60' : 'no-store' }
    }
  );
}

function unconfigured(board: string): NextResponse {
  // ★ NO `asOf` ON A FAILURE. A fresh "Indexed <now>" under an empty board is a freshness
  // claim about data we do not have.
  return NextResponse.json({ board, rows: [], unconfigured: true }, { headers: { 'cache-control': 'no-store' } });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const board = params.get('board') ?? 'ke';
  /*
   * ★★ THERE IS NO DEEP TIER ANY MORE. Every board is built to `BOARD_ROWS` once and
   * served from disk, so SHOW MORE reveals rows the reader already has instead of
   * triggering a second, more expensive query.
   */

  try {
    /*
     * ★★★ THERE IS NO BLACKLIST BOARD (owner, 2026-09-19: "remove the blacklists from
     * mode and bar. it wont work, we add that later").
     */
    /*
     * ★★ HIVESQL ANSWERS THIS ONE AND NOTHING ELSE CAN. `Mutes(muter, muted)` is the
     * reverse lookup the spec called impossible and HAF genuinely cannot serve — it
     * indexes a `custom_json` against its sender. Measured 2.6s with the stake join and
     * both leaderboard floors applied in SQL. One stage: the query IS the board.
     */
    if (board === 'muted') {
      if (!hiveSqlConfigured()) return unconfigured(board);
      return serve(board, 'muted', {
        stages: 1,
        rank: async () => {
          const { rows, asOf, failed } = await mostMuted(BOARD_ROWS);
          return failed ? null : { rows, asOf };
        }
      });
    }

    if (board === 'ke') {
      if (!hiveSqlConfigured()) return unconfigured(board);
      return serve(board, 'ke', {
        stages: 1,
        rank: async () => {
          const { rows, asOf, failed } = await keBoard(BOARD_ROWS);
          return failed ? null : { rows, asOf };
        }
      });
    }

    /*
     * ★★★ THREE STAGES, AND THE FIRST ONE IS THE BOARD. ~93s for the full-history
     * aggregate, then the heaviest downvoter per row, then what each row's posts lost.
     * Nothing about any of that belongs on a request, and nothing about the last two
     * justifies withholding the first.
     */
    if (board === 'downvoted') {
      if (!hiveSqlConfigured()) return unconfigured(board);
      return serve<DownvotedRow>(board, 'downvoted', {
        stages: 3,
        rank: rankDownvoted,
        accountOf: (row) => row.account,
        counterpart: {
          direction: 'by-author',
          rows: TOP_TARGET_ROWS,
          merge: (row, top) => ({ ...row, topSource: top.name, topSourceVotes: top.n })
        },
        money: {
          // ★ BY AUTHOR: what THIS account's posts lost, summed from the posts themselves.
          kind: 'author',
          rows: MONEY_ROWS,
          // ★ Same reason as the inquisitors board: @gangstalking's 234,242 received
          // downvotes are the top row and the most expensive query on the board.
          costOf: (row) => row.downvotes,
          merge: (row, usd) => ({ ...row, removedUsd: usd })
        },
        // ★ Keep what last week already proved about this account until this week
        // recomputes it. See stage 1.
        carry: (fresh, previous) => ({
          ...fresh,
          topSource: previous.topSource || fresh.topSource,
          topSourceVotes: previous.topSource ? previous.topSourceVotes : fresh.topSourceVotes,
          removedUsd: previous.removedUsd ?? fresh.removedUsd
        })
      });
    }

    if (board === 'inquisitors') {
      if (!hiveSqlConfigured()) return unconfigured(board);
      return serve<InquisitorRow>(board, 'inquisitors', {
        stages: 3,
        rank: rankInquisitors,
        accountOf: (row) => row.account,
        counterpart: {
          direction: 'by-voter',
          rows: TOP_TARGET_ROWS,
          merge: (row, top) => ({ ...row, topTarget: top.name, topTargetVotes: top.n })
        },
        money: {
          /*
           * ★★★ SCOPED BY THE VOTER, NOT BY A SEED OF VICTIMS. Summing each voter's
           * removals over a fixed ~40-account seed gave @themarkymark $881 where the truth
           * is tens of thousands, because that seed covered 1.2% of his 3,442 targets.
           */
          kind: 'voter',
          rows: MONEY_ROWS,
          costOf: (row) => row.downvotes,
          merge: (row, usd) => ({ ...row, removedUsd: usd })
        },
        // ★ Keep what last week already proved about this account until this week
        // recomputes it. See stage 1.
        carry: (fresh, previous) => ({
          ...fresh,
          topTarget: previous.topTarget || fresh.topTarget,
          topTargetVotes: previous.topTarget ? previous.topTargetVotes : fresh.topTargetVotes,
          removedUsd: previous.removedUsd ?? fresh.removedUsd
        })
      });
    }

    if (board === 'crossposting') {
      if (!hiveSqlConfigured()) return unconfigured(board);
      /*
       * ★ CROSSPOSTING CARRIES ITS OWN SCOPE NUMBERS, so they ride along inside the stored
       * rows' sibling fields rather than in separate process memory that a restart would
       * lose while the rows survived.
       */
      const res = serve<CrosspostRow & { _matched?: number; _listed?: number }>(board, 'crossposting', {
        stages: 1,
        rank: async () => {
          // ★ Last build's rows stay candidates, so who is on the board does not depend on
          // the hour it was rebuilt. The stored board is still the previous one here.
          const carried = (readBoard<CrosspostRow>('crossposting')?.rows ?? []).map((r) => ({
            account: r.account,
            steemPosts: r.steemPosts
          }));
          const { rows, candidates, matched, failed } = await loadCrossposters(BOARD_ROWS, carried);
          if (failed || rows.length === 0) return null;
          /*
           * ★★ THE BOARD-LEVEL COUNTS RIDE ON EVERY ROW, NOT ON ROW ZERO. Stashing them
           * on `rows[0]` made the first array element mean something the others did not,
           * which is only safe while this board stays one stage, never re-sorted and
           * never merged — three properties nothing enforces and every sibling board has
           * already lost. Writing the same two numbers on every row costs a few bytes and
           * cannot be broken by a sort.
           */
          const tagged = rows.map((r) => ({ ...r, _matched: matched, _listed: candidates }));
          return { rows: tagged, asOf: nowIso() };
        }
      });
      const body = (await res.json()) as { rows?: (CrosspostRow & { _matched?: number; _listed?: number })[] };
      const head = body.rows?.[0];
      return NextResponse.json(
        { ...body, scope: body.rows?.length ?? 0, matched: head?._matched, listed: head?._listed },
        { headers: { 'cache-control': res.headers.get('cache-control') ?? 'no-store' } }
      );
    }

    return NextResponse.json({ error: 'unknown board' }, { status: 400 });
  } catch {
    /*
     * ★ A FAILED BOARD IS AN EMPTY BOARD WITH A REASON, NOT A 500. The page renders the
     * other boards and says this one could not be read, which is both more useful than an
     * error page and closer to the truth: the chain did not answer, Lumen did not break.
     */
    return NextResponse.json(
      { board, rows: [], unavailable: true },
      { status: 200, headers: { 'cache-control': 'no-store' } }
    );
  }
}
