import { NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { sessionActor } from '@/blog/lib/lite/social/follow-actor';
import * as blocks from '@/blog/lib/lite/repositories/block-repository';
import * as users from '@/blog/lib/lite/repositories/user-repository';

const logger = getLogger('app');

/** One blocked account, shaped for a "Blocked Accounts" settings row rather than
 *  for filter-matching — see `peers` below. */
export interface BlockedPeerView {
  /** As-stored casing (a Lumen display name, or the Hive account name). */
  name: string;
  /** Which name-space `name` is from — exactly what `/api/lite/unblock` needs as
   *  `targetKind` to resolve back to the SAME actor this row names. */
  kind: 'hive' | 'lumen';
}

export interface BlockListResponse {
  ok: boolean;
  /** Stable node keys — `u:<user_id>` / `h:<hive name>`. The exact identity. */
  keys: string[];
  /** Lumen account ids, for matching `entry._lite.userId` without a lookup. */
  userIds: string[];
  /** Lower-cased names as a reader would see them, for matching `entry.author`. */
  names: string[];
  /**
   * ★ ADDED 2026-08-12, FOR THE "BLOCKED ACCOUNTS" SETTINGS CARD.
   * `keys`/`userIds`/`names` above are shaped for effect-(A) FILTER matching —
   * merged into flat, deduped, lower-cased sets, which throws away exactly the
   * per-peer (name, name-space) pairing a settings row needs to render "@name" and
   * offer a working Unblock button. `block-repository.ts`'s `listBlockedPeers` doc
   * already anticipated this screen ("The people behind the list — for a 'Blocked
   * accounts' settings screen"); nothing had rendered it until now. One entry per
   * blocked peer, in the same order `listBlockedPeers` returned them (most recent
   * block first).
   */
  peers: BlockedPeerView[];
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

  const empty: BlockListResponse = { ok: true, keys: [], userIds: [], names: [], peers: [] };
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

    // ★ ONE ROW PER PEER, NOT MERGED — see `BlockedPeerView`'s doc. `kind: 'lumen'`
    // for a `userId` peer even when the row also has a `hiveAccountName` (an
    // upgraded account): `resolveBlockTarget('lumen', displayName)` still resolves
    // it to the same `userId` `unblockByName` needs, and using the DISPLAY name
    // here keeps this list showing the same handle the rest of the app shows for
    // that person, not a name they may have moved on from.
    const rowById = new Map(rows.map((row) => [row.userId, row]));
    const peerViews: BlockedPeerView[] = [];
    for (const peer of peers) {
      if (peer.userId) {
        const row = rowById.get(peer.userId);
        // A block can outlive the account it named (deleted/unknown row) — skip
        // rather than render a name we cannot resolve. The filter-matching fields
        // above are unaffected; this only trims this settings list's display rows.
        if (row) peerViews.push({ name: row.displayName, kind: 'lumen' });
      } else if (peer.hive) {
        peerViews.push({ name: peer.hive, kind: 'hive' });
      }
    }

    return NextResponse.json({
      ok: true,
      keys: peers.map((p) => (p.userId ? `u:${p.userId}` : `h:${(p.hive ?? '').toLowerCase()}`)),
      userIds,
      names: [...names],
      peers: peerViews
    } satisfies BlockListResponse);
  } catch (error) {
    logger.error(error, 'Lumen block list failed');
    // An empty list degrades to "show everything", which is the defensible failure
    // here: this route serves effect (A), the VIEWER's own "I never see them"
    // preference, and failing closed would blank a reader's whole feed on a database
    // hiccup. Effect (B) — the half nobody can opt out of — does not read this route
    // at all; it reads `block-repository` directly, server-side (block-filter.ts).
    //
    // ★ BUT IT MUST NOT CLAIM SUCCESS (2026-08-12). This returned `empty`, and
    // `empty` is declared with `ok: true` for the legitimately-empty cases above (an
    // anonymous caller, a reader who has blocked nobody). So a genuine database
    // failure answered `200 {ok: true, ...}`: indistinguishable from "this reader
    // blocks nobody", and a lie told through the exact field that exists to signal
    // failure. Any caller that later starts trusting `ok` would have been misled by
    // it. Degrading the DATA is a judgement call; misreporting the STATUS is not.
    return NextResponse.json({ ...empty, ok: false });
  }
}
