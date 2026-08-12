import { Entry } from '@hive/common-hiveio-packages/wax';
import { User } from '@smart-signer/types/common';
import * as blocks from '../repositories/block-repository';
import * as posts from '../repositories/post-repository';
import { liteConfig } from '../config';
import { litePostIdOf } from '../render/lite-post-id';
import { FollowActor, actorKey, sessionActor } from './follow-actor';
import { actorForDisplayedName, buildEntryActorResolver } from './block-actor';
import {
  chainMutedKeysOfActor,
  hiveNameOfActor,
  hiveNamesByUserId,
  ownerChainMutedNamesOrThrow
} from './chain-mute';

/**
 * ★★★ WHERE A BLOCK ACTUALLY REMOVES SOMETHING.
 *
 * Two filters, and they are not variations of one another — they answer to different
 * people and therefore have to run in different places.
 *
 *  (A) {@link filterBlockedForViewer} — "I never see them again."
 *      Whose preference: the READER's. Applied to whatever we are about to hand that
 *      one reader.
 *
 *  (B) {@link applyOwnerBlocksToThread} — "their comments under my content are not
 *      served to ANYONE."
 *      Whose preference: the CONTENT OWNER's, enforced against every other reader.
 *      This one CANNOT be a client-side filter. The people it protects the thread
 *      from are exactly the people whose browsers would be running it, and a reader
 *      who wants to see the comment need only not run the code. It has to happen
 *      before the bytes leave the server, which is why every thread-serving path
 *      calls this and none of them ship a block list to the client.
 *
 * THE RULE FOR (B), in the owner's own words: "block should stop those accounts from
 * being seen by anyone on a comment, reply, post made by the author that blocked
 * them." So a reply is hidden when ANY of the things it hangs under — the root post,
 * or any comment between it and the root — was written by somebody who blocked its
 * author. Not just the root post: a reply under my comment is under my content too.
 *
 * AND THE SUBTREE GOES WITH IT. Replies to a hidden comment are hidden as well. Two
 * reasons: a conversation hanging off nothing is unreadable, and — the one that
 * matters — replies routinely quote what they answer, so leaving them would serve the
 * blocked words back through somebody else's mouth.
 *
 * ★★★ AND A CHAIN MUTE IS NOW READ AS THE SAME THING (owner ruling, 2026-08-12):
 * "mutes and blocks are treated the same... if someone mutes on peakd it should be
 * treated as blocked on Lumen." Every function below now ALSO consults
 * `chain-mute.ts` — (A) the viewer's own on-chain ignore list, (B) the content
 * owner's — and folds it into the SAME `hidden` set a Lumen block would populate.
 * There is no separate "chain-muted" code path through these filters; a name in
 * either source is simply blocked. The one place the two sources are told apart at
 * all is the Settings list and its removal control, because a chain entry needs a
 * signed transaction to remove and a Lumen block does not — see `chain-mute.ts`'s
 * header for the fail-open/fail-closed split that follows from effect (A) vs (B), and
 * `/api/lite/block/list`'s `source` field for where the removal-path distinction is
 * actually surfaced.
 */

/** `${author}/${permlink}`, the key `bridge.get_discussion` uses for its map. */
function coordKey(entry: Entry): string {
  return `${entry.author}/${entry.permlink}`;
}

function parentCoordKey(entry: Entry): string | null {
  if (!entry.parent_author || !entry.parent_permlink) return null;
  return `${entry.parent_author}/${entry.parent_permlink}`;
}

/**
 * The Hive account name behind one ENTRY's author, for matching against a chain mute
 * list — as opposed to `EntryActorResolver.keyOf`, which answers in the Lumen
 * `u:`/`h:` key space a Lumen block is stored in. The two are different questions: a
 * pure lite author has a perfectly good Lumen key (`u:<id>`) but no Hive identity at
 * all, and a chain mute can never name them (confirmed by the owner: "Lite accounts
 * do not have Hive mutes"). Costs one row lookup for an upgraded `_lite` author and
 * nothing at all for an ordinary chain entry, whose `author` IS the answer.
 */
async function ownerHiveNameOfEntry(entry: Entry): Promise<string | null> {
  if (entry._lite) {
    return entry._lite.userId ? hiveNameOfActor({ userId: entry._lite.userId }) : null;
  }
  return (entry.author ?? '').toLowerCase() || null;
}

/**
 * The same question, batched over a whole page of entries: every entry's Hive
 * account name, keyed by `coordKey`, or `null` where the author has none. One query
 * for every DISTINCT `_lite.userId` in the page, regardless of how many entries
 * share it — a thread routinely has several replies from the same lite author.
 */
async function authorHiveNamesOf(entries: Entry[]): Promise<Map<string, string | null>> {
  const liteUserIds = entries.map((entry) => entry._lite?.userId).filter((id): id is string => Boolean(id));
  const hiveNameByUserId = await hiveNamesByUserId(liteUserIds);
  const map = new Map<string, string | null>();
  for (const entry of entries) {
    const coord = coordKey(entry);
    if (entry._lite) {
      map.set(coord, entry._lite.userId ? (hiveNameByUserId.get(entry._lite.userId) ?? null) : null);
    } else {
      map.set(coord, (entry.author ?? '').toLowerCase() || null);
    }
  }
  return map;
}

/**
 * Effect (B) over one thread. Returns the entries that may be served, in input order.
 *
 * Cost: two batched user lookups (`buildEntryActorResolver`) plus ONE block query for
 * the entire thread, regardless of how many comments it has — plus, now, ONE chain
 * mute lookup for the root post's owner (cached; see `chain-mute.ts`), never one per
 * commenter.
 */
export async function applyOwnerBlocksToThread<T extends Entry>(entries: T[]): Promise<T[]> {
  if (entries.length < 2) return entries;

  const resolver = await buildEntryActorResolver(entries, { onLookupFailure: 'throw' });
  const keyByCoord = new Map<string, string | null>();
  const byCoord = new Map<string, T>();
  for (const entry of entries) {
    const coord = coordKey(entry);
    byCoord.set(coord, entry);
    keyByCoord.set(coord, resolver.keyOf(entry));
  }

  // Every participant is both a potential blocker (as somebody's ancestor) and a
  // potential blocked party, so one set serves both sides of the single query.
  const participants = [...new Set([...keyByCoord.values()].filter((k): k is string => Boolean(k)))];
  const blockedPairs =
    participants.length >= 2 ? await blocks.blockedPairsAmong(participants, participants) : new Set<string>();

  // ★ CHAIN-MUTE REACH — the ROOT POST OWNER's on-chain ignore list, and ONLY
  // theirs; see `ownerChainMutedNamesOrThrow`'s doc for why this does not walk
  // every ancestor the way the Lumen-block loop below does. Computed
  // UNCONDITIONALLY — independent of `blockedPairs` — because a thread with zero
  // Lumen blocks can still have a root author whose PeakD mutes should hide
  // replies here. Fails CLOSED: an unresolvable owner throws, and every caller of
  // this function already answers "no thread" rather than an unfiltered one when
  // its OWN Lumen-block resolution throws (see `[permlink]/page.tsx` and
  // `/api/discussion`'s "FAIL EMPTY, NEVER FAIL OPEN").
  const root = entries.find((entry) => !parentCoordKey(entry));
  const rootOwnerName = root ? await ownerHiveNameOfEntry(root) : null;
  const chainMuted = rootOwnerName
    ? await ownerChainMutedNamesOrThrow({ hive: rootOwnerName })
    : new Set<string>();

  if (blockedPairs.size === 0 && chainMuted.size === 0) return entries;

  const hidden = new Set<string>();
  for (const entry of entries) {
    const coord = coordKey(entry);
    const authorKey = keyByCoord.get(coord);
    if (!authorKey) continue;

    // Walk to the root. `seen` bounds it: `parent_author`/`parent_permlink` come off
    // chain data, and a cycle there would otherwise be an infinite loop in a request.
    const seen = new Set<string>([coord]);
    let cursor: string | null = parentCoordKey(entry);
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const ancestorKey = keyByCoord.get(cursor);
      if (ancestorKey && blockedPairs.has(blocks.pairKey(ancestorKey, authorKey))) {
        hidden.add(coord);
        break;
      }
      const ancestor = byCoord.get(cursor);
      cursor = ancestor ? parentCoordKey(ancestor) : null;
    }
  }

  // Chain-mute reach: every entry is checked directly against the ROOT owner's
  // ignore list — no ancestor walk, because only the root's chain state was ever
  // fetched (see the note above).
  if (chainMuted.size > 0) {
    const authorHiveName = await authorHiveNamesOf(entries);
    for (const entry of entries) {
      const coord = coordKey(entry);
      if (hidden.has(coord)) continue;
      const name = authorHiveName.get(coord);
      if (name && chainMuted.has(name)) hidden.add(coord);
    }
  }

  if (hidden.size === 0) return entries;

  // Cascade downwards. Depth order is not guaranteed by the source, so repeat until
  // nothing new is marked — bounded by the number of entries, which is bounded by the
  // page. A single pass would leave a grandchild of a hidden comment behind.
  for (let pass = 0; pass < entries.length; pass += 1) {
    let grew = false;
    for (const entry of entries) {
      const coord = coordKey(entry);
      if (hidden.has(coord)) continue;
      const parent = parentCoordKey(entry);
      if (parent && hidden.has(parent)) {
        hidden.add(coord);
        grew = true;
      }
    }
    if (!grew) break;
  }

  // ★ AND TAKE THEIR NAME OUT OF THE SURVIVORS' `replies` LISTS.
  //
  // MEASURED, not theorised (server-rendered HTML, 2026-08-10): with the blocked
  // subtree correctly removed, the ROOT POST's own entry still carried
  // `"replies": [..., "hive-124221/re-wiseagent-...", ...]` — Hivemind attaches the
  // child coordinates to every parent. So the blocked account's NAME was still being
  // served to every reader, on the very page the block was supposed to remove them
  // from, along with a working link to their comment. Nothing renders that array
  // today, which is exactly why it would have gone unnoticed.
  //
  // A shallow copy rather than an in-place splice: these entries are handed onward
  // (and, on other paths, cached), and quietly editing an array someone else may hold
  // a reference to is how a filter starts affecting requests it was never applied to.
  //
  // `children` is deliberately LEFT ALONE. It is a count, not an identity — it leaks
  // nobody — and rewriting it would mean this filter silently disagreeing with the
  // chain's own reply count everywhere else in the app.
  return entries
    .filter((entry) => !hidden.has(coordKey(entry)))
    .map((entry) => {
      const replies = entry.replies;
      if (!Array.isArray(replies) || replies.length === 0) return entry;
      const kept = replies.filter((r) => typeof r !== 'string' || !hidden.has(r));
      return kept.length === replies.length ? entry : { ...entry, replies: kept };
    });
}

/** Same, for the keyed map `bridge.get_discussion` returns. */
export async function applyOwnerBlocksToDiscussion<T extends Entry>(
  discussion: Record<string, T> | null | undefined
): Promise<Record<string, T> | null> {
  if (!discussion) return discussion ?? null;
  const entries = Object.values(discussion);
  const kept = await applyOwnerBlocksToThread(entries);
  // Nothing to do: the filter returns the SAME array when it changed nothing.
  if (kept === entries) return discussion;

  // ★ RE-KEYED BY COORDINATE, NOT BY OBJECT IDENTITY.
  //
  // This used to build the result with `keep.has(entry)` over the original objects,
  // which was correct only while the filter could only ever DROP entries. It can now
  // also return a REPLACEMENT for a survivor (a copy with the blocked coordinates
  // stripped out of its `replies`), and an identity test silently discards every one
  // of those — including the root post, whose `replies` list is exactly what needed
  // stripping. Measured immediately: the served page lost another 44KB and the post
  // itself disappeared. Coordinates are what a discussion map is keyed on anyway.
  const byCoord = new Map(kept.map((entry) => [coordKey(entry), entry]));
  const out: Record<string, T> = {};
  for (const [key, entry] of Object.entries(discussion)) {
    const survivor = byCoord.get(coordKey(entry));
    if (survivor) out[key] = survivor;
  }
  return out;
}

/**
 * Effect (B) for a reply list whose parent is known from the request rather than
 * from the data — `/api/lite/posts/replies`, where every row is a direct reply to one
 * named post and the post itself is not in the list.
 */
export async function applyOwnerBlocksToReplies<T extends Entry>(
  entries: T[],
  owner: FollowActor | null
): Promise<T[]> {
  if (!owner || entries.length === 0) return entries;
  const ownerKey = actorKey(owner);
  const resolver = await buildEntryActorResolver(entries, { onLookupFailure: 'throw' });
  const authorKeys = entries
    .map((entry) => resolver.keyOf(entry))
    .filter((k): k is string => Boolean(k));

  // Chain-mute reach for this same owner — see `ownerChainMutedNamesOrThrow`'s doc.
  // Fetched unconditionally, independent of `authorKeys`: a page whose every entry
  // failed to resolve a LUMEN key can still have entries resolvable by Hive name.
  const chainMuted = await ownerChainMutedNamesOrThrow(owner);

  if (authorKeys.length === 0 && chainMuted.size === 0) return entries;

  const blockedPairs =
    authorKeys.length > 0 ? await blocks.blockedPairsAmong([ownerKey], authorKeys) : new Set<string>();
  if (blockedPairs.size === 0 && chainMuted.size === 0) return entries;

  const authorHiveName = chainMuted.size > 0 ? await authorHiveNamesOf(entries) : null;
  return entries.filter((entry) => {
    const key = resolver.keyOf(entry);
    if (key && blockedPairs.has(blocks.pairKey(ownerKey, key))) return false;
    if (authorHiveName) {
      const name = authorHiveName.get(coordKey(entry));
      if (name && chainMuted.has(name)) return false;
    }
    return true;
  });
}

/**
 * Effect (B) for one author's OWN post/comment history -- the profile Posts and
 * Comments tabs (`getAccountPosts` sort `'comments'`, and the lite-account
 * equivalent `getLiteUserPosts`). Every entry here has a DIFFERENT parent, and
 * that parent is essentially never in `entries`: the array is one person's
 * writing across many unrelated threads, not one conversation. That rules out
 * {@link applyOwnerBlocksToThread}'s trick of resolving ancestry by looking the
 * coordinate up inside the same array: on this shape there is nothing there to
 * find, and wiring that function in here would silently hide nothing.
 *
 * ★★★ ONE HOP, DELIBERATELY -- READ THIS BEFORE "FIXING" IT.
 *
 * This checks only the entry's DIRECT parent: does the account that wrote
 * `parent_author`/`parent_permlink` (the root post, or an intermediate
 * comment) have a live block against THIS entry's author? That is the actual
 * spam vector this feature exists to close: a blocked account replying
 * straight onto the blocker's post or comment and then pointing people at
 * their own profile to read it, answered from a field every entry already
 * carries, with no extra fetch per level.
 *
 * What it does NOT catch: a comment nested two or more levels under the
 * blocker's content, whose own immediate parent is a THIRD party's comment.
 * Per the owner's rule ("a reply under my comment is under my content too",
 * see the file header) that comment is under the blocker's content too and
 * ideally would be hidden here as well. A full ancestry walk would need one
 * MORE lookup per level, per entry, with no bound on how deep a real thread
 * nests. `applyOwnerBlocksToThread` pays nothing extra to walk ancestry
 * because every ancestor is already loaded as part of the same thread page; a
 * profile's Posts/Comments tab instead pages roughly 20 entries drawn from up
 * to 20 UNRELATED threads, so that cost cannot be amortised the same way. It
 * would be N levels times 20 entries of fresh lookups on every single page
 * load.
 *
 * The residual gap this leaves: a reply two-plus hops under a blocker's post
 * can still turn up on its author's own profile. It does NOT turn up on the
 * THREAD itself: `applyOwnerBlocksToThread` / `...ToDiscussion` /
 * `...ToReplies` walk the full ancestry and already catch it there, so the
 * words are already withheld from the page people actually read a
 * conversation on. A profile scrape for a specific buried reply is a narrower
 * and far less likely route to the same content than the thread itself. If
 * this gap ever needs closing, the fix is a BOUNDED ancestry walk here (cap
 * the depth, do not walk forever), not an unbounded one.
 *
 * The chain-mute reach added below rides the SAME one-hop boundary: it asks only
 * the DIRECT parent's owner's on-chain ignore list, piggy-backed onto the owner
 * resolution this function already pays for per distinct parent (see
 * `ownerChainMutedNamesOrThrow`). It is not a second, wider walk.
 */
export async function applyOwnerBlocksToAuthoredEntries<T extends Entry>(entries: T[]): Promise<T[]> {
  const withParent = entries
    .map((entry) => ({ entry, parent: parentCoordKey(entry) }))
    .filter((row): row is { entry: T; parent: string } => row.parent !== null);
  if (withParent.length === 0) return entries;

  // One owner resolution per DISTINCT parent coordinate, not per entry: a
  // profile page routinely has several replies hanging under the same post.
  const parentRefs = new Map<string, { author: string; permlink: string }>();
  for (const { entry, parent } of withParent) {
    if (!parentRefs.has(parent)) {
      parentRefs.set(parent, { author: entry.parent_author as string, permlink: entry.parent_permlink as string });
    }
  }

  // ★★★ A FAILED LOOKUP IS NOT "NO OWNER" (2026-08-12, adversarial review).
  //
  // This was `.catch(() => null)`, which collapsed two completely different
  // answers into one:
  //
  //   * `null` — resolved fine, and there is genuinely no Lumen owner to speak
  //     for this parent. `resolvePostOwnerActor` returns this deliberately for a
  //     container root published under the shared frontend account, so that one
  //     system account can never become blocker-of-record for everybody. These
  //     entries MUST stay visible.
  //   * a THROW — a database hiccup. We do not know whether this parent's owner
  //     blocked the author.
  //
  // Treating the second as the first is effect (B) failing OPEN: a blocked
  // account's comments under the blocker's post get served to everyone, which is
  // the precise thing this filter exists to prevent, and it contradicts the rule
  // the calling routes state for themselves ("FAIL EMPTY, NEVER FAIL OPEN").
  //
  // Now a failed lookup hides that parent's entries. The blast radius is one
  // parent, not the page — the old comment's fear of "taking the whole tab down"
  // only applies if you fail the request, which this does not do. If the
  // database is down for every parent, the tab renders empty, which is exactly
  // what `/api/account-posts` already chose to serve in its own catch.
  const resolvedOwners = await Promise.all(
    [...parentRefs.entries()].map(async ([parent, { author, permlink }]) => {
      try {
        // `owner: null` here is a real answer — "resolved, and nobody owns this
        // parent in Lumen terms" — and is treated as visible.
        const owner = await resolvePostOwnerActor(author, permlink);
        // ★ THE CHAIN-MUTE FETCH SHARES THIS SAME try/catch, DELIBERATELY. A
        // failure to read THIS parent's owner's on-chain ignore list is the exact
        // same "cannot vouch this parent is safe" answer a failed Lumen-owner
        // lookup already is — see the big comment above this block. Folding it in
        // here means the existing fail-closed machinery (`unresolvableParents` /
        // `withoutUnresolvable`) protects both sources with no new bookkeeping.
        const chainMuted = await ownerChainMutedNamesOrThrow(owner);
        return [parent, { resolved: true as const, owner, chainMuted }] as const;
      } catch {
        return [parent, { resolved: false as const, owner: null, chainMuted: new Set<string>() }] as const;
      }
    })
  );
  const unresolvableParents = new Set(
    resolvedOwners.filter(([, result]) => !result.resolved).map(([parent]) => parent)
  );
  /**
   * Drop entries hanging under a parent whose owner could not be looked up.
   *
   * ★ Applied at EVERY exit below, not just the last one. This function has
   * three early returns of the form `return entries` (no resolvable owners, no
   * resolvable authors, no block edges), and each of them would otherwise hand
   * back the unresolvable entries untouched — reinstating the exact fail-open
   * this change closes, on the paths most likely to be taken when the database
   * is unhealthy.
   */
  const withoutUnresolvable = (list: T[]): T[] => {
    if (unresolvableParents.size === 0) return list;
    return list.filter((entry) => {
      const parent = parentCoordKey(entry);
      return !(parent && unresolvableParents.has(parent));
    });
  };

  const ownerKeyByParent = new Map<string, string>();
  const chainMutedByParent = new Map<string, Set<string>>();
  for (const [parent, result] of resolvedOwners) {
    if (!result.resolved) continue;
    if (result.owner) ownerKeyByParent.set(parent, actorKey(result.owner));
    if (result.chainMuted.size > 0) chainMutedByParent.set(parent, result.chainMuted);
  }
  if (ownerKeyByParent.size === 0 && chainMutedByParent.size === 0) return withoutUnresolvable(entries);

  const resolver = await buildEntryActorResolver(entries, { onLookupFailure: 'throw' });
  const authorKeyByEntry = new Map<T, string>();
  const authorKeys = new Set<string>();
  for (const { entry } of withParent) {
    const key = resolver.keyOf(entry);
    if (key) {
      authorKeyByEntry.set(entry, key);
      authorKeys.add(key);
    }
  }
  if (authorKeys.size === 0 && chainMutedByParent.size === 0) return withoutUnresolvable(entries);

  const blockedPairs =
    ownerKeyByParent.size > 0 && authorKeys.size > 0
      ? await blocks.blockedPairsAmong([...new Set(ownerKeyByParent.values())], [...authorKeys])
      : new Set<string>();
  // Chain-mute names, batched over every entry once rather than per parent —
  // see `authorHiveNamesOf`.
  const authorHiveName = chainMutedByParent.size > 0 ? await authorHiveNamesOf(entries) : null;
  if (blockedPairs.size === 0 && !authorHiveName) return withoutUnresolvable(entries);

  const hidden = new Set<T>();
  for (const { entry, parent } of withParent) {
    const ownerKey = ownerKeyByParent.get(parent);
    const authorKey = authorKeyByEntry.get(entry);
    if (ownerKey && authorKey && blockedPairs.has(blocks.pairKey(ownerKey, authorKey))) {
      hidden.add(entry);
      continue;
    }
    const parentChainMuted = authorHiveName ? chainMutedByParent.get(parent) : undefined;
    if (parentChainMuted) {
      const name = authorHiveName?.get(coordKey(entry));
      if (name && parentChainMuted.has(name)) hidden.add(entry);
    }
  }
  // Both exits go through `withoutUnresolvable`: an entry whose parent could not
  // be looked up is withheld whether or not any block edge was found, because
  // "no edge found" and "could not check" are the same answer here.
  if (hidden.size === 0) return withoutUnresolvable(entries);
  return withoutUnresolvable(entries.filter((entry) => !hidden.has(entry)));
}

/**
 * Who owns the post at these coordinates, as a block-graph node.
 *
 * ★ THE SHARED PUBLISHING ACCOUNT IS NOT AN OWNER. Every Lumen post is signed on
 * chain by one account, so `@<that account>/<permlink>` is the canonical chain URL of
 * somebody else's post. Reading the author segment as the owner would make one system
 * account the blocker-of-record for every lite post on the site. The permlink is the
 * thing that identifies a Lumen post, so it decides first.
 */
export async function resolvePostOwnerActor(
  author: string,
  permlink: string
): Promise<FollowActor | null> {
  const postId = litePostIdOf({ permlink });
  if (postId) {
    const row = await posts.getPostById(postId).catch(() => null);
    if (row) return { userId: row.userId };
  }
  const clean = (author ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!clean) return null;
  // Defensive: if the URL names the publishing account but the permlink was not one
  // of ours, there is no Lumen owner to speak for — better no filter than the wrong
  // one. (`frontendAccount` is '' when lite accounts are unconfigured.)
  if (liteConfig.frontendAccount && clean === liteConfig.frontendAccount.toLowerCase()) {
    return null;
  }
  return actorForDisplayedName(clean, 'hive');
}

/* ------------------------------------------------------------------------- *
 * (A) VIEWER-SIDE
 * ------------------------------------------------------------------------- */

/**
 * The signed-in viewer's own blocked-and-chain-muted node keys, merged into the one
 * set a served-entry filter matches against. Empty for anonymous callers.
 *
 * ★ CHAIN MUTES, MERGED (owner ruling, 2026-08-12): "if someone mutes on peakd it
 * should be treated as blocked on Lumen." `chainMutedKeysOfActor` degrades to nothing
 * on a lookup failure rather than failing closed — see its doc and `chain-mute.ts`'s
 * header for why effect (A) and effect (B) deliberately disagree on this. A pure lite
 * viewer contributes nothing extra here, correctly: they have no Hive account to have
 * muted anyone from.
 */
export async function viewerBlockedKeySet(sessionUser: User | undefined): Promise<Set<string>> {
  const actor = await sessionActor(sessionUser);
  if (!actor) return new Set();
  const [lumenKeys, chainMutes] = await Promise.all([
    blocks.listBlockedKeysOf(actor),
    chainMutedKeysOfActor(actor)
  ]);
  return new Set([...lumenKeys, ...chainMutes.keys]);
}

/**
 * Drop everything the viewer has blocked from a list they are about to be served.
 *
 * Shaped like `filterBannedEntries` on purpose — same zero-cost bail-out, same
 * "resolve the entry's real author, not just its visible name" rule. A feed entry's
 * `author` has often been rewritten to a Lumen handle by the time it reaches a
 * response, so matching the displayed string alone would miss the writer.
 */
export async function filterBlockedForViewer<T extends Entry>(
  entries: T[] | null | undefined,
  blockedKeys: Set<string>
): Promise<T[]> {
  if (!entries || entries.length === 0) return entries ?? [];
  if (blockedKeys.size === 0) return entries;
  const resolver = await buildEntryActorResolver(entries);
  return entries.filter((entry) => {
    const key = resolver.keyOf(entry);
    return !key || !blockedKeys.has(key);
  });
}
