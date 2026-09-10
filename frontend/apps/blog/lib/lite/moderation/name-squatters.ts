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

  for (let i = 0; i < candidates.length; i += CHAIN_BATCH) {
    const slice = candidates.slice(i, i + CHAIN_BATCH);
    let onChain: Map<string, ChainAccount>;
    try {
      onChain = await findAccounts(slice.map((c) => c.displayName.toLowerCase()));
    } catch (error) {
      // A node failure is not evidence that a name is free OR taken. Skip the batch
      // and leave the flag unset; the next run re-reads exactly these rows because
      // the query selects on `name_conflict_at IS NULL`.
      logger.warn(error, 'name squatter sweep: chain batch failed, leaving %d names unchecked', slice.length);
      continue;
    }

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
