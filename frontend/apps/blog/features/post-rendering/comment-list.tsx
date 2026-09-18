'use client';

import CommentListItem from '@/blog/features/post-rendering/comment-list-item';
import type { Entry, IFollowList } from '@hive/common-hiveio-packages/wax';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { sanitizeHash } from '@ui/lib/sanitize-url';
import { isOwnModerationHide } from '@/blog/lib/muted-reasons';
import { classifyBlacklist } from '@/blog/lib/moderation/blacklist-reason';
import gdprUserList from '@ui/config/lists/gdpr-user-list';

/**
 * ThreadLine component for Reddit-style visual thread indicators
 * Shows a vertical line with a curved connector to parent comment
 *
 * ★ THIS IS THE ONLY SOURCE OF PER-DEPTH INDENT (fixed 2026-08-11, F2 item 6/10).
 * It used to be ONE of two: this 24px box, plus a 52px avatar
 * (`mr-3` + `w-[40px]`) that CommentListItem rendered again at every level,
 * compounding to 76px/level — measured on the live POB post via
 * getBoundingClientRect(): depth-1 card x=311.5, depth-2 x=387.5, depth-3
 * x=463.5, each exactly +76.0px, unbounded, eating the row's own width until
 * the action row had nowhere to go but clip (item 9). The avatar now renders
 * once, inside the card header, for every depth — see CommentListItem — so
 * this 20px box (`w-4` + `mr-1`) is the single, capped source of indent.
 */
const ThreadLine = ({ isLast }: { isLast: boolean }) => (
  <div className="group/thread relative mr-1 w-4 flex-shrink-0">
    {/* Vertical line from top to curve junction - connects to parent's line above */}
    <div
      className={clsx(
        'absolute left-0 top-0 h-3 w-0',
        'border-l-2',
        'border-thread-line',
        'transition-colors duration-150'
      )}
    />
    {/* Curved connector - branches off to the comment */}
    <div
      className={clsx(
        'absolute left-0 top-3 h-3 w-3',
        'rounded-bl-lg border-b-2 border-l-2',
        'border-thread-line',
        'transition-colors duration-150'
      )}
    />
    {/* Vertical line extending down for siblings below */}
    {!isLast && (
      <div
        className={clsx(
          'absolute bottom-0 left-0 top-3 w-0',
          'border-l-2',
          'border-thread-line',
          'transition-colors duration-150'
        )}
      />
    )}
  </div>
);

// ★ item 10: cap the visual nesting so indent cannot run away. Beyond this
// many levels, stop adding ThreadLine/margin (every deeper reply renders
// flush with the depth-MAX_VISUAL_DEPTH level instead of pushing further
// right) and label the card with who it is replying to instead, since the
// connector line beyond this point no longer conveys that.
//
// ★★★ AND, SINCE 2026-09-18, IT CAPS THE DOM NESTING TOO. This comment used to
// end "the recursion and the underlying <ul><ul> DOM nesting are unchanged —
// only the visual indent is capped", which was true while `comment-list-item.tsx`
// refused to render anything past depth 8. That cap is gone (see the long note at
// its `return`), and with the whole thread rendering, unbounded nesting is a live
// fault, not a style question: MEASURED 2026-09-18 on a 258-deep thread served to
// a local dev server, `GET /lumen/@lordbutterfly/what-if-only-bloggers-are-left`
// answered **HTTP 500, `RangeError: Maximum call stack size exceeded`** — React's
// server renderer descends the element tree recursively and ~15 elements per
// comment level overran the stack. The whole post dies, not just the deep replies,
// and the thread is attacker-supplied: anyone can reply to their own reply 250
// times under someone else's post.
//
// So past this depth the subtree is FLATTENED into the list rather than opening
// another one (`flattenSubtree` below). It is visually identical — those levels
// already draw no ThreadLine and no indent, so the extra <ul> bought nothing but
// depth — and it makes DOM nesting O(1) in thread depth instead of O(n).
// `ul ul` selectors still resolve: levels 1..MAX_VISUAL_DEPTH nest as before.
const MAX_VISUAL_DEPTH = 4;

/**
 * Depth-first pre-order walk of everything under `roots`, as a flat list.
 *
 * ITERATIVE ON PURPOSE — the recursion this replaces is exactly what overflowed
 * the stack, and a recursive walk here would simply move the overflow from the
 * renderer into the data layer. `seen` guards against a parent cycle: chain data
 * cannot contain one (a reply's parent must already exist), but this list is
 * merged with Lumen rows in `content.tsx` and a cycle here would hang the render
 * rather than misdraw it, which is not a risk worth carrying for one Set.
 */
const flattenSubtree = (
  roots: Entry[],
  childrenOf: Map<string, Entry[]>,
  prune: (entry: Entry) => boolean
): Entry[] => {
  const out: Entry[] = [];
  const seen = new Set<string>();
  const stack: Entry[] = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop() as Entry;
    const key = `${node.author}/${node.permlink}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // ★★★ THE HIDE CASCADE SURVIVES THE FLATTENING, AND IT HAS TO. `CommentListItem`
    // returns `null` for a comment the viewer muted or blacklisted, which in a NESTED
    // list took the replies with it — never rendered, because the component that
    // would have rendered them returned first. That cascade is an owner ruling with a
    // stated reason (2026-08-12, quoted at `userModerationHidden`): "a reply routinely
    // quotes what it answers, so leaving it visible would serve the hidden words back
    // through somebody else's mouth." Flattening dissolves the parent/child rendering
    // relationship, so the prune has to be done here instead — same predicate, same
    // inputs, applied to the walk rather than to the render.
    if (prune(node)) continue;
    out.push(node);
    const kids = childrenOf.get(key);
    if (kids) for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  return out;
};

const CommentList = ({
  highestAuthor,
  highestPermlink,
  permissionToMute,
  data,
  parent,
  mutedList,
  mutedListUnknown,
  flagText,
  discussionAuthor,
  discussionPermlink,
  observer,
  filteringEnabled = true,
  level = 0
}: {
  highestAuthor: string;
  highestPermlink: string;
  permissionToMute: Boolean;
  data?: Entry[];
  parent: Entry;
  mutedList: IFollowList[];
  /** True when the viewer's mute-list read failed — see `content.tsx`'s
   *  `mutedListUnknown` doc comment. Threaded down alongside `mutedList`
   *  itself, including into the recursive `CommentList` call below. */
  mutedListUnknown?: boolean;
  flagText: string | undefined;
  discussionAuthor: string;
  discussionPermlink: string;
  observer: string;
  filteringEnabled?: boolean;
  /**
   * ★★★ HOW DEEP THIS LIST IS NESTED, COUNTED BY THE RENDERER ITSELF — 0 for the
   * list directly under the post, +1 per recursion. The flatten decision below is a
   * SAFETY property (it is what keeps the element tree from overrunning the server
   * renderer's stack), so it is taken from the render structure and not from
   * `comment.depth`, which is merged data and can be wrong: `content.tsx` synthesises
   * a depth for a Lumen reply whose parent is not in the chain discussion
   * (`depth: (parent?.depth ?? 0) + 1`, so depth 1 for a reply that may sit six levels
   * down) and says so in its own comment. Under the old depth-8 cap a wrong depth only
   * "mis-indents rather than hides the reply"; here it would silently switch the depth
   * bound off and hand back the 500. A counter the renderer increments cannot be wrong.
   */
  level?: number;
}) => {
  /*
   * ★ ONE SHAPE, SO THE COMPARISON CAN BE EXACT. This holds `@author/permlink` with
   * NO leading `#`, because its two writers disagreed about that: the mount effect
   * below feeds it `sanitizeHash(...)`, which strips the `#`, while a click on a
   * comment's own link feeds it `#@author/permlink` (see `onCommnentLinkClick` at the
   * bottom of this file). That mismatch is why the highlight test was a SUBSTRING
   * match, and a substring match highlights the wrong comment: landing on
   * `#@alice/re-foo-2` also matched `@alice/re-foo`, and Hive's own de-duplication
   * suffixes make prefix-sharing permlinks ordinary rather than exotic. Normalising
   * at both writers lets the read be `===`.
   */
  const [markedHash, setMarkedHash] = useState<string>('');
  const markComment = (hash: string) => setMarkedHash(hash.startsWith('#') ? hash.slice(1) : hash);

  // ★ item 2 (adversarial review) USED TO RESOLVE `parent`'s lite overlay here, once
  // per CommentList, to name the "replying to" author for the whole list. That moved
  // into `CommentListItem` on 2026-09-18: the row is handed the parent ENTRY and asks
  // the overlay hook itself, so the label and the byline resolve identity through one
  // code path instead of two that disagree after a refetch (see `parentEntryOf`).

  useEffect(() => {
    if (typeof window !== 'undefined') {
      // Security: Sanitize hash to prevent potential injection
      const hash = sanitizeHash(window.location.hash);
      if (hash) {
        markComment(hash);
      }
    }
  }, []);

  // ★ "MUTED-FIRST" SPLIT REMOVED — DEAD, VERIFIED ALGEBRAICALLY (2026-08-12, F5).
  // This used to filter the line below into `mutedContent` (items with `depth === 1`)
  // and `unmutedContent` (the rest, via a `post_id` set-difference), then return
  // `[...mutedContent, ...unmutedContent]` — apparently meaning to put "muted" replies
  // first. It never changed anything. Every item here is, by construction, a DIRECT
  // CHILD of the same `parent` (see the filter below), and Hive gives every direct
  // reply to one comment/post the same `depth` — there is no mixed-depth sibling
  // group, ever. So `mutedContent` was always either ALL of the filtered list (when
  // `parent` is the top-level post, so every child is depth 1) or NONE of it (any
  // deeper parent) — never a genuine subset. When it was ALL, `unmutedContent`
  // collapsed to `[]` too: the exclusion check compares each item against
  // `mutedContent`, which contains that very item, so it always matches itself and
  // gets excluded — true regardless of `post_id`, which the Hive bridge API never
  // actually sends anyway (see the `commentKey` note below). Either branch reduces to
  // `[...mutedContent, ...unmutedContent] === filtered`, same order, always — and
  // "muted" was never a real per-user mute check here to begin with; that's
  // `mutedList` / `filteringEnabled`, handled downstream in `CommentListItem`.
  // Confirmed render-identical (same keys, same order) on a real thread before and
  // after this change — see the deliverable notes for the comparison.
  //
  // ★ `flattened` is the depth cap described on MAX_VISUAL_DEPTH above. This list
  // holds the direct children of `parent` as it always did — UNLESS those children
  // sit past the indent cap, in which case it holds their whole subtree, flattened,
  // and no deeper `CommentList` is opened. `parentEntryOf` carries what the nesting
  // used to say: which comment each of those rows is answering.
  const { arr, flattened, parentEntryOf } = useMemo(() => {
    if (!data || !parent) return { arr: undefined, flattened: false, parentEntryOf: undefined };
    const direct = data.filter(
      (x) => x?.parent_author === parent?.author && x?.parent_permlink === parent?.permlink
    );
    // `level` is this list's own nesting, counted by the recursion — see the prop's
    // doc. Level 0 renders the first reply level, so level N renders level N+1, and
    // the first level that draws no further indent is the one to flatten at.
    if (level < MAX_VISUAL_DEPTH) {
      return { arr: direct, flattened: false, parentEntryOf: undefined };
    }
    const childrenOf = new Map<string, Entry[]>();
    const entryOf = new Map<string, Entry>();
    for (const x of data) {
      entryOf.set(`${x.author}/${x.permlink}`, x);
      const parentKey = `${x.parent_author}/${x.parent_permlink}`;
      const bucket = childrenOf.get(parentKey);
      if (bucket) bucket.push(x);
      else childrenOf.set(parentKey, [x]);
    }
    /*
     * ★ WITHHOLD EVERY DESCENDANT WHILE THE MUTE LIST IS UNRESOLVED. `CommentListItem`
     * answers a failed mute-list read with a neutral "we don't know about this author"
     * stub and withholds that comment's children, "same reasoning as
     * `userModerationHidden`'s own cascade: a reply routinely quotes what it answers,
     * and until the mute status resolves we don't yet know whether the parent should be
     * shown at all." Flattened rows have no parent component left to withhold them, so
     * the list stops at the direct children — each still showing its own stub. It errs
     * the safe way: withhold, never leak, and never at the cost of re-nesting.
     */
    if (mutedListUnknown) {
      return { arr: direct, flattened: true, parentEntryOf: undefined };
    }
    /*
     * EVERY `return null` IN `CommentListItem` THAT USED TO TAKE A SUBTREE WITH IT.
     * There are two, and both have to be here, because in a flattened list there is no
     * parent component left to swallow the descendants:
     *
     *   1. `userModerationHidden` (`comment-list-item.tsx`) — the viewer's own mute or
     *      blacklist. Same two pure inputs, through the same exported predicate, so
     *      there is one definition of "hidden" rather than a copy that can drift.
     *
     *   2. ★★★ GDPR ERASURE. `gdprUserList` is a legal erasure list, not a preference,
     *      and the item drops both the erased author's comment (`userFromGDPR`) and any
     *      DIRECT reply to it (`parentFromGDPR`). Nesting did the rest: the erased
     *      comment returned null, so its `CommentList` child never mounted and the
     *      grandchildren went with it. Flattened, they do not — a reply-to-a-reply
     *      quoting the erased text would render with the erasure two links up the chain
     *      and nothing stopping it. Pruning the walk restores the cascade at full depth.
     */
    const prunedWithSubtree = (entry: Entry) =>
      gdprUserList.some((e) => e === entry.author) ||
      isOwnModerationHide(
        Boolean(mutedList?.some((x) => x.name === entry.author)),
        classifyBlacklist(entry.blacklists)
      );
    const flat = flattenSubtree(direct, childrenOf, prunedWithSubtree);
    /*
     * ★★ THE ENTRY, NOT A NAME. An earlier version of this resolved the name here, as
     * `parentEntry?._lite?.author ?? x.parent_author`, and that is NOT what the byline
     * does: the row asks the lite-overlay hook, which falls back to react-query's warm
     * cache when an entry arrives without `_lite` — and that hook's own doc says this is
     * the common case, because "when the client later refetches the feed straight from
     * Hivemind those fresh entries carry no `_lite`". So after any refetch the byline
     * above would still read the Lumen author while the label below it read the shared
     * PUBLISHING account — the one name the overlay exists to keep off the page. Handing
     * the row the ENTRY lets identity resolve exactly once, the same way, in the one
     * component that already owns that question.
     */
    const parentEntries = new Map<string, Entry>();
    for (const x of flat) {
      const parentEntry = entryOf.get(`${x.parent_author}/${x.parent_permlink}`);
      if (parentEntry) parentEntries.set(`${x.author}/${x.permlink}`, parentEntry);
    }
    return { arr: flat, flattened: true, parentEntryOf: parentEntries };
  }, [data, parent?.author, parent?.permlink, level, mutedList, mutedListUnknown]);
  return (
    <ul data-testid="comment-list" className="w-full min-w-0 overflow-hidden">
      <>
        {!!arr
          ? arr.map((comment: Entry, index: number) => {
              /*
               * ★ PAST THE INDENT CAP? `flattened` ALREADY ASKED THAT QUESTION, off the
               * renderer's own `level`, so it is the same answer — and it is the answer
               * that cannot be wrong.
               *
               * This read `comment.depth` minus the post's depth, the last place in
               * this file that decided layout from merged data. Same hazard the `level`
               * prop's doc describes: `content.tsx` hands a Lumen reply whose parent is
               * absent from the chain discussion a synthesised depth of 1 wherever it
               * really sits. Here that drew a ThreadLine on a flattened row — a
               * connector to a parent that is not above it — and dropped the
               * "Replying to" label that row relies on to say what it answers.
               */
              const beyondCap = flattened;
              // ★ item 1 (adversarial review): `post_id` is typed as a required
              // `number` on Entry but the Hive bridge API never actually sends it
              // (measured: 0 of 125 entries on a real discussion carry the field) —
              // so every key below built from it collapsed to `-index-${index}`,
              // effectively an index key. Author+permlink is Hive's real identity
              // for a comment and is always present; keying on it means local
              // per-comment state (hiddenComment, openState, reply/edit toggles)
              // stays attached to the right comment across a sort change or an
              // optimistic insert at the head, instead of following position.
              const commentKey = `${comment.author}/${comment.permlink}`;
              // What this comment answers, shown as a label because the connector line
              // no longer says it. `parent` covers the first flattened level (whose
              // parent IS this list's parent) and anything the map cannot resolve.
              const replyingTo = beyondCap ? (parentEntryOf?.get(commentKey) ?? parent) : undefined;
              return (
                <div
                  key={`parent-${commentKey}`}
                  className={clsx('flex min-w-0', {
                    // ★ `&& comment.depth < 8` REMOVED WITH THE CAP (2026-09-18). It
                    // guarded a branch that could not render past depth 8 anyway; with
                    // the whole thread rendered, a deep comment must still highlight
                    // when a `#@author/permlink` link lands on it — and with every
                    // depth rendering, a loose match now has far more rows to hit by
                    // accident, hence the exact compare (see `markedHash` above).
                    'my-2 rounded border-2 border-line-brand-9 bg-surface-ok-1 p-2':
                      markedHash === `@${comment.author}/${comment.permlink}`
                  })}
                >
                  {/* Thread line connector for nested comments (only show for replies to comments,
                    not top-level, and only up to MAX_VISUAL_DEPTH — see the constant above) */}
                  {parent.depth >= 1 && !beyondCap && <ThreadLine isLast={index === arr.length - 1} />}
                  <div className="min-w-0 flex-1">
                    <CommentListItem
                      parentPermlink={highestPermlink}
                      parentAuthor={highestAuthor}
                      permissionToMute={permissionToMute}
                      comment={comment}
                      key={`${commentKey}-item`}
                      mutedList={mutedList}
                      mutedListUnknown={mutedListUnknown}
                      flagText={flagText}
                      discussionAuthor={discussionAuthor}
                      discussionPermlink={discussionPermlink}
                      observer={observer}
                      filteringEnabled={filteringEnabled}
                      onCommnentLinkClick={markComment}
                      replyingTo={replyingTo}
                    >
                      {/* ★ No nested list once the subtree has been flattened into
                          THIS one — every descendant is already a sibling above/below.
                          Opening one here would re-nest the thread and bring back the
                          unbounded depth that 500s the page. */}
                      {flattened ? null : (
                        <CommentList
                          flagText={flagText}
                          highestAuthor={highestAuthor}
                          highestPermlink={highestPermlink}
                          permissionToMute={permissionToMute}
                          mutedList={mutedList}
                          mutedListUnknown={mutedListUnknown}
                          data={data}
                          parent={comment}
                          key={`${commentKey}-list`}
                          level={level + 1}
                          discussionAuthor={discussionAuthor}
                          discussionPermlink={discussionPermlink}
                          observer={observer}
                          filteringEnabled={filteringEnabled}
                        />
                      )}
                    </CommentListItem>
                  </div>
                </div>
              );
            })
          : null}
      </>
    </ul>
  );
};
export default CommentList;
