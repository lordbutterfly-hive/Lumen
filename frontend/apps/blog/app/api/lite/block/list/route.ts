import { NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { liveViewerId } from '@/blog/lib/lite/http/actor';
import { sessionActor } from '@/blog/lib/lite/social/follow-actor';
import { chainMutedKeysOfActor } from '@/blog/lib/lite/social/chain-mute';
import * as blocks from '@/blog/lib/lite/repositories/block-repository';
import * as users from '@/blog/lib/lite/repositories/user-repository';

/**
 * ★★★ EXPLICIT, BECAUSE THIS ROUTE WAS ONE UNDOCUMENTED INTERNAL AWAY FROM
 * SHIPPING A FROZEN, WRONG ANSWER (found 2026-08-25).
 *
 * `getLiteSession()` reads `cookies()`, which is what should force this route
 * dynamic. But that call sits inside a broad `try/catch` that swallows the
 * `DynamicServerError` Next throws to signal exactly that, and returns a normal
 * 200 instead. At build time the swallow won: the build EXECUTED this handler
 * and wrote a session-less snapshot to `.next-qa/server/app/api/lite/block/
 * list.body`. It stayed out of the active prerender manifest only because Next
 * flags its dynamic store the instant `cookies()` is invoked, independently of
 * whether the resulting error is later swallowed — an implementation detail of
 * the framework, not a property of this code.
 *
 * A per-viewer session route must never be cacheable by accident, and must
 * never depend on an internal to stay that way. Sibling routes that get this
 * right by construction (`lite/auth/methods`, `lite/profile`, `lite/retention`)
 * call `getLiteSession()` OUTSIDE any try/catch, so the throw propagates and
 * static generation aborts cleanly. This route needs its broad catch for its
 * own reasons, so it states the requirement directly instead.
 */
export const dynamic = 'force-dynamic';

const logger = getLogger('app');

/**
 * One blocked account, shaped for the merged "Blocked" settings row rather than
 * for filter-matching — see `peers` below.
 *
 * ★ `source` IS THE HONEST WRINKLE (owner ruling, 2026-08-12). Mute and Block are
 * one concept and this route shows them as one list — same wording, same row shape,
 * no "muted" label anywhere. But a Lumen block is a row this app owns and can retract
 * on the spot; a chain-sourced entry is somebody's real on-chain `ignore`, which only
 * a signed transaction can remove, and a lite account HAS no signer at all (confirmed
 * by the owner: "Lite accounts do not have Hive mutes. They only have Lumen blocks.").
 * `source` is the one field that survives that difference, and it exists so the
 * Settings card can show a working "Unblock" for a `'lumen'` row and an honest
 * "this needs Hive Keychain" explanation for a `'chain'`/`'both'` one, rather than one
 * button that silently does nothing for half the list.
 */
export interface BlockedPeerView {
  /** As-stored casing (a Lumen display name, or the Hive account name). */
  name: string;
  /** Which name-space `name` is from — exactly what `/api/lite/unblock` needs as
   *  `targetKind` to resolve back to the SAME actor this row names. Always `'hive'`
   *  for a `source: 'chain'`/`'both'` row — a chain mute can only ever name a real
   *  Hive account. */
  kind: 'hive' | 'lumen';
  /**
   * `'lumen'` — a real `lumen_block` row; `/api/lite/unblock` removes it instantly.
   * `'chain'` — derived from THIS viewer's own on-chain ignore list; there is no
   *   local row to delete, only a signed unmute transaction. No local override is
   *   offered (see the Settings card) — the entry stays listed for as long as the
   *   chain mute does, which is the honest state.
   * `'both'` — the (rare) case where the same account is ALSO a live `lumen_block`.
   *   Unblocking here removes the Lumen row; the chain mute is independent and the
   *   row stays listed, now as `'chain'` on the next read, until it is removed on
   *   chain too.
   */
  source: 'lumen' | 'chain' | 'both';
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
 *
 * ★ CHAIN MUTES MERGED IN (owner ruling, 2026-08-12). "if someone mutes on peakd it
 * should be treated as blocked on Lumen" — so this now ALSO reads the viewer's own
 * on-chain ignore list (`chainMutedKeysOfActor`, `lib/lite/social/chain-mute.ts`) and
 * folds it into every field, including `peers`. It degrades to "no chain mutes known
 * right now" on a chain read failure rather than failing the whole response — the
 * SAME posture the catch below already takes for a Lumen-block DB failure, for the
 * same reason: this route is effect (A), and effect (A) fails open, never closed.
 */
export async function GET(): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const empty: BlockListResponse = { ok: true, keys: [], userIds: [], names: [], peers: [] };
  try {
    // ★ A REVOKED COOKIE IS NOT THIS VIEWER (2026-08-23). This returns the viewer's own
    // private list, and it read the cookie directly — so `logout-all` did not stop it.
    // Degrades to anonymous rather than 401: the shape callers expect is an empty list,
    // and a hard refusal on a read would be a worse failure than a missing personalisation.
    const session = await getLiteSession();
    const liveId = await liveViewerId(session.user, session);
    const actor = liveId ? await sessionActor(session.user) : null;
    if (!actor) return NextResponse.json(empty);

    const [peers, chainMutes] = await Promise.all([
      blocks.listBlockedPeers(actor, { limit: 1000 }),
      chainMutedKeysOfActor(actor)
    ]);
    if (peers.length === 0 && chainMutes.names.length === 0) return NextResponse.json(empty);

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
    for (const name of chainMutes.names) names.add(name);

    // ★ ONE ROW PER PEER, NOT MERGED — see `BlockedPeerView`'s doc. `kind: 'lumen'`
    // for a `userId` peer even when the row also has a `hiveAccountName` (an
    // upgraded account): `resolveBlockTarget('lumen', displayName)` still resolves
    // it to the same `userId` `unblockByName` needs, and using the DISPLAY name
    // here keeps this list showing the same handle the rest of the app shows for
    // that person, not a name they may have moved on from.
    const rowById = new Map(rows.map((row) => [row.userId, row]));
    const chainMutedNames = new Set(chainMutes.names);
    const peerViews: BlockedPeerView[] = [];
    // Which Lumen-blocked Hive names this loop already rendered, so a chain mute
    // against the SAME account below is folded into that row as `source: 'both'`
    // instead of appearing a second time.
    const renderedHiveNames = new Set<string>();
    for (const peer of peers) {
      if (peer.userId) {
        const row = rowById.get(peer.userId);
        // A block can outlive the account it named (deleted/unknown row) — skip
        // rather than render a name we cannot resolve. The filter-matching fields
        // above are unaffected; this only trims this settings list's display rows.
        if (row) peerViews.push({ name: row.displayName, kind: 'lumen', source: 'lumen' });
      } else if (peer.hive) {
        const lower = peer.hive.toLowerCase();
        renderedHiveNames.add(lower);
        peerViews.push({
          name: peer.hive,
          kind: 'hive',
          source: chainMutedNames.has(lower) ? 'both' : 'lumen'
        });
      }
    }
    for (const name of chainMutedNames) {
      if (renderedHiveNames.has(name)) continue;
      peerViews.push({ name, kind: 'hive', source: 'chain' });
    }

    return NextResponse.json({
      ok: true,
      keys: [
        ...new Set([
          ...peers.map((p) => (p.userId ? `u:${p.userId}` : `h:${(p.hive ?? '').toLowerCase()}`)),
          ...chainMutes.keys
        ])
      ],
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
