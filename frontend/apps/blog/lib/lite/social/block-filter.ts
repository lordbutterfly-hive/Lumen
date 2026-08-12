import { Entry } from '@hive/common-hiveio-packages/wax';
import { User } from '@smart-signer/types/common';
import * as blocks from '../repositories/block-repository';
import * as posts from '../repositories/post-repository';
import { liteConfig } from '../config';
import { litePostIdOf } from '../render/lite-post-id';
import { FollowActor, actorKey, sessionActor } from './follow-actor';
import { actorForDisplayedName, buildEntryActorResolver } from './block-actor';

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
 * Effect (B) over one thread. Returns the entries that may be served, in input order.
 *
 * Cost: two batched user lookups (`buildEntryActorResolver`) plus ONE block query for
 * the entire thread, regardless of how many comments it has.
 */
export async function applyOwnerBlocksToThread<T extends Entry>(entries: T[]): Promise<T[]> {
  if (entries.length < 2) return entries;

  const resolver = await buildEntryActorResolver(entries);
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
  if (participants.length < 2) return entries;
  const blockedPairs = await blocks.blockedPairsAmong(participants, participants);
  if (blockedPairs.size === 0) return entries;

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
  const resolver = await buildEntryActorResolver(entries);
  const authorKeys = entries
    .map((entry) => resolver.keyOf(entry))
    .filter((k): k is string => Boolean(k));
  if (authorKeys.length === 0) return entries;

  const blockedPairs = await blocks.blockedPairsAmong([ownerKey], authorKeys);
  if (blockedPairs.size === 0) return entries;
  return entries.filter((entry) => {
    const key = resolver.keyOf(entry);
    return !key || !blockedPairs.has(blocks.pairKey(ownerKey, key));
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

  const resolvedOwners = await Promise.all(
    [...parentRefs.entries()].map(async ([parent, { author, permlink }]) => {
      // A single bad lookup must not take the whole tab down with it: fail
      // that one parent open (unresolved owner, so its replies stay visible)
      // rather than the entire page.
      const owner = await resolvePostOwnerActor(author, permlink).catch(() => null);
      return [parent, owner] as const;
    })
  );
  const ownerKeyByParent = new Map<string, string>();
  for (const [parent, owner] of resolvedOwners) {
    if (owner) ownerKeyByParent.set(parent, actorKey(owner));
  }
  if (ownerKeyByParent.size === 0) return entries;

  const resolver = await buildEntryActorResolver(entries);
  const authorKeyByEntry = new Map<T, string>();
  const authorKeys = new Set<string>();
  for (const { entry } of withParent) {
    const key = resolver.keyOf(entry);
    if (key) {
      authorKeyByEntry.set(entry, key);
      authorKeys.add(key);
    }
  }
  if (authorKeys.size === 0) return entries;

  const blockedPairs = await blocks.blockedPairsAmong([...new Set(ownerKeyByParent.values())], [...authorKeys]);
  if (blockedPairs.size === 0) return entries;

  const hidden = new Set<T>();
  for (const { entry, parent } of withParent) {
    const ownerKey = ownerKeyByParent.get(parent);
    const authorKey = authorKeyByEntry.get(entry);
    if (ownerKey && authorKey && blockedPairs.has(blocks.pairKey(ownerKey, authorKey))) {
      hidden.add(entry);
    }
  }
  if (hidden.size === 0) return entries;
  return entries.filter((entry) => !hidden.has(entry));
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

/** The signed-in viewer's block list as node keys. Empty for anonymous callers. */
export async function viewerBlockedKeySet(sessionUser: User | undefined): Promise<Set<string>> {
  const actor = await sessionActor(sessionUser);
  if (!actor) return new Set();
  return new Set(await blocks.listBlockedKeysOf(actor));
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
