import { NextResponse, type NextRequest } from 'next/server';
import { blacklistIndex } from '@/blog/lib/inquisition/blacklists';
import { mostMuted } from '@/blog/lib/inquisition/boards-sql';
import { hiveSqlConfigured } from '@/blog/lib/inquisition/hivesql';
import { steemActivity } from '@/blog/lib/inquisition/steem';
import { nowIso } from '@/blog/lib/inquisition/types';

export const dynamic = 'force-dynamic';

/**
 * ════ THE BOARDS, SERVED FROM ONE AGGREGATE EACH ════
 *
 * ★★★ EVERY BOARD IS ONE CACHED READ, NEVER N LOOKUPS. That is the whole server-safety
 * story for this feature. The blacklist board is six upstream requests (three
 * publishers × two list types) shared by every reader for six hours; the Steem board
 * asks one endpoint per listed account, once a day, and only for accounts that are
 * already on the blacklist board — a set measured at 45, not "everyone on Hive".
 *
 * ★★ THE STEEM BOARD IS SCOPED TO THE LISTED SET ON PURPOSE. "Which accounts still
 * post to Steem" over all of Hive is a crawl; over the accounts three publishers have
 * listed it is 45 requests a day. It is also the only version of the question anybody
 * asked: the joke is about accounts that have a record, not about everyone.
 *
 * ★ `force-dynamic` because the answer depends on caches that live in this process,
 * not on the request. Without it Next would try to make this a static route at build
 * time, when no cache is warm and no upstream should be called.
 */

const MAX_STEEM_LOOKUPS = 45;


interface SteemRow {
  account: string;
  postsSinceFork: number;
  lastPost: string | null;
  partial: boolean;
}

/**
 * ★★★ THE STEEM BOARD IS BUILT OFF THE REQUEST PATH, AND THE MEASUREMENT IS WHY.
 * Built inline it took **30.2 seconds** cold: forty-five accounts, each one to three
 * requests to a chain we do not run, done sequentially so we are not hammering it.
 * A tab click cannot cost that, and forty readers clicking it cannot cost it forty
 * times over.
 *
 * So the first request STARTS the build and returns immediately with whatever is
 * already finished plus `building: true`. The rows arrive on the next poll. The
 * alternative — parallelise it to fit in a request — just moves the cost onto
 * somebody else's endpoint, which is the thing the owner asked me not to do.
 *
 * `steemActivity` caches each account for a day, so the build is ~30s once and then
 * free until tomorrow.
 */
/*
 * ★★★ ON `globalThis`, FOR THE SAME REASON `server-ttl-cache.ts` IS (found by
 * adversarial review, 2026-09-19). Next compiles a module once per webpack layer and
 * the box runs three cluster workers, so a plain module-level object is not one state,
 * it is up to N of them. With `done` gating the build, that meant up to three
 * concurrent 30-second builds and up to 405 requests to api.steemit.com per restart,
 * against a stated budget of 45 a day. One shared slot, and `done` now expires so the
 * 24h TTL underneath it can actually be exercised.
 */
interface SteemState {
  rows: SteemRow[];
  building: boolean;
  builtAt: number;
  asOf: string | null;
}
const STEEM_SLOT = Symbol.for('lumen.inquisition.steem.v1');
const steemState: SteemState = ((globalThis as Record<symbol, unknown>)[STEEM_SLOT] ??= {
  rows: [],
  building: false,
  builtAt: 0,
  asOf: null
}) as SteemState;

const STEEM_REBUILD_MS = 24 * 60 * 60 * 1000;

function startSteemBuild(accounts: string[]): void {
  const fresh = steemState.builtAt > 0 && Date.now() - steemState.builtAt < STEEM_REBUILD_MS;
  if (steemState.building || fresh) return;
  steemState.building = true;
  void (async () => {
    const rows: SteemRow[] = [];
    for (const account of accounts) {
      try {
        const activity = await steemActivity(account);
        if (activity.postsSinceFork > 0) {
          rows.push({
            account,
            postsSinceFork: activity.postsSinceFork,
            lastPost: activity.lastPost,
            partial: activity.partial
          });
          // Publish as we go, so a reader polling sees the board fill rather than
          // staring at an empty panel for half a minute.
          /*
           * ★ COMPLETE ROWS RANK ABOVE CAPPED ONES. A capped row's number is a floor,
           * so ordering a `298+` above an exact `62` asserts a comparison we cannot
           * make. Capped rows still appear, below, still marked `+`.
           */
          steemState.rows = [...rows].sort((a, b) => {
            if (a.partial !== b.partial) return a.partial ? 1 : -1;
            return b.postsSinceFork - a.postsSinceFork;
          });
          steemState.asOf = nowIso();
        }
      } catch {
        // An endpoint that will not answer is not a fact about the account.
      }
    }
    steemState.building = false;
    steemState.builtAt = Date.now();
    steemState.asOf = nowIso();
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
     * both leaderboard floors applied in SQL, which is a cache-fill cost, not a
     * reader's.
     */
    if (board === 'muted') {
      if (!hiveSqlConfigured()) {
        return NextResponse.json(
          // ★ NO `asOf` ON A FAILURE. A fresh "Indexed <now>" under an empty board is a
        // freshness claim about data we do not have.
        { board, rows: [], unconfigured: true },
          { headers: { 'cache-control': 'no-store' } }
        );
      }
      const { rows, asOf, failed } = await mostMuted();
      if (failed) {
        // ★ "We could not ask" is not "there is nobody". See hivesql.ts.
        return NextResponse.json(
          { board, rows: [], unavailable: true },
          { headers: { 'cache-control': 'no-store' } }
        );
      }
      return NextResponse.json({ board, rows, asOf }, { headers: { 'cache-control': 'private, max-age=300' } });
    }

    if (board === 'steem') {
      const index = await blacklistIndex();
      const accounts = index.accounts.slice(0, MAX_STEEM_LOOKUPS);
      startSteemBuild(accounts);
      return NextResponse.json(
        {
          board,
          rows: steemState.rows,
          asOf: steemState.asOf ?? nowIso(),
          scope: accounts.length,
          building: steemState.building,
          done: steemState.builtAt > 0
        },
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
