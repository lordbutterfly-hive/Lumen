import { NextResponse, type NextRequest } from 'next/server';
import {
  BOARD_ROWS,
  BOARD_ROWS_DEEP,
  inquisitorBoard,
  keBoard,
  mostDownvoted,
  mostMuted
} from '@/blog/lib/inquisition/boards-sql';
import { hiveSqlConfigured } from '@/blog/lib/inquisition/hivesql';
import { loadCrossposters, type CrosspostRow } from '@/blog/lib/inquisition/crossposting';
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
function boardResponse<T>(board: string, state: BoardState<T>, depth = BOARD_ROWS): NextResponse {
  const unavailable = state.rows.length === 0 && !state.building && state.lastFailed;
  return NextResponse.json(
    {
      board,
      rows: state.rows,
      asOf: state.asOf ?? undefined,
      building: state.building,
      depth,
      // ★ The button only appears when there is genuinely more to fetch.
      canDeepen: depth < BOARD_ROWS_DEEP,
      ...(unavailable ? { unavailable: true } : {})
    },
    { headers: { 'cache-control': 'private, max-age=30' } }
  );
}

const mutedStateDeep = slot<{ account: string; mutedBy: number; muterMvests: number }>('muted-deep');
const mutedState = slot<{ account: string; mutedBy: number; muterMvests: number }>('muted');
const keStateDeep = slot<{ account: string; ke: number; rewardsHive: number; hp: number; band: string }>('ke-deep');
const keState = slot<{ account: string; ke: number; rewardsHive: number; hp: number; band: string }>('ke');
type DvRowT = { account: string; downvotes: number; voters: number; topSource: string; topSourceVotes: number; removedUsd: number | null; postsHit: number };
type InqRowT = { account: string; downvotes: number; targets: number; topTarget: string; topTargetVotes: number; removedUsd: number | null };
const dvStateDeep = slot<DvRowT>('downvoted-deep');
const dvState = slot<{ account: string; downvotes: number; voters: number }>('downvoted');
const xpostState = slot<CrosspostRow>('crossposting');
const xpostCandidates = ((globalThis as Record<symbol, unknown>)[Symbol.for('lumen.inquisition.xpost.candidates')] ??= { n: 0 }) as { n: number };
const inqStateDeep = slot<InqRowT>('inquisitors-deep');
const inqState = slot<{ account: string; downvotes: number; targets: number; topTarget: string; topTargetVotes: number }>('inquisitors');


export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const board = params.get('board') ?? 'ke';
  /*
   * ★★ DEPTH IS A READER'S CHOICE, AND THERE ARE EXACTLY TWO OF THEM. `?deep=1` is the
   * SHOW MORE button. Accepting an arbitrary number here would let a stranger ask for a
   * 10,000-row aggregate against somebody else's free database; two fixed tiers cannot
   * be abused and cache cleanly, one slot each.
   */
  const limit = params.get('deep') === '1' ? BOARD_ROWS_DEEP : BOARD_ROWS;
  const deeper = limit === BOARD_ROWS_DEEP;

  try {
    /*
     * ★★★ THERE IS NO BLACKLIST BOARD (owner, 2026-09-19: "remove the blacklists from
     * mode and bar. it wont work, we add that later"). The bridge reader, its cache and
     * the board branch are all gone rather than hidden behind a flag: a published
     * blacklist is somebody else's editorial judgement about a named person, and a
     * half-built surface for that is worse than none.
     */
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
        return NextResponse.json(
          { board, rows: [], unconfigured: true },
          { headers: { 'cache-control': 'no-store' } }
        );
      }
      startBuild(deeper ? mutedStateDeep : mutedState, SQL_REBUILD_MS, async () => {
        const { rows, failed } = await mostMuted(limit);
        return failed ? null : rows;
      });
      return boardResponse(board, deeper ? mutedStateDeep : mutedState, limit);
    }

    if (board === 'ke') {
      if (!hiveSqlConfigured()) {
        return NextResponse.json(
          { board, rows: [], unconfigured: true },
          { headers: { 'cache-control': 'no-store' } }
        );
      }
      startBuild(deeper ? keStateDeep : keState, SQL_REBUILD_MS, async () => {
        const { rows, failed } = await keBoard(limit);
        return failed ? null : rows;
      });
      return boardResponse(board, deeper ? keStateDeep : keState, limit);
    }

    /*
     * ★★ 80.2s MEASURED for a three-month aggregate over `TxVotes`, and a twelve-month
     * one does not finish at all. Nothing about that belongs on a request.
     */
    if (board === 'downvoted') {
      if (!hiveSqlConfigured()) {
        return NextResponse.json(
          { board, rows: [], unconfigured: true },
          { headers: { 'cache-control': 'no-store' } }
        );
      }
      startBuild(deeper ? dvStateDeep : dvState, REBUILD_MS, async () => {
        const { rows, failed } = await mostDownvoted(limit);
        return failed ? null : rows;
      });
      return boardResponse(board, deeper ? dvStateDeep : dvState, limit);
    }

    if (board === 'inquisitors') {
      if (!hiveSqlConfigured()) {
        return NextResponse.json({ board, rows: [], unconfigured: true }, { headers: { 'cache-control': 'no-store' } });
      }
      startBuild(deeper ? inqStateDeep : inqState, REBUILD_MS, async () => {
        const { rows, failed } = await inquisitorBoard(limit);
        return failed ? null : rows;
      });
      return boardResponse(board, deeper ? inqStateDeep : inqState, limit);
    }

    if (board === 'crossposting') {
      if (!hiveSqlConfigured()) {
        return NextResponse.json({ board, rows: [], unconfigured: true }, { headers: { 'cache-control': 'no-store' } });
      }
      startBuild(xpostState, SQL_REBUILD_MS, async () => {
        const { rows, candidates, failed } = await loadCrossposters();
        xpostCandidates.n = candidates;
        return failed ? null : rows;
      });
      const base = boardResponse(board, xpostState);
      const body = await base.json();
      return NextResponse.json(
        { ...body, scope: xpostState.rows.length, listed: xpostCandidates.n },
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
