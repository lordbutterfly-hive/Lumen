import { NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { sessionActor } from '@/blog/lib/lite/social/follow-actor';
import * as blocks from '@/blog/lib/lite/repositories/block-repository';
import * as users from '@/blog/lib/lite/repositories/user-repository';

const logger = getLogger('app');

export interface BlockListResponse {
  ok: boolean;
  /** Stable node keys — `u:<user_id>` / `h:<hive name>`. The exact identity. */
  keys: string[];
  /** Lumen account ids, for matching `entry._lite.userId` without a lookup. */
  userIds: string[];
  /** Lower-cased names as a reader would see them, for matching `entry.author`. */
  names: string[];
}

/**
 * GET /api/lite/block/list — everyone the SIGNED-IN VIEWER has blocked.
 *
 * ★ WHAT THIS IS FOR, AND WHAT IT IS NOT FOR.
 *
 * This serves effect (A) only — "I never see them again" — on the surfaces the
 * browser fetches straight from a Hive node (a profile's post list, the chain
 * Following feed, search). Those calls never reach a Lumen server, so the only place
 * left to apply the viewer's own preference is the client, and that is acceptable
 * *for this half*: the person a client-side filter could be bypassed by is the
 * viewer themselves, and all they would win is seeing something they asked not to.
 *
 * Effect (B) — "their comments on my post are hidden from EVERYONE" — is NOT served
 * from here and must never be. That one protects third parties, so it is enforced
 * server-side before the bytes leave (`lib/lite/social/block-filter.ts`, applied in
 * `/api/discussion`, the post page's SSR, and `/api/lite/posts/replies`). A client
 * filter would be trivially removed by the very reader it is meant to keep out.
 *
 * Returns nothing but an empty list for an anonymous caller — a viewer's block list
 * is their own, and a name in it is a statement about who they cannot stand.
 */
export async function GET(): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const empty: BlockListResponse = { ok: true, keys: [], userIds: [], names: [] };
  try {
    const session = await getLiteSession();
    const actor = await sessionActor(session.user);
    if (!actor) return NextResponse.json(empty);

    const peers = await blocks.listBlockedPeers(actor, { limit: 1000 });
    if (peers.length === 0) return NextResponse.json(empty);

    const userIds = peers.map((p) => p.userId).filter((id): id is string => Boolean(id));
    const rows = await users.findUsersByIds(userIds).catch(() => []);
    const names = new Set<string>();
    for (const peer of peers) if (peer.hive) names.add(peer.hive.toLowerCase());
    for (const row of rows) {
      // BOTH names a Lumen account can be rendered under. An upgraded user's posts
      // carry their Hive name, their older ones their handle, and a filter that knew
      // only one of the two would hide half of the same person.
      names.add(row.displayName.toLowerCase());
      if (row.hiveAccountName) names.add(row.hiveAccountName.toLowerCase());
    }

    return NextResponse.json({
      ok: true,
      keys: peers.map((p) => (p.userId ? `u:${p.userId}` : `h:${(p.hive ?? '').toLowerCase()}`)),
      userIds,
      names: [...names]
    } satisfies BlockListResponse);
  } catch (error) {
    logger.error(error, 'Lumen block list failed');
    // An empty list degrades to "show everything", which is the honest failure: the
    // alternative — failing closed — would blank a reader's whole feed on a database
    // hiccup. Effect (B) is unaffected; it does not read this route.
    return NextResponse.json(empty);
  }
}
