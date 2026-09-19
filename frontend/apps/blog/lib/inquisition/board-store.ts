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
 */

/**
 * Where the built boards live. `/opt/lumen/cache` on the server (set in the unit file);
 * falls back to the system temp dir, which still survives a service restart.
 */
const DIR = process.env.LUMEN_CACHE_DIR || join(tmpdir(), 'lumen-inquisition');

/** How long a built board is served before a refresh is kicked off behind the reader. */
export const REFRESH_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * ★★★ HOW LONG ONE WORKER'S CLAIM LASTS, AND 15 MINUTES WAS LONG ENOUGH TO BE A BUG.
 *
 * A claim outlives the process that took it: the lock is a file, so killing a worker
 * mid-build (a deploy, a restart, a crash) strands it. Observed 2026-09-19 after
 * restarting the server during a cold build — every board answered `rows: 0,
 * building: false`, which the page renders as **"Nothing to confess."**, for the rest of
 * the claim window. No rows, nobody building, and a confident negative on screen.
 *
 * ★★ AND IT HAS TO OUTLAST THE LONGEST BUILD, WHICH SIX MINUTES NO LONGER DID. Once the
 * downvote boards went to full history the inquisitor build became a 102s scan plus a
 * chunked top-target pass plus forty vote ledgers. A claim shorter than the work lets a
 * second worker take it over while the first is still running, which is the duplicate
 * work the lock exists to prevent. Twenty-five minutes is comfortably longer than any
 * build here and still short enough that a killed one recovers on its own. The other half of the fix is in `isClaimed`:
 * a board with no rows now reports `building: true` while somebody holds the claim, so
 * the page says "Counting..." instead of asserting there is nothing to find.
 */
const CLAIM_MS = 25 * 60 * 1000;

export interface StoredBoard<T> {
  rows: T[];
  /** When the rows were produced. */
  asOf: string;
  /** Epoch ms, for the staleness test. */
  builtAt: number;
}

function ensureDir(): boolean {
  try {
    mkdirSync(DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export function readBoard<T>(key: string): StoredBoard<T> | null {
  try {
    const raw = readFileSync(join(DIR, `${key}.json`), 'utf8');
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
export function writeBoard<T>(key: string, rows: T[], asOf: string): void {
  if (rows.length === 0) return;
  if (!ensureDir()) return;
  const payload: StoredBoard<T> = { rows, asOf, builtAt: Date.now() };
  const tmp = join(DIR, `${key}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    renameSync(tmp, join(DIR, `${key}.json`));
  } catch {
    // A cache we cannot write is a slower feature, not a broken one.
  }
}

export function isStale(board: StoredBoard<unknown> | null): boolean {
  return !board || Date.now() - board.builtAt >= REFRESH_MS;
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

/** Release the claim early, so a failed build can be retried without waiting it out. */
export function releaseBuild(key: string): void {
  try {
    utimesSync(join(DIR, `${key}.lock`), new Date(0), new Date(0));
  } catch {
    // Nothing to release.
  }
}
