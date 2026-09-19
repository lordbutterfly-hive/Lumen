import { NextResponse, type NextRequest } from 'next/server';
import {
  BOARD_ROWS,
  inquisitorBoard,
  keBoard,
  mostDownvoted,
  mostMuted
} from '@/blog/lib/inquisition/boards-sql';
import { hiveSqlConfigured } from '@/blog/lib/inquisition/hivesql';
import { loadCrossposters, type CrosspostRow } from '@/blog/lib/inquisition/crossposting';
import {
  claimBuild,
  isClaimed,
  isStale,
  readBoard,
  releaseBuild,
  writeBoard
} from '@/blog/lib/inquisition/board-store';
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
 * ════ ONE BOARD, BUILT ONCE, SERVED FROM DISK ════
 *
 * ★★★ THE READER IS NEVER MADE TO WAIT FOR A REBUILD. Whatever is on disk is served
 * immediately, however old; if it has gone stale a refresh runs behind the response. The
 * only person who ever sees "Counting..." is whoever arrives before the very first build
 * of a board has ever completed. See `board-store.ts` for why this is a file and not
 * process memory: three workers share it, and it survives a deploy.
 *
 * ★★ A BUILD THAT FINDS NOTHING NEVER OVERWRITES A GOOD BOARD. `writeBoard` refuses an
 * empty row set, so a failed or degraded refresh leaves yesterday's answer in place
 * rather than blanking the board and stamping it with today's date. That failure mode
 * cost this feature a full day of "Nothing to confess." once already.
 */
interface Building {
  running: boolean;
}
const BUILDING = Symbol.for('lumen.inquisition.building.v3');
const building = ((globalThis as Record<symbol, unknown>)[BUILDING] ??= {}) as Record<string, Building>;

function refreshInBackground<T>(key: string, run: () => Promise<{ rows: T[]; asOf: string } | null>): void {
  const state = (building[key] ??= { running: false });
  if (state.running) return;
  // ★ One worker builds; the others serve what is on disk.
  if (!claimBuild(key)) return;
  state.running = true;
  void (async () => {
    try {
      const built = await run();
      if (built && built.rows.length > 0) {
        writeBoard(key, built.rows, built.asOf);
      } else {
        // Let the next reader retry rather than sitting out the whole claim window.
        releaseBuild(key);
      }
    } catch {
      releaseBuild(key);
    } finally {
      state.running = false;
    }
  })();
}

/**
 * Serve a board: disk first, refresh behind. `building` is only ever true when there is
 * genuinely nothing to show yet.
 */
function serve<T>(
  board: string,
  key: string,
  run: () => Promise<{ rows: T[]; asOf: string } | null>
): NextResponse {
  const stored = readBoard<T>(key);
  if (isStale(stored)) refreshInBackground(key, run);

  if (!stored) {
    /*
     * ★★ NO ROWS PLUS "NOT BUILDING" IS THE ONE COMBINATION THAT LIES, because the page
     * renders it as "Nothing to confess." The claim is held on disk, so a build running
     * on another worker — or one stranded by a restart and not yet expired — still counts
     * as building here. The reader waits; they are never told the chain is clean.
     */
    const inFlight = building[key]?.running === true || isClaimed(key);
    return NextResponse.json(
      { board, rows: [], building: inFlight },
      { headers: { 'cache-control': 'private, max-age=15' } }
    );
  }
  return NextResponse.json(
    {
      board,
      rows: stored.rows,
      asOf: stored.asOf,
      building: false,
      // ★ The reader is told when they are looking at a copy that is being refreshed.
      refreshing: isStale(stored)
    },
    { headers: { 'cache-control': 'private, max-age=60' } }
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const board = params.get('board') ?? 'ke';
  /*
   * ★★ THERE IS NO DEEP TIER ANY MORE. Every board is built to `BOARD_ROWS` once and
   * served from disk, so SHOW MORE reveals rows the reader already has instead of
   * triggering a second, more expensive query. That removes the `?deep=1` parameter, the
   * duplicate cache slots behind it, and the bug where one press left every board
   * afterwards asking for a tier nobody had built.
   */

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
      return serve(board, 'muted', async () => {
        const { rows, asOf, failed } = await mostMuted(BOARD_ROWS);
        return failed ? null : { rows, asOf };
      });
    }

    if (board === 'ke') {
      if (!hiveSqlConfigured()) {
        return NextResponse.json(
          { board, rows: [], unconfigured: true },
          { headers: { 'cache-control': 'no-store' } }
        );
      }
      return serve(board, 'ke', async () => {
        const { rows, asOf, failed } = await keBoard(BOARD_ROWS);
        return failed ? null : { rows, asOf };
      });
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
      return serve(board, 'downvoted', async () => {
        const { rows, asOf, failed } = await mostDownvoted(BOARD_ROWS);
        return failed ? null : { rows, asOf };
      });
    }

    if (board === 'inquisitors') {
      if (!hiveSqlConfigured()) {
        return NextResponse.json({ board, rows: [], unconfigured: true }, { headers: { 'cache-control': 'no-store' } });
      }
      return serve(board, 'inquisitors', async () => {
        const { rows, asOf, failed } = await inquisitorBoard(BOARD_ROWS);
        return failed ? null : { rows, asOf };
      });
    }

    if (board === 'crossposting') {
      if (!hiveSqlConfigured()) {
        return NextResponse.json({ board, rows: [], unconfigured: true }, { headers: { 'cache-control': 'no-store' } });
      }
      /*
       * ★ CROSSPOSTING CARRIES ITS OWN SCOPE NUMBERS, so they ride along inside the
       * stored rows' sibling fields rather than in separate process memory that a
       * restart would lose while the rows survived.
       */
      const res = serve<CrosspostRow & { _matched?: number; _listed?: number }>(
        board,
        'crossposting',
        async () => {
          const { rows, candidates, matched, failed } = await loadCrossposters(BOARD_ROWS);
          if (failed || rows.length === 0) return null;
          const tagged = rows.map((r, i) => (i === 0 ? { ...r, _matched: matched, _listed: candidates } : r));
          return { rows: tagged, asOf: nowIso() };
        }
      );
      const body = (await res.json()) as { rows?: (CrosspostRow & { _matched?: number; _listed?: number })[] };
      const head = body.rows?.[0];
      return NextResponse.json(
        { ...body, scope: body.rows?.length ?? 0, matched: head?._matched, listed: head?._listed },
        { headers: { 'cache-control': 'private, max-age=60' } }
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
