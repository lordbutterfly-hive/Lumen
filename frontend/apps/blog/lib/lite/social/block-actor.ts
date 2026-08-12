import { Entry } from '@hive/common-hiveio-packages/wax';
import * as users from '../repositories/user-repository';
import { FollowActor, actorKey, TargetResolution } from './follow-actor';

/** Hive's own account-name rule (protocol): 3-16 chars, letter-led, dots and hyphens. */
const HIVE_NAME = /^[a-z][a-z0-9.-]{2,15}$/;

/**
 * Turning a NAME or an ENTRY into the node a block edge is stored under.
 *
 * This is the part of blocking that is easy to get quietly wrong, so it is separated
 * out and written once. Lumen has two name-spaces that look identical in the UI:
 *
 *   * a Hive account name — the author of anything signed on chain;
 *   * a Lumen handle — which, BY CONSTRUCTION, is a name that was FREE on Hive when
 *     the user picked it.
 *
 * So `@alice` the Lumen handle and `@alice` the Hive account can be two different
 * people, and a resolver that just asks "is there a Lumen row called alice?" will
 * sometimes block the wrong one. For a follow that is a nuisance. For a block it is
 * a correctness failure with a third-party blast radius: effect (B) removes somebody
 * else's words from a page, and removing the wrong person's is not a smaller mistake
 * than removing nobody's.
 *
 * Hence `BlockTargetKind`: the caller says which name-space it is holding whenever it
 * knows, and it almost always does — a rendered entry carries `_lite` exactly when
 * its author is a Lumen handle rather than a Hive account.
 */

export type BlockTargetKind = 'auto' | 'hive' | 'lumen';

export function isBlockTargetKind(value: unknown): value is BlockTargetKind {
  return value === 'auto' || value === 'hive' || value === 'lumen';
}

/**
 * Resolve a name the user pressed "Block" on.
 *
 *   'lumen' — the name came off a Lumen-rendered byline, so it is a handle. Resolved
 *             DB-first and never sent to the chain: a handle that is not in our
 *             database is not a person this button could have been rendered for.
 *   'hive'  — the name came off a chain-signed entry, so it is a Hive account. An
 *             upgraded Lumen user is still canonicalised to their `user_id` (that is
 *             the same person, and the id is what survives further changes); anything
 *             else is stored as a Hive node.
 *   'auto'  — caller does not know. Lumen first, then a well-formed chain name.
 *
 * ★★★ A BLOCK DOES NOT ASK THE CHAIN WHETHER THE ACCOUNT EXISTS. FOLLOWING DOES.
 * THAT DIFFERENCE IS DELIBERATE — and it was MEASURED, not assumed.
 *
 * `resolveFollowTarget` calls `checkAccountExists`, which is a live request to a
 * public Hive node, and it counts anything short of a definite "exists" as "does not
 * exist". For a FOLLOW that is right: a typo would otherwise put a phantom account on
 * somebody's Following page.
 *
 * For a BLOCK it is actively harmful. Driving the real UI while the public nodes were
 * throttling, blocking a genuine, currently-visible commenter (@offgridlife) answered
 * `404 not_found`, and the Block control on a profile never appeared at all because
 * its state query was waiting on the same lookup. So the one control a person reaches
 * for while being harassed is the one that stops working when an unrelated third
 * party is having a bad minute.
 *
 * The trade is not close. A block against a name that does not exist is INERT — it
 * hides nothing, appears on no one's page, and costs one row that rate limits already
 * bound. A block that cannot be recorded is a person left exposed. So the name is
 * checked for SHAPE (Hive's own account-name rule) and written; nothing here needs a
 * network call, which also makes the button appear immediately instead of after a
 * round trip to a chain node.
 */
export async function resolveBlockTarget(
  name: string,
  kind: BlockTargetKind = 'auto'
): Promise<TargetResolution> {
  const clean = name.trim().replace(/^@/, '').toLowerCase();
  if (!clean) return { ok: false, error: 'invalid_name' };

  if (kind === 'lumen') {
    const lumen = await users.findUserByDisplayName(clean);
    if (!lumen) return { ok: false, error: 'not_found' };
    return {
      ok: true,
      actor: { userId: lumen.userId },
      isLumenUser: true,
      isLite: lumen.accountTier === 'lite' && !lumen.hiveAccountName
    };
  }

  if (kind === 'hive') {
    const upgraded = await users.findUserByHiveAccountName(clean);
    if (upgraded) {
      return { ok: true, actor: { userId: upgraded.userId }, isLumenUser: true, isLite: false };
    }
    if (!HIVE_NAME.test(clean)) return { ok: false, error: 'invalid_name' };
    return { ok: true, actor: { hive: clean }, isLumenUser: false, isLite: false };
  }

  // 'auto' — Lumen first, then a well-formed chain name. Same no-network rule.
  const lumen =
    (await users.findUserByDisplayName(clean)) ?? (await users.findUserByHiveAccountName(clean));
  if (lumen) {
    return {
      ok: true,
      actor: { userId: lumen.userId },
      isLumenUser: true,
      isLite: lumen.accountTier === 'lite' && !lumen.hiveAccountName
    };
  }
  if (!HIVE_NAME.test(clean)) return { ok: false, error: 'invalid_name' };
  return { ok: true, actor: { hive: clean }, isLumenUser: false, isLite: false };
}

/**
 * ★★★ THE BATCHED SIBLING OF {@link resolveBlockTarget} — for a whole page's worth
 * of authors in a bounded, fixed number of queries instead of one resolution per
 * name (2026-08-12, N+1 fix — see `use-lumen-block.ts`'s doc for the measured
 * storm this exists to close).
 *
 * Same per-kind rules as the single-name version, just run as batched `IN (...)`
 * lookups instead of one-row-at-a-time ones: `'lumen'` only ever checks the handle
 * table, `'hive'` only ever checks the Hive-account table (falling back to a
 * shape check), and `'auto'` tries Lumen first, then Hive — never mixed, for the
 * same correctness reason the doc above gives (a handle and a Hive account can
 * share a spelling and be different people).
 *
 * Returns results in the SAME ORDER as `inputs`, one per element — including
 * duplicates, which are cheap here because every name was already resolved by a
 * shared lookup table built once, not re-queried.
 */
export async function resolveBlockTargetsBulk(
  inputs: { name: string; kind: BlockTargetKind }[]
): Promise<TargetResolution[]> {
  const cleaned = inputs.map((i) => i.name.trim().replace(/^@/, '').toLowerCase());

  // 'lumen' AND 'auto' both need the handle table; only 'hive' skips it.
  const lumenNames = new Set<string>();
  const hiveNames = new Set<string>();
  inputs.forEach((input, i) => {
    const clean = cleaned[i];
    if (!clean) return;
    if (input.kind === 'hive') hiveNames.add(clean);
    else lumenNames.add(clean);
  });

  const [lumenRows, hiveRows] = await Promise.all([
    lumenNames.size > 0 ? users.findUsersByDisplayNames([...lumenNames]) : Promise.resolve([]),
    hiveNames.size > 0 ? users.findUsersByHiveAccountNames([...hiveNames]) : Promise.resolve([])
  ]);
  const byDisplayName = new Map(lumenRows.map((r) => [r.displayName.toLowerCase(), r]));
  const byHiveName = new Map(hiveRows.map((r) => [(r.hiveAccountName ?? '').toLowerCase(), r]));

  // An 'auto' name that missed the handle table still needs the Hive-account
  // fallback `resolveBlockTarget`'s own 'auto' branch takes — one more batched
  // query, scoped to only the names that actually need it, rather than a lookup
  // per miss.
  const autoFallbackNames = new Set<string>();
  inputs.forEach((input, i) => {
    const clean = cleaned[i];
    if (input.kind === 'auto' && clean && !byDisplayName.has(clean)) autoFallbackNames.add(clean);
  });
  if (autoFallbackNames.size > 0) {
    const rows = await users.findUsersByHiveAccountNames([...autoFallbackNames]);
    for (const row of rows) if (row.hiveAccountName) byHiveName.set(row.hiveAccountName.toLowerCase(), row);
  }

  return inputs.map((input, i): TargetResolution => {
    const clean = cleaned[i];
    if (!clean) return { ok: false, error: 'invalid_name' };

    if (input.kind === 'lumen') {
      const row = byDisplayName.get(clean);
      if (!row) return { ok: false, error: 'not_found' };
      return {
        ok: true,
        actor: { userId: row.userId },
        isLumenUser: true,
        isLite: row.accountTier === 'lite' && !row.hiveAccountName
      };
    }

    if (input.kind === 'hive') {
      const upgraded = byHiveName.get(clean);
      if (upgraded) return { ok: true, actor: { userId: upgraded.userId }, isLumenUser: true, isLite: false };
      if (!HIVE_NAME.test(clean)) return { ok: false, error: 'invalid_name' };
      return { ok: true, actor: { hive: clean }, isLumenUser: false, isLite: false };
    }

    // 'auto'
    const lumenRow = byDisplayName.get(clean);
    if (lumenRow) {
      return {
        ok: true,
        actor: { userId: lumenRow.userId },
        isLumenUser: true,
        isLite: lumenRow.accountTier === 'lite' && !lumenRow.hiveAccountName
      };
    }
    const upgraded = byHiveName.get(clean);
    if (upgraded) return { ok: true, actor: { userId: upgraded.userId }, isLumenUser: true, isLite: false };
    if (!HIVE_NAME.test(clean)) return { ok: false, error: 'invalid_name' };
    return { ok: true, actor: { hive: clean }, isLumenUser: false, isLite: false };
  });
}

/**
 * ★ WHICH NODE WROTE THIS ENTRY — for a whole page, in at most two queries.
 *
 * Every filter in this feature reduces to "is this entry's author one of these
 * nodes", and an entry can present its author in three different ways:
 *
 *   1. `_lite.userId` — set server-side by `render/attach-lite.ts`,
 *      `render/lite-entry.ts` and `render/db-post-to-entry.ts` whenever we have
 *      PROVED the entry is a given Lumen post (the row records who signed it, and
 *      an entry signed by anyone else is left alone). This is the exact answer and
 *      needs no lookup at all.
 *   2. `_lite` present but no `userId` — an entry relabelled by an older path.
 *      Its `author` is a Lumen HANDLE; resolved against `display_name` only.
 *   3. no `_lite` — an ordinary chain entry. Its `author` is a HIVE ACCOUNT;
 *      resolved against `hive_account_name` only, so that an unrelated Lumen handle
 *      of the same spelling cannot capture it.
 *
 * Never mixes 2 and 3. That separation is the whole reason this exists.
 */
export interface EntryActorResolver {
  keyOf(entry: Entry | null | undefined): string | null;
}

/**
 * What to do when a user-lookup query FAILS (as opposed to returning no rows).
 *
 * ★★★ WHY THIS IS A PARAMETER AND NOT A FIXED POLICY (2026-08-12).
 *
 * Both lookups below used to end in `.catch(() => [])`, which turns "the
 * database errored" into "resolved, found nobody". For an UPGRADED user — one
 * with both a Hive account and a Lumen `userId` — that means they get keyed by
 * their chain name instead of their Lumen id, so a block edge recorded against
 * the Lumen id is never matched, and their blocked comment is served.
 *
 * That is effect (B) failing OPEN, and it silently defeated the fail-closed
 * guard added to `block-filter.ts` the same day: the guard's try/catch never
 * fired, because the callee had already eaten the error before it could.
 *
 * But the swallow could not simply be removed, because this resolver serves
 * BOTH effects, and they want opposite things on failure:
 *
 *   'throw'   — effect (B) (`applyOwnerBlocksTo{Thread,Replies,AuthoredEntries}`).
 *               "Their comments under my content are served to nobody" is a
 *               promise a reader cannot opt out of. Unenforceable means unservable:
 *               every caller answers empty, never unfiltered, so a failure costs a
 *               thread rather than exposing content the owner removed.
 *   'degrade' — effect (A) (`filterBlockedForViewer`). This is the viewer's OWN
 *               "I never see them" preference. Failing closed here would blank a
 *               reader's entire feed over a database hiccup, which is the larger
 *               harm; showing someone they blocked for a moment is the smaller.
 *               This is a documented, deliberate decision, not an oversight.
 *
 * Default is 'degrade' so that any future caller is, at worst, no worse off than
 * before this parameter existed. Effect (B) call sites opt in explicitly.
 */
export type ActorLookupFailurePolicy = 'throw' | 'degrade';

export async function buildEntryActorResolver(
  entries: (Entry | null | undefined)[],
  { onLookupFailure = 'degrade' }: { onLookupFailure?: ActorLookupFailurePolicy } = {}
): Promise<EntryActorResolver> {
  const hiveNames = new Set<string>();
  const handleNames = new Set<string>();

  for (const entry of entries) {
    if (!entry) continue;
    if (entry._lite?.userId) continue;
    const author = (entry.author ?? '').toLowerCase();
    if (!author) continue;
    if (entry._lite) handleNames.add(author);
    else hiveNames.add(author);
  }

  const byHive = new Map<string, string>();
  const byHandle = new Map<string, string>();
  // See `ActorLookupFailurePolicy` above for why this is the caller's choice.
  // Under 'degrade' a failed lookup falls back to chain identity, exactly as
  // before; under 'throw' it propagates so the caller can fail closed.
  const onFailure = (error: unknown): never[] => {
    if (onLookupFailure === 'throw') throw error;
    return [];
  };
  if (hiveNames.size > 0) {
    const rows = await users.findUsersByHiveAccountNames([...hiveNames]).catch(onFailure);
    for (const row of rows) {
      if (row.hiveAccountName) byHive.set(row.hiveAccountName.toLowerCase(), row.userId);
    }
  }
  if (handleNames.size > 0) {
    const rows = await users.findUsersByDisplayNames([...handleNames]).catch(onFailure);
    for (const row of rows) byHandle.set(row.displayName.toLowerCase(), row.userId);
  }

  return {
    keyOf(entry) {
      if (!entry) return null;
      if (entry._lite?.userId) return actorKey({ userId: entry._lite.userId });
      const author = (entry.author ?? '').toLowerCase();
      if (!author) return null;
      if (entry._lite) {
        const userId = byHandle.get(author);
        // A handle with no Lumen row is nobody we can name. Returning `h:<handle>`
        // here would invent a Hive node for a name that is not a Hive account.
        return userId ? actorKey({ userId }) : null;
      }
      const upgraded = byHive.get(author);
      return upgraded ? actorKey({ userId: upgraded }) : actorKey({ hive: author });
    }
  };
}

/**
 * The node a DISPLAYED name belongs to, without a chain round trip.
 *
 * Used by read paths that hold a name and nothing else (a profile page, a feed card
 * whose entry has already been relabelled). Never creates a Hive node for a name the
 * chain has not confirmed — it simply returns the chain-shaped actor, which is
 * exactly what a block edge against a real account is keyed on.
 */
export async function actorForDisplayedName(
  name: string,
  kind: Exclude<BlockTargetKind, 'auto'>
): Promise<FollowActor | null> {
  const clean = name.trim().replace(/^@/, '').toLowerCase();
  if (!clean) return null;
  if (kind === 'lumen') {
    const lumen = await users.findUserByDisplayName(clean).catch(() => null);
    return lumen ? { userId: lumen.userId } : null;
  }
  const upgraded = await users.findUserByHiveAccountName(clean).catch(() => null);
  return upgraded ? { userId: upgraded.userId } : { hive: clean };
}
