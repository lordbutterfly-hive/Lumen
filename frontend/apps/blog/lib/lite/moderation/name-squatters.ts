import { getLogger } from '@ui/lib/logging';
import { siteConfig } from '@ui/config/site';
import * as users from '../repositories/user-repository';
import { liteConfig } from '../config';

const logger = getLogger('app');

/** `find_accounts` takes a list; this is one call's worth. */
const CHAIN_BATCH = 100;
/** Per run. The sweep is meant to be cheap and frequent, not a full table scan. */
const DEFAULT_LIMIT = 500;
const FIND_ACCOUNTS_TIMEOUT_MS = 8000;

interface ChainAccount {
  name: string;
  created: string;
  recovery_account?: string;
}

/**
 * One `find_accounts` call. Returns only the accounts that EXIST, with the two fields
 * that answer provenance: `created` (when) and `recovery_account` (who, by default the
 * creator).
 */
async function findAccounts(names: string[]): Promise<Map<string, ChainAccount>> {
  const res = await fetch(siteConfig.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'database_api.find_accounts',
      params: { accounts: names },
      id: 1
    }),
    signal: AbortSignal.timeout(FIND_ACCOUNTS_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`find_accounts failed: HTTP ${res.status}`);
  const data = (await res.json()) as { result?: { accounts?: ChainAccount[] }; error?: unknown };
  if (data.error) throw new Error(`find_accounts error: ${JSON.stringify(data.error).slice(0, 200)}`);
  const out = new Map<string, ChainAccount>();
  for (const account of data.result?.accounts ?? []) {
    if (account?.name) out.set(String(account.name).toLowerCase(), account);
  }
  return out;
}

/**
 * Hive account names are a 16-byte `fixed_string` on chain. Anything longer is not a
 * name the chain can answer about at all -- it raises an assert rather than returning
 * an empty result. See the block comment in `sweepNameSquatters`.
 */
const HIVE_NAME_MAX = 16;

/**
 * `findAccounts`, but a failing batch is split rather than lost.
 *
 * One name the node refuses fails the whole call (see `sweepNameSquatters`). Halving
 * on failure isolates that name in log2(n) extra round trips -- 7 for a 100-name
 * batch, and only when something actually failed -- while a genuine outage still ends
 * up throwing, because every leaf fails too. A single name that fails on its own is
 * the one case we swallow: it is answered ("we asked, the node refuses this name"),
 * and returning an empty result for it lets the other names in the batch through.
 */
async function findAccountsBisecting(names: string[]): Promise<Map<string, ChainAccount>> {
  try {
    return await findAccounts(names);
  } catch (error) {
    if (names.length <= 1) {
      // A single name the node will not answer. Not evidence of a Hive account, and
      // retrying it forever is exactly the loop this function exists to break.
      logger.warn(error, 'name squatter sweep: node refuses to answer for "%s"; treating as absent', names[0] ?? '');
      return new Map();
    }
    const mid = Math.ceil(names.length / 2);
    const [left, right] = await Promise.all([
      findAccountsBisecting(names.slice(0, mid)),
      findAccountsBisecting(names.slice(mid))
    ]);
    for (const [key, value] of right) left.set(key, value);
    return left;
  }
}

export interface SquatterFinding {
  userId: string;
  name: string;
  /** The Hive account's `recovery_account`, which defaults to whoever created it. */
  creator: string | null;
  hiveCreated: string | null;
  /** Did it come through OUR upgrade path? Then it is not a squatter. */
  ours: boolean;
  /** Was the Hive account registered AFTER the lite account? */
  after: boolean;
}

/**
 * ★★★ THE SQUATTER SWEEP (2026-09-10).
 *
 * Lite signup proves a name is free on Hive at the moment it is issued and fails
 * closed if it cannot check (`auth-service.ts`). Nothing re-checked afterwards, and
 * Hive's namespace stays open, so a lite handle can be registered on Hive the next
 * day -- after which every name-keyed lookup in the app still resolved it to the lite
 * user, and the newcomer inherited that account's posts, avatar, follow graph and
 * moderation state. This is the detector for that; `render/public-name.ts` is the
 * guard that acts on what it writes.
 *
 * ★ PROVENANCE COMES FREE. `recovery_account` defaults to the account's creator and
 * arrives in the SAME `find_accounts` call that answers "does this name exist", so
 * distinguishing our own upgrades from a stranger's registration costs no extra
 * request. It is CHANGEABLE by the owner (`change_recovery_account`, 30-day delay),
 * so it is strong evidence rather than proof -- the definitive check is the
 * `account_create` / `create_claimed_account` op in the account's own history, which
 * is the escalation for a disputed case, not the routine path.
 *
 * ★ WHY THE FLAG IS WRITTEN AND NOT DERIVED. The guard runs on the avatar route, the
 * lite posts route and both social actors -- per request, per card. It must not make
 * a chain call, and more importantly a Hive outage must not be able to change who a
 * name resolves to in EITHER direction. A stored verdict is the same answer whether
 * or not a node is up.
 */
export async function sweepNameSquatters(limit = DEFAULT_LIMIT): Promise<SquatterFinding[]> {
  const candidates = await users.listNamesForConflictSweep(limit);
  if (candidates.length === 0) return [];

  const ourCreator = (liteConfig.accountCreatorAccount || '').toLowerCase();
  const findings: SquatterFinding[] = [];

  /**
   * ★★★ ONE UNQUERYABLE NAME USED TO BLIND THE WHOLE BATCH, PERMANENTLY (2026-09-11).
   *
   * `find_accounts` takes up to CHAIN_BATCH names in ONE call, and Hive answers the
   * whole call or none of it. An account name is a 16-byte `fixed_string` on chain,
   * so asking about a LONGER name does not return "no such account" -- the node
   * raises `assert_exception: in_len <= sizeof(data)` (fixed_string.hpp) and the
   * entire request errors. Proven against api.hive.blog 2026-09-11:
   * `find_accounts(["blocktrades","christina.mercier","chadmasters"])` errors
   * outright, while the same two real names without the 17-character one return both
   * accounts fine.
   *
   * The old catch below treated that as a transient node failure and `continue`d,
   * with a comment promising "the next run re-reads exactly these rows". It does --
   * and fails again, identically, forever: a row that is never answered is never
   * flagged, so it never leaves the candidate set, so it poisons every subsequent
   * tick. One bad row silently disables squatter detection for up to 99 other
   * accounts, fleet-wide, with only a WARN line to show for it.
   *
   * Two independent defences, because either alone is not enough:
   *   1. Never ASK about a name the chain cannot hold. A name longer than
   *      HIVE_NAME_MAX can never be a Hive account, therefore can never be squatted,
   *      so the honest verdict is "checked, nothing there" -- recorded, so it leaves
   *      the queue instead of sitting at the head of it.
   *   2. If a batch fails anyway (a real outage, or any future assert we have not
   *      predicted), BISECT it instead of dropping it. A genuine outage fails every
   *      sub-batch and costs one extra round trip; a single poisonous name is
   *      isolated to itself and the other 99 get their answer.
   */
  const askable: typeof candidates = [];
  const unaskable: typeof candidates = [];
  for (const candidate of candidates) {
    (candidate.displayName.trim().length > HIVE_NAME_MAX ? unaskable : askable).push(candidate);
  }
  if (unaskable.length > 0) {
    logger.warn(
      'name squatter sweep: %d name(s) are longer than a Hive account name can be and cannot be squatted; recording as checked: %s',
      unaskable.length,
      unaskable.map((c) => c.displayName).join(', ')
    );
    await users.markNamesChecked(unaskable.map((c) => c.userId));
  }

  for (let i = 0; i < askable.length; i += CHAIN_BATCH) {
    const slice = askable.slice(i, i + CHAIN_BATCH);
    let onChain: Map<string, ChainAccount>;
    try {
      onChain = await findAccountsBisecting(slice.map((c) => c.displayName.toLowerCase()));
    } catch (error) {
      // Every sub-batch failed, down to single names: this is a real node failure, not
      // one poisonous row. A node failure is not evidence that a name is free OR
      // taken, so leave both the flag AND the checked-at stamp unset -- the next run
      // re-reads exactly these rows, and because they are still unstamped they come
      // back to the FRONT of the queue rather than the back.
      logger.warn(error, 'name squatter sweep: chain batch failed, leaving %d names unchecked', slice.length);
      continue;
    }

    // Answered, so they are checked -- whether or not a Hive account turned up.
    // Without this the clean ones never leave the candidate set (see markNamesChecked).
    await users.markNamesChecked(slice.map((c) => c.userId));

    for (const candidate of slice) {
      const hit = onChain.get(candidate.displayName.toLowerCase());
      if (!hit) continue;
      const creator = (hit.recovery_account ?? '').toLowerCase() || null;
      const hiveCreated = hit.created ? new Date(`${hit.created}Z`) : null;
      const ours = !!creator && !!ourCreator && creator === ourCreator;
      const after = !!hiveCreated && hiveCreated.getTime() > candidate.createdAt.getTime();

      // ★ FLAG IT EITHER WAY. Even a Hive account we created, and even one that
      // somehow predates the lite row, means this NAME no longer resolves to one
      // identity -- and the whole point of the guard is that a name with two owners
      // resolves to neither. `ours`/`after` decide what MODERATION does about it,
      // not whether the name is contested.
      await users.markNameConflict(candidate.userId, creator, hiveCreated);
      findings.push({
        userId: candidate.userId,
        name: candidate.displayName,
        creator,
        hiveCreated: hit.created ?? null,
        ours,
        after
      });
      logger.warn(
        'name squatter sweep: hive account "%s" now exists (creator %s, created %s); lite user %s no longer resolves by that name%s',
        candidate.displayName,
        creator ?? 'unknown',
        hit.created ?? 'unknown',
        candidate.userId,
        ours ? ' [created by us, not a squatter]' : after ? ' [SQUATTER: registered after the lite account]' : ''
      );
    }
  }

  return findings;
}

/**
 * The squatters a run found: someone else's Hive account, registered after the lite
 * account it collides with. This is the list the owner asked to feed the global ban
 * list; kept as a separate, explicit step so a detection can never ban on its own.
 */
export function squattersOf(findings: SquatterFinding[]): SquatterFinding[] {
  return findings.filter((f) => !f.ours && f.after);
}

/**
 * How often the sweep runs. One `find_accounts` over the unflagged lite names plus one
 * small query -- cheap enough to run every minute, and this interval is also how long
 * the fleet can disagree about a brand-new squatter (see the reset in `run`).
 */
const SWEEP_INTERVAL_MS = 60_000;
/** First run waits this long, so it never competes with the boot warms. */
const SWEEP_FIRST_DELAY_MS = 15_000;

let scheduled = false;

/**
 * ★★★ THE DETECTOR HAD NO CALLER (2026-09-10, adversarial audit F6). Every piece of
 * the defence was built and shipped -- the guard, the ban list, the entry predicate,
 * the notice -- and NOTHING ever set the flag they all read. The two squatters live on
 * production today are flagged because I wrote their rows by hand. A third would have
 * been invisible to all of it, which means the whole feature was inert for anyone who
 * had not already been found manually. Exactly the shape of
 * `feedback_wire_it_live_no_dormant_code`: building includes enabling.
 *
 * ★ IT RESETS THE READ CACHE WHEN IT FINDS SOMETHING. `squatter-list.ts` holds its
 * list on a five-minute TTL, so without this a fresh detection would sit unenforced
 * for up to another five minutes after the sweep already knew. Only on a find, so a
 * quiet sweep costs nothing.
 *
 * ★ `unref()`, like every other timer this app starts: an interval must never be the
 * reason a process refuses to exit.
 */
export function scheduleNameSquatterSweep(): void {
  if (scheduled) return;
  scheduled = true;

  const run = async (): Promise<void> => {
    try {
      const findings = await sweepNameSquatters();
      /**
       * ★★★ RESET UNCONDITIONALLY, NOT ONLY ON A FIND (2026-09-10, owner's own live
       * test caught this within minutes of the previous deploy).
       *
       * Production runs SEVERAL node workers and each holds its own copy of the ban
       * list. `markNameConflict` is `WHERE name_conflict_at IS NULL`, so the FIRST
       * worker to sweep a new squatter is the only one that gets a non-empty
       * `findings` -- every other worker sweeps, finds nothing, and therefore never
       * invalidated its own list. Measured: one worker logged "3 name(s) hidden:
       * chadmasters, luxattack, meritimusdoublus" while a search served by another
       * still returned the squatter's Hive card.
       *
       * So the reset is a property of the TICK, not of this worker's luck. Every
       * worker reloads from the database on every sweep, which is one small query,
       * and the whole fleet converges within one interval instead of "whenever your
       * request happens to land on the worker that swept".
       */
      const { resetSquatterList } = await import('./squatter-list');
      resetSquatterList();
      if (findings.length > 0) {
        // ★ THE ORIGIN IS NOT THE READER (2026-09-11). resetSquatterList() above fixes
        // every worker; Cloudflare is still holding the pre-detection page. See
        // ./purge-edge-cache.ts for the window this closes and why it is inert (and
        // loud) without credentials.
        const { purgeEdgeCacheForNames } = await import('./purge-edge-cache');
        await purgeEdgeCacheForNames(findings.map((f) => f.name));
        logger.warn(
          'name squatter sweep: %d new conflict(s) flagged, ban list invalidated: %s',
          findings.length,
          findings.map((f) => f.name).join(', ')
        );
      }
    } catch (error) {
      /**
       * ★★★ NAME THE DEPLOY-ORDER FAILURE INSTEAD OF LOGGING "run failed" (2026-09-11).
       *
       * Migrations here are DELIBERATELY not run at boot (`lib/lite/db/migrate.ts`:
       * "intentionally NOT wired"), so `pnpm --filter @hive/blog lite:migrate` is an ops
       * step. If the code ships before migration 0044, every tick throws
       * `column "name_conflict_checked_at" does not exist`, this catch swallows it, and
       * squatter detection is silently dead for the whole deployment -- the exact
       * failure mode this sweep exists to prevent, with nothing but a generic warning to
       * find it by.
       *
       * A missing column is not a transient fault and must not read like one.
       */
      const message = error instanceof Error ? error.message : String(error);
      if (/name_conflict_checked_at/.test(message)) {
        logger.error(
          error,
          'name squatter sweep: DISABLED — migration 0044_name_conflict_checked has not been applied to this database. ' +
            'Squatter detection is NOT running. Run `pnpm --filter @hive/blog lite:migrate` against this database.'
        );
        return;
      }
      // A sweep that throws must never take the process with it. The rows it did not
      // reach stay unflagged and the next run re-reads them, because the query selects
      // on `name_conflict_at IS NULL`.
      logger.warn(error, 'name squatter sweep: run failed');
    }
  };

  const first = setTimeout(() => {
    void run();
    const repeat = setInterval(() => void run(), SWEEP_INTERVAL_MS);
    if (typeof repeat.unref === 'function') repeat.unref();
  }, SWEEP_FIRST_DELAY_MS);
  if (typeof first.unref === 'function') first.unref();
}
