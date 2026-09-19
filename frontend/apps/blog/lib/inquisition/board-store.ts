import 'server-only';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, utimesSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * ════ THE BOARDS, BUILT ONCE FOR EVERYONE ════
 *
 * ★★★ THESE LISTS BARELY MOVE, AND I HAD THEM REBUILDING CONSTANTLY (owner, 2026-09-19:
 * "why are we building cold every time? arent these lsits generally speaking set in
 * place. cant you build once for everyone for top 100 per list and then update the list
 * 1 time every 3 days or so"). Correct on every count. Two separate mistakes made it as
 * bad as it was:
 *
 *   1. STATE LIVED IN `globalThis`, WHICH IS PER WORKER PROCESS. Production runs three
 *      `next-server` children, so each one built its own copy: three times the load on a
 *      database we do not own, and a one-in-three chance that any given reader landed on
 *      a cold worker and waited behind a 250-second aggregate even though another worker
 *      had the answer.
 *   2. IT WAS IN MEMORY, so every deploy and every restart threw all of it away and all
 *      three workers started again from nothing.
 *
 * A file on disk fixes both at once, because the filesystem is the one thing the three
 * workers already share and the one thing that survives a restart. The whole store is
 * four operations and no new service.
 *
 * ★★ AND READERS NEVER WAIT AGAIN AFTER THE FIRST BUILD. The route serves whatever is on
 * disk immediately, however old it is, and kicks a refresh behind the reader if it has
 * gone stale. Stale-while-revalidate: the only person who ever sees "Counting..." is
 * whoever arrives before the very first build has ever finished. A three-day-old
 * most-muted list is not meaningfully different from today's; a spinner is.
 *
 * ★ ONE WORKER BUILDS, NOT THREE. `claimBuild` is a lock file whose mtime is the claim.
 * A worker that cannot claim simply serves what is on disk, so a refresh costs the
 * database one query rather than three.
 *
 * ════ AND A BOARD IS NOW STORED IN PIECES, NOT ALL AT ONCE ════
 *
 * ★★★ A FILE THAT IS ONLY WRITTEN WHEN EVERYTHING IS FINISHED IS A FILE THAT IS USUALLY
 * NOT THERE. The two downvote boards are a ~102s ranking, then a top-counterpart pass
 * with a 4-minute budget, then a per-account money pass with a 14-minute budget. Written
 * once at the end, that is up to twenty minutes in which the board does not exist — the
 * reader sees "Counting..." the whole time, and a deploy or a crash at minute nineteen
 * throws away all nineteen.
 *
 * The ranking IS the board. The other two passes are COLUMNS on it, and a column that is
 * not there yet is already a state this feature knows how to render (`null` = "not
 * computed", a dash on screen, never a zero). So the build now stores after every stage:
 *
 *     stage 1  the ranking            -> stored, served, readers stop waiting
 *     stage 2  the counterpart column -> merged into the stored rows, stored again
 *     stage 3  the money column       -> merged every few accounts, stored again
 *
 * `stage` records how far a stored board has got and `done` records which accounts the
 * incremental stage has already attempted, so a process that dies at account twelve
 * restarts at account thirteen instead of at zero. `mergeBoard` is the operation that
 * makes this safe: read, patch, write through the same tmp+rename, so a reader on another
 * worker still sees either the whole old file or the whole new one.
 */

/**
 * Where the built boards live. `/opt/lumen/cache` on the server (set in the unit file);
 * falls back to the system temp dir, which still survives a service restart.
 */
const DIR = process.env.LUMEN_CACHE_DIR || join(tmpdir(), 'lumen-inquisition');

/** How long a built board is served before a refresh is kicked off behind the reader. */
export const REFRESH_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * ★★★ HOW LONG ONE WORKER'S CLAIM LASTS, AND IT IS NOW A HEARTBEAT RATHER THAN A GUESS.
 *
 * A claim outlives the process that took it: the lock is a file, so killing a worker
 * mid-build (a deploy, a restart, a crash) strands it. Observed 2026-09-19 after
 * restarting the server during a cold build — every board answered `rows: 0,
 * building: false`, which the page renders as **"Nothing to confess."**, for the rest of
 * the claim window. No rows, nobody building, and a confident negative on screen.
 *
 * The first fix was to make the window longer than the longest build: twenty-five
 * minutes, because the inquisitor build is a 102s scan plus a counterpart pass plus
 * forty vote ledgers, and a claim shorter than the work lets a second worker take it
 * over while the first is still running. That worked, and it bought the worst possible
 * recovery: a worker killed one second into its claim left the board unattended for the
 * remaining twenty-four minutes and fifty-nine seconds. With staged storage that stops
 * being cosmetic — the rows are on disk and served, but the money column simply stops
 * filling and nothing restarts it.
 *
 * ★★ SO THE CLAIM IS NOW REFRESHED WHILE THE WORK IS ACTUALLY HAPPENING (`touchClaim`,
 * called on a timer by the builder). A live build re-stamps the lock every 30 seconds, so
 * the window no longer has to cover the whole build — it only has to cover the gap
 * between two heartbeats. Three minutes is six missed heartbeats, which is a dead process
 * rather than a slow one, and it means a killed build is picked up and RESUMED by the
 * next reader's worker in three minutes instead of twenty-five.
 *
 * The other half of the original fix stays: a board with no rows reports `building: true`
 * while somebody holds the claim, so the page says "Counting..." rather than asserting
 * there is nothing to find.
 */
const CLAIM_MS = 3 * 60 * 1000;

/**
 * How often a running build re-stamps its claim. Six of these fit inside `CLAIM_MS`, so
 * one slow query or a busy event loop cannot lose a claim that is still being worked on.
 */
export const HEARTBEAT_MS = 30 * 1000;

export interface StoredBoard<T> {
  rows: T[];
  /** When the rows were produced. */
  asOf: string;
  /** Epoch ms, for the staleness test. */
  builtAt: number;
  /**
   * How many of this board's stages are finished, and how many it has. Absent on a file
   * written before staged builds existed, which is read as "finished" — those files were
   * only ever written when the whole build completed.
   */
  stage?: number;
  stages?: number;
  /**
   * Accounts the current incremental stage has already ATTEMPTED — not the ones that
   * produced a value. An account whose money query timed out is done too; retrying it on
   * every restart would spend the whole budget on the one row that cannot finish.
   */
  done?: string[];
}

function ensureDir(): boolean {
  try {
    mkdirSync(DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function boardPath(key: string): string {
  return join(DIR, `${key}.json`);
}

export function readBoard<T>(key: string): StoredBoard<T> | null {
  try {
    const raw = readFileSync(boardPath(key), 'utf8');
    const parsed = JSON.parse(raw) as StoredBoard<T>;
    // ★ A file that parses but carries no rows is not an answer; treat it as absent so
    // the next reader rebuilds rather than inheriting an empty board.
    if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) return null;
    return parsed;
  } catch {
    // Missing, unreadable or corrupt all mean the same thing here: nothing to serve.
    return null;
  }
}

/**
 * ★★ WRITTEN VIA A TEMP FILE AND A RENAME, because a reader on another worker can be
 * reading this exact path while we write it. `rename` within one filesystem is atomic,
 * so a reader sees either the whole old file or the whole new one and never a half.
 */
function put<T>(key: string, payload: StoredBoard<T>): boolean {
  if (payload.rows.length === 0) return false;
  if (!ensureDir()) return false;
  const tmp = join(DIR, `${key}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    renameSync(tmp, boardPath(key));
    return true;
  } catch {
    // A cache we cannot write is a slower feature, not a broken one.
    return false;
  }
}

export interface StageMeta {
  stage?: number;
  stages?: number;
  done?: string[];
}

/**
 * Store a board's rows outright. This is stage 1: the ranking replaces whatever was
 * there, and any per-account progress recorded against the old rows goes with it.
 */
export function writeBoard<T>(key: string, rows: T[], asOf: string, meta: StageMeta = {}): void {
  put<T>(key, {
    rows,
    asOf,
    builtAt: Date.now(),
    stage: meta.stage,
    stages: meta.stages,
    done: meta.done ?? []
  });
}

/**
 * ★★★ MERGE A LATER STAGE'S COLUMN INTO THE ROWS ALREADY ON DISK.
 *
 * `apply` receives the stored rows and returns them patched. The rest of the file —
 * `asOf` and `builtAt` above all — is PRESERVED, because a column arriving four minutes
 * after the ranking does not make the ranking four minutes newer. `builtAt` is the age of
 * the DATA, and the data is the stage-1 snapshot; letting each merge bump it would mean a
 * board that never looks stale while its later stages keep touching it.
 *
 * Returns false when there is nothing on disk to merge into (the stage-1 file was deleted
 * or never written), which the caller treats as "start again" rather than silently
 * writing a rows-less file.
 *
 * ★ SAFE AGAINST A CONCURRENT READER, NOT AGAINST A CONCURRENT WRITER. Read-patch-write
 * is only atomic because exactly one worker holds the build claim; that is the same
 * discipline the rest of this module already depends on, not a new assumption.
 */
export function mergeBoard<T>(key: string, apply: (rows: T[]) => T[], meta: StageMeta = {}): boolean {
  const stored = readBoard<T>(key);
  if (!stored) return false;
  return put<T>(key, {
    rows: apply(stored.rows),
    asOf: stored.asOf,
    builtAt: stored.builtAt,
    stage: meta.stage ?? stored.stage,
    stages: meta.stages ?? stored.stages,
    done: meta.done ?? stored.done ?? []
  });
}

export function isStale(board: StoredBoard<unknown> | null): boolean {
  return !board || Date.now() - board.builtAt >= REFRESH_MS;
}

/**
 * Has every stage of this board been built?
 *
 * ★ A FILE WITH NO `stage` FIELD IS COMPLETE. Those were written by the all-at-once
 * builder, which only ever wrote on success. Reading them as "stage 0 of nothing" would
 * put every board that survived the deploy into a pointless full rebuild.
 */
export function isComplete(board: StoredBoard<unknown> | null): boolean {
  if (!board) return false;
  if (typeof board.stage !== 'number') return true;
  return board.stage >= (board.stages ?? board.stage);
}

/**
 * Try to become the one worker that rebuilds `key`. Returns false if another worker
 * holds a claim that has not expired.
 */
export function claimBuild(key: string): boolean {
  if (!ensureDir()) return true; // No shared dir: fall back to per-worker behaviour.
  const lock = join(DIR, `${key}.lock`);
  try {
    const age = Date.now() - statSync(lock).mtimeMs;
    if (age < CLAIM_MS) return false;
    // Stale claim: take it over by stamping it now.
    utimesSync(lock, new Date(), new Date());
    return true;
  } catch {
    // No lock file yet.
  }
  try {
    closeSync(openSync(lock, 'w'));
    return true;
  } catch {
    return true;
  }
}

/**
 * Re-stamp a claim we already hold, to say the build behind it is still alive. Called on
 * a timer for the whole duration of a build — see `CLAIM_MS`.
 */
export function touchClaim(key: string): void {
  try {
    utimesSync(join(DIR, `${key}.lock`), new Date(), new Date());
  } catch {
    // No lock to keep alive; the build finishes or is retried either way.
  }
}

/**
 * Is anyone currently building this board? Used so a board with no rows yet can say
 * "counting" rather than "nothing", including when the builder is another worker.
 */
export function isClaimed(key: string): boolean {
  try {
    return Date.now() - statSync(join(DIR, `${key}.lock`)).mtimeMs < CLAIM_MS;
  } catch {
    return false;
  }
}

/**
 * Release the claim, so a failed build can be retried without waiting it out.
 *
 * ★★ `cooldownMs` IS HOW LONG THE RETRY WAITS, AND ZERO IS THE WRONG VALUE AFTER A
 * FAILURE. Releasing outright means the next poll — three seconds later — starts another
 * build, so a HiveSQL that is down is asked again every fifteen seconds by every polling
 * tab, forever. Backdating the lock so the claim expires in a minute instead gives the
 * same recovery with four attempts an hour rather than two hundred and forty.
 */
export function releaseBuild(key: string, cooldownMs = 0): void {
  const when = new Date(Date.now() - CLAIM_MS + Math.max(0, cooldownMs));
  try {
    utimesSync(join(DIR, `${key}.lock`), when, when);
  } catch {
    // Nothing to release.
  }
}
