import { NextResponse, type NextRequest } from 'next/server';
import { blacklistIndex } from '@/blog/lib/inquisition/blacklists';
import { keBoard, mostDownvoted, mostMuted } from '@/blog/lib/inquisition/boards-sql';
import { hiveSqlConfigured } from '@/blog/lib/inquisition/hivesql';
import { steemActivity } from '@/blog/lib/inquisition/steem';
import { nowIso } from '@/blog/lib/inquisition/types';

export const dynamic = 'force-dynamic';

/**
 * ════ THE BOARDS, SERVED FROM ONE AGGREGATE EACH ════
 *
 * ★★★ NO READER EVER WAITS ON A SLOW QUERY. Every board whose source is slower than a
 * page load is built OFF the request path: the first request starts the build and
 * returns immediately with `building: true`, the page polls, the rows arrive. That is
 * the whole server-safety story for this feature, and it is now uniform — the muted and
 * KE boards used to `await querySlow` inline, which is 2.6s and 3.0s when HiveSQL is
 * healthy and **245 seconds** when it is not (240s request timeout + the 5s hard stop).
 * A reader's tab must never be able to hang for four minutes, and a worker must never
 * hold a connection to somebody else's free database for four minutes on their behalf.
 *
 * ★★ `globalThis` IS PER WORKER PROCESS, NOT PER BOX, and an earlier comment here
 * claimed otherwise (found by adversarial review, 2026-09-19). `cluster.js` runs three
 * `next-server` children and Node's `cluster` round-robins connections between them, so
 * every slot below is really three slots and every "one build" is up to three. The
 * budget numbers in this file are stated per worker for that reason. What `globalThis`
 * DOES buy is one slot per worker instead of one per webpack layer, which is the
 * difference between three builds and nine.
 *
 * ★★ AND IT IS WHY A POLL CAN GO BACKWARDS. Consecutive polls land on different
 * workers, so a reader can see 7 rows from worker A and then 0 from worker B, which is
 * exactly the flicker observed in testing. The server cannot fix that alone — the
 * client keeps the fullest answer it has seen (see `inquisition-board.tsx`).
 *
 * ★ `force-dynamic` because the answer depends on caches that live in this process,
 * not on the request. Without it Next would try to make this a static route at build
 * time, when no cache is warm and no upstream should be called.
 */

/**
 * ★★ THE STEEM SCOPE IS A PREFIX OF THE LISTED SET, AND THE UI SAYS SO. 45 was sized
 * when the board read one list type; the bridge fix roughly doubled the listed set, and
 * `index.accounts` is sorted alphabetically, so this is the first 45 names in
 * alphabetical order — not the worst 45 and not a sample. The board prints the scope
 * and the total beside it rather than implying it covered everyone.
 */
const MAX_STEEM_LOOKUPS = 45;

/**
 * ★★★ A HARD CEILING ON REQUESTS TO SOMEBODY ELSE'S CHAIN, PER BUILD. The prose here
 * used to claim "45 requests a day" and the code could not honour it: `steem.ts` walks
 * up to `MAX_PAGES` pages per account and retries the second endpoint on every failure,
 * so the true worst case was 45 × 12 × 2 = 1,080 per build per worker — 24× the stated
 * budget, 3,240 a day across the cluster. A number in a comment is not a bound. This
 * one is: the build stops when it is spent, and the board is marked partial.
 */
const STEEM_REQUEST_BUDGET = 220;

const REBUILD_MS = 24 * 60 * 60 * 1000;
const SQL_REBUILD_MS = 6 * 60 * 60 * 1000;

/**
 * ★★★ HOW LONG A FAILED BUILD IS LEFT ALONE, AND THIS NUMBER EXISTS BECAUSE RUNNING IT
 * WITH A DELIBERATELY WRONG HIVESQL PASSWORD EXPOSED A LOOP NO CODE READ WOULD HAVE
 * (2026-09-19).
 *
 * A failing build takes about 15s — the TDS connect timeout — and the page polls every
 * 3s. With no cooldown, the sequence is: poll sees `building`, build fails, `building`
 * goes false, the NEXT poll finds nothing fresh and starts another one, and reports
 * `building: true` again. Two consequences, both bad and neither visible in the code:
 * the reader never once sees the "could not be read" line that was written for exactly
 * this case — they get "Counting…" forever — and every polling tab opens a fresh
 * connection to somebody else's database every fifteen seconds, indefinitely.
 *
 * A minute of quiet after a failure fixes both: the reader is told the truth, and a
 * degraded HiveSQL is asked four times an hour instead of two hundred and forty.
 */
const RETRY_AFTER_FAIL_MS = 60 * 1000;

interface SteemRow {
  account: string;
  postsSinceFork: number;
  lastPost: string | null;
  partial: boolean;
}

/**
 * ════ ONE BACKGROUND BOARD ════
 *
 * ★★★ `builtAt` AND `asOf` ARE ONLY STAMPED BY A BUILD THAT PRODUCED ROWS, and that is
 * the fix for this feature's worst failure mode (found by adversarial review,
 * 2026-09-19). The Steem build used to set both unconditionally at the end of the loop.
 * So on a worker where api.steemit.com was down, all 45 lookups fell into the catch,
 * `rows` stayed empty — and the build still stamped `builtAt = now`. The board then
 * answered **"Nothing to confess." Indexed \<now\>** for a full 24 hours, because the
 * freshness guard refused to rebuild. A confident, freshly timestamped negative claim
 * about named human accounts, produced by the single most likely upstream failure.
 *
 * `lastFailed` carries the other half: an attempt that finished with nothing is
 * reported as `unavailable`, never as an empty answer, and the next reader retries.
 */
interface BoardState<T> {
  rows: T[];
  building: boolean;
  /** Only ever set by a build that produced at least one row. */
  builtAt: number;
  /** Only ever set alongside `rows`. `null` means "we have never had an answer". */
  asOf: string | null;
  /** The most recent finished attempt produced nothing. */
  lastFailed: boolean;
  /** When that attempt gave up. Retries are held off for `RETRY_AFTER_FAIL_MS`. */
  failedAt: number;
}

function slot<T>(key: string): BoardState<T> {
  const sym = Symbol.for(`lumen.inquisition.board.${key}.v2`);
  return ((globalThis as Record<symbol, unknown>)[sym] ??= {
    rows: [],
    building: false,
    builtAt: 0,
    asOf: null,
    lastFailed: false,
    failedAt: 0
  }) as BoardState<T>;
}

/**
 * Starts a build if one is not running and the last good answer has expired.
 * `run` resolves with the rows, or `null` for "we could not ask".
 */
function startBuild<T>(state: BoardState<T>, ttlMs: number, run: () => Promise<T[] | null>): void {
  const now = Date.now();
  const fresh = state.builtAt > 0 && now - state.builtAt < ttlMs;
  const coolingOff = state.lastFailed && now - state.failedAt < RETRY_AFTER_FAIL_MS;
  if (state.building || fresh || coolingOff) return;
  state.building = true;
  void (async () => {
    try {
      const rows = await run();
      if (rows && rows.length > 0) {
        state.rows = rows;
        state.builtAt = Date.now();
        state.asOf = nowIso();
        state.lastFailed = false;
        state.failedAt = 0;
      } else {
        // ★ Keep whatever we had. A failed rebuild must not blank a board that was
        // answering, and it must not restamp yesterday's rows with today's time.
        state.lastFailed = true;
        state.failedAt = Date.now();
      }
    } catch {
      state.lastFailed = true;
      state.failedAt = Date.now();
    } finally {
      // ★ `finally`, so no escape can pin `building` and freeze the board forever.
      state.building = false;
    }
  })();
}

/**
 * ★ AN EMPTY BOARD IS ONLY EVER "NOTHING TO CONFESS" IF WE ACTUALLY ASKED AND GOT
 * NOTHING. Otherwise it is `unavailable`, and the page says so.
 */
function boardResponse<T>(board: string, state: BoardState<T>): NextResponse {
  const unavailable = state.rows.length === 0 && !state.building && state.lastFailed;
  return NextResponse.json(
    {
      board,
      rows: state.rows,
      asOf: state.asOf ?? undefined,
      building: state.building,
      ...(unavailable ? { unavailable: true } : {})
    },
    { headers: { 'cache-control': 'private, max-age=30' } }
  );
}

const mutedState = slot<{ account: string; mutedBy: number; muterMvests: number }>('muted');
const keState = slot<{ account: string; ke: number; rewardsHive: number; hp: number; band: string }>('ke');
const dvState = slot<{ account: string; downvotes: number; voters: number }>('downvoted');
const steemState = slot<SteemRow>('steem');

/**
 * ★★★ THE STEEM BUILD, WITH ITS BUDGET IN ITS HAND. Measured 30.2s cold: forty-five
 * accounts, one to twelve requests each to a chain we do not run, done sequentially so
 * we are not hammering it. A tab click cannot cost that, and forty readers clicking it
 * cannot cost it forty times over — so it runs here, once, and the rows arrive on a
 * poll. `steemActivity` caches each account for a day on top of that.
 */
function startSteemBuild(accounts: string[]): void {
  const now = Date.now();
  const fresh = steemState.builtAt > 0 && now - steemState.builtAt < REBUILD_MS;
  const coolingOff = steemState.lastFailed && now - steemState.failedAt < RETRY_AFTER_FAIL_MS;
  if (steemState.building || fresh || coolingOff) return;
  steemState.building = true;
  void (async () => {
    const rows: SteemRow[] = [];
    let budget = STEEM_REQUEST_BUDGET;
    let truncated = false;
    try {
      for (const account of accounts) {
        if (budget <= 0) {
          truncated = true;
          break;
        }
        try {
          const activity = await steemActivity(account);
          budget -= activity.requests || 1;
          if (activity.postsSinceFork > 0) {
            rows.push({
              account,
              postsSinceFork: activity.postsSinceFork,
              lastPost: activity.lastPost,
              partial: activity.partial
            });
            /*
             * Publish as we go, so a reader polling sees the board fill rather than
             * staring at an empty panel for half a minute.
             *
             * ★ COMPLETE ROWS RANK ABOVE CAPPED ONES. A capped row's number is a floor,
             * so ordering a `298+` above an exact `62` asserts a comparison we cannot
             * make. Capped rows still appear, below, still marked `+`.
             */
            steemState.rows = [...rows].sort((a, b) => {
              if (a.partial !== b.partial) return a.partial ? 1 : -1;
              return b.postsSinceFork - a.postsSinceFork;
            });
            steemState.asOf = nowIso();
            steemState.lastFailed = false;
          }
        } catch {
          // An endpoint that will not answer is not a fact about the account.
        }
      }
    } finally {
      steemState.building = false;
      if (rows.length > 0) {
        // ★ Only a build that found something may claim today's date — see BoardState.
        steemState.builtAt = truncated ? 0 : Date.now();
        steemState.asOf = nowIso();
        steemState.lastFailed = false;
        steemState.failedAt = 0;
      } else {
        steemState.lastFailed = true;
        steemState.failedAt = Date.now();
      }
    }
  })();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const board = new URL(request.url).searchParams.get('board') ?? 'blacklists';

  try {
    if (board === 'blacklists') {
      /*
       * ★★★ THE SQL PATH FOR THIS BOARD IS GONE, AND IT WAS WRONG IN THE EXACT WAY
       * `blacklists.ts` WARNS ABOUT (found by adversarial review, 2026-09-19).
       *
       * HiveSQL's `Blacklists` table carries only the BLACKLISTED list type, and this
       * route hardcoded `kind: 'blacklisted'`. Two of the four publishers do not use
       * that type. Measured against api.hive.blog:
       *
       *     hivewatchers   blacklisted  0   muted 27
       *     steemcleaners  blacklisted  0   muted 13
       *     spaminator     blacklisted 35   muted  1
       *     buildawhale    blacklisted  9   muted  2
       *
       * So the board showed 45 marks from two publishers and silently dropped 40 marks
       * from the other two — including hivewatchers, the best-known publisher on Hive.
       * Worse, an early return on `rows.length > 0` meant the bridge fallback that DOES
       * read both types could never run. The lesson was written down in one module and
       * lost in the next one; the `LIST` column read "blacklisted" on every row,
       * carrying no information at all.
       *
       * `bridge.get_follow_list` reads both types per publisher, names the publisher,
       * and costs eight cached requests every six hours. It is simply the better
       * source here, so it is the only source here. HiveSQL keeps the two jobs it
       * alone can do: the muted board and the per-account marks.
       */
      const index = await blacklistIndex();
      const rows = index.accounts.map((account) => ({
        account,
        marks: index.byAccount.get(account) ?? []
      }));
      return NextResponse.json(
        {
          board,
          rows,
          asOf: index.asOf,
          // ★ THE READER IS TOLD WHEN THE PICTURE IS INCOMPLETE. This was computed and
          // then thrown away: a publisher whose read failed produced a shorter board
          // with a fresh timestamp and no hint that anything was missing.
          missing: index.missing,
          source: 'bridge'
        },
        { headers: { 'cache-control': 'private, max-age=60' } }
      );
    }

    /*
     * ★★ HIVESQL ANSWERS THIS ONE AND NOTHING ELSE CAN. `Mutes(muter, muted)` is the
     * reverse lookup the spec called impossible and HAF genuinely cannot serve — it
     * indexes a `custom_json` against its sender. Measured 2.6s with the stake join and
     * both leaderboard floors applied in SQL. Fast when healthy, 245s when not, so it
     * is built off the request path like every other slow board.
     */
    if (board === 'muted') {
      if (!hiveSqlConfigured()) {
        // ★ NO `asOf` ON A FAILURE. A fresh "Indexed <now>" under an empty board is a
        // freshness claim about data we do not have.
        return NextResponse.json({ board, rows: [], unconfigured: true }, { headers: { 'cache-control': 'no-store' } });
      }
      startBuild(mutedState, SQL_REBUILD_MS, async () => {
        const { rows, failed } = await mostMuted();
        return failed ? null : rows;
      });
      return boardResponse(board, mutedState);
    }

    if (board === 'ke') {
      if (!hiveSqlConfigured()) {
        return NextResponse.json({ board, rows: [], unconfigured: true }, { headers: { 'cache-control': 'no-store' } });
      }
      startBuild(keState, SQL_REBUILD_MS, async () => {
        const { rows, failed } = await keBoard();
        return failed ? null : rows;
      });
      return boardResponse(board, keState);
    }

    /*
     * ★★ 80.2s MEASURED for a three-month aggregate over `TxVotes`, and a twelve-month
     * one does not finish at all. Nothing about that belongs on a request.
     */
    if (board === 'downvoted') {
      if (!hiveSqlConfigured()) {
        return NextResponse.json({ board, rows: [], unconfigured: true }, { headers: { 'cache-control': 'no-store' } });
      }
      startBuild(dvState, REBUILD_MS, async () => {
        const { rows, failed } = await mostDownvoted();
        return failed ? null : rows;
      });
      return boardResponse(board, dvState);
    }

    if (board === 'steem') {
      const index = await blacklistIndex();
      const accounts = index.accounts.slice(0, MAX_STEEM_LOOKUPS);
      startSteemBuild(accounts);
      const base = boardResponse(board, steemState);
      const body = await base.json();
      return NextResponse.json(
        { ...body, scope: accounts.length, listed: index.accounts.length, done: steemState.builtAt > 0 },
        { headers: { 'cache-control': 'private, max-age=30' } }
      );
    }

    return NextResponse.json({ error: 'unknown board' }, { status: 400 });
  } catch {
    /*
     * ★ A FAILED BOARD IS AN EMPTY BOARD WITH A REASON, NOT A 500. The page renders
     * the other boards and says this one could not be read, which is both more useful
     * than an error page and closer to the truth: the chain did not answer, Lumen did
     * not break.
     */
    return NextResponse.json(
      { board, rows: [], unavailable: true },
      { status: 200, headers: { 'cache-control': 'no-store' } }
    );
  }
}
