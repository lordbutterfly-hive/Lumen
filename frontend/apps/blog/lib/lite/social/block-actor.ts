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

export async function buildEntryActorResolver(
  entries: (Entry | null | undefined)[]
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
  // Failures degrade to chain identity rather than throwing: a block that cannot be
  // resolved must not take a comment thread down with it.
  if (hiveNames.size > 0) {
    const rows = await users.findUsersByHiveAccountNames([...hiveNames]).catch(() => []);
    for (const row of rows) {
      if (row.hiveAccountName) byHive.set(row.hiveAccountName.toLowerCase(), row.userId);
    }
  }
  if (handleNames.size > 0) {
    const rows = await users.findUsersByDisplayNames([...handleNames]).catch(() => []);
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
