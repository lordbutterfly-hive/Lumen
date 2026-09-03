'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, UserAvatarImg } from '@hive/ui';
import TimeAgo from '@ui/components/time-ago';
import { Icons } from '@ui/components/icons';
import { cn } from '@ui/lib/utils';
import { extractBodySummary } from '@/blog/lib/utils';
import VotesComponentWrapper from '@/blog/features/votes/votes-component-wrapper';
import { discussionKey, selectTopComment } from './lib/top-comment';
import { useVisibleDiscussion } from './lib/use-visible-discussion';
import TopCommentThread, { BASE_INDENT } from './top-comment-thread';
import { deriveThread, EMPTY_THREAD } from './lib/top-comment-thread';
import QuickReplyButton from './composer/quick-reply-button';
import QuickReplyComposer from './composer/quick-reply-composer';
import styles from './post-card.module.css';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DRAWER THE POST CARD OPENS ONTO.
 * Built to `LUMEN-DOCS/lora-spec/handoff_post_card/SPEC.md` §5.
 *
 * ★★★ NOTHING IS FETCHED UNTIL A READER ACTUALLY REACHES FOR IT.
 *
 * The handoff does not say where the comment comes from, and the obvious answer
 * is the wrong one. The feed payload carries `children` (a COUNT) and nothing
 * else — no bodies — so a drawer on every card means one extra request per card.
 * At 20 cards a page that is 20 requests added to the single most-visited screen
 * in the product, and this app has already paid for exactly that mistake once:
 * `/topics/photography` went from 5.5-14.7s to 0.38-0.68s purely by removing
 * serial trips (2026-08-18).
 *
 * So the fetch is gated on `engaged`, which the card sets on pointer-enter or
 * focus after a 140ms intent delay. Cost on feed paint: zero. Cost of a reader
 * pausing on a card: one request, cached for the rest of the session.
 *
 * 140ms is not a new number — it is the delay this same file already uses for
 * the lite-account quill tooltip (`TooltipProvider delayDuration={140}`), which
 * is the app's existing answer to "did they mean to hover this".
 *
 * ★★ THROUGH `/api/discussion`, NEVER A DIRECT CHAIN READ. `fetchDiscussion`'s
 * own header explains why and it is not a preference: a post owner's block
 * removes a commenter's replies for EVERY reader, and "a rule enforced only in
 * the reader's own browser is enforced by the exact person it constrains". A
 * drawer that read the thread from a Hive node would re-publish, on the busiest
 * screen in the app, exactly the comments an owner had removed.
 *
 * ★ IT FAILS TO NO DRAWER, NEVER TO AN ERROR. `fetchDiscussion` THROWS on an
 * empty or degraded answer rather than resolving `{}` (deliberately — see its
 * note). Here that collapses to the same state as "this post has no comments":
 * the card simply stays a card. The handoff is explicit that there is no empty
 * state, no disabled affordance and no placeholder.
 *
 * ★ THE MARKUP STAYS IN THE DOM WHILE CLOSED. `height: 0` + `overflow: hidden`
 * does not remove it from the accessibility tree or the tab order, and that is
 * the point: tabbing into the comment's own buttons fires `:focus-within`, which
 * opens the drawer around the focused element. Do NOT "fix" this with
 * `display: none` or `visibility: hidden` — that breaks keyboard access to the
 * comment entirely.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default function TopCommentDrawer({
  author,
  permlink,
  engaged,
  open,
  postHref
}: {
  author: string;
  permlink: string;
  /** The card has been hovered or focused for long enough to mean it. */
  engaged: boolean;
  /** The dwell has elapsed (or focus landed inside) and the drawer must be open. */
  open: boolean;
  /** The post's own URL, which the comment block links into. */
  postHref: string;
}) {
  const rootKey = discussionKey(author, permlink);

  /*
   * The thread as THIS reader would see it — owner blocks applied server-side by
   * `/api/discussion`, the reader's own block list applied on top here. Extracted
   * to `useVisibleDiscussion` so the CARD's comment count and this drawer read
   * exactly the same filtered thread; see that hook's header for the two block
   * mechanisms and why only the client can reconcile both.
   */
  const { visible } = useVisibleDiscussion(author, permlink, engaged);

  const comment = selectTopComment(rootKey, visible);

  /*
   * ★★★ THE FULL REPLY THREAD BENEATH THE TOP COMMENT — DERIVED, NEVER FETCHED
   * (thread-expand spec §2.2). `visible` already holds every descendant of the
   * top comment (bridge.get_discussion returns the whole tree, block-filtered
   * once by `useVisibleDiscussion`), so this is a pure walk with a fixed
   * deterministic sort — no second request. Keyed on the top comment's stable key
   * (not the fresh `comment` object `selectTopComment` returns each render) so the
   * memo only recomputes when the thread or the pick actually changes.
   */
  const chosenKey = comment?.key;
  const thread = useMemo(
    () => (visible && chosenKey ? deriveThread(visible, chosenKey) : EMPTY_THREAD),
    [visible, chosenKey]
  );

  /*
   * ★★★ ONE QUICK-REPLY COMPOSER AT A TIME (QUICK-REPLY-SPEC §2.3). `activeReplyKey`
   * is the `author/permlink` key of the comment whose composer is open — owned HERE
   * because the drawer is the common parent of both the top comment's `.cbox` and
   * `TopCommentThread`, so one piece of state governs both. Clicking Reply on B while
   * A is open moves the composer to B (A's draft is safe in storage, §5); clicking the
   * same comment again, or the composer's own close path, sets it back to null. At rest
   * `activeReplyKey` is null and NO composer is mounted — the feature costs one small
   * button per rendered comment and nothing else.
   */
  const [activeReplyKey, setActiveReplyKey] = useState<string | null>(null);
  const toggleReply = useCallback(
    (key: string) => setActiveReplyKey((current) => (current === key ? null : key)),
    []
  );
  const closeReply = useCallback(() => setActiveReplyKey(null), []);

  /*
   * ★★★ THE HEIGHT IS MEASURED IN JS AND WRITTEN IN PIXELS (spec §8).
   *
   * What this replaces: `.card:hover .drawer { height: auto }`, riding on
   * `interpolate-size: allow-keywords` (globals.css:890). That is a real
   * declaration and it does work — in Chromium. `interpolate-size` ships in one
   * engine, so in Safari and Firefox `0 -> auto` is not an animatable pair and
   * the drawer JUMPS. The spec opens by naming that as one of the three things
   * it is changing: "Height animates. The drawer slides instead of jumping."
   *
   * (Spec §8 states "There is no `interpolate-size` in this build". That line is
   * stale — it was added since. The REQUIREMENT is unaffected: the property is
   * still single-engine, so a measured pixel height is still the only version
   * that animates for every reader.)
   *
   * ★★ MEASURE THE DRAWER, NOT THE CHILD. §8: "The drawer is a block formatting
   * context, so the comment block's bottom margin lands inside the drawer and
   * outside the child's box. Measuring the child's `scrollHeight` clips the
   * drawer by that margin, 113px read as 111px." `overflow: hidden` is what
   * makes the drawer a BFC, so the 10px bottom margin on the comment block is
   * contained by it — and `offsetHeight` on THIS element at `height:auto` counts
   * it. Reading `inner.scrollHeight` instead is the 2px bug, pre-written.
   *
   * ★ THE 0 -> REFLOW -> h DANCE IS ONLY FOR THE OPENING EDGE. A transition needs
   * a from-value in the same style pass; jumping straight from `auto` to `${h}px`
   * gives it none and the drawer snaps. But forcing that dance when the drawer is
   * ALREADY open — which happens when the comment arrives after the fetch, or a
   * reply count ticks — would animate a collapse and a re-open under a reader who
   * is mid-sentence. So `wasOpen` splits the two: measure always, re-seed only on
   * the edge.
   *
   * ★ REDUCED MOTION IS NOT A REASON TO SKIP ANY OF THIS. §8: "Height and opacity
   * are still written, so the expansion appears instantly and completely. The
   * feature is never withheld, only the animation." The CSS collapses the
   * duration to .01ms; this code is unchanged by it.
   */
  const drawerRef = useRef<HTMLDivElement | null>(null);
  // ★ The measured element is the drawer; the observed element is its inner
  //   content (see the ResizeObserver effect below for why the two differ).
  const innerRef = useRef<HTMLDivElement | null>(null);
  const wasOpen = useRef(false);

  /*
   * Measure the DRAWER at `height:auto` and write it back in pixels. Factored out
   * of the effect so the ResizeObserver below can reuse it for late height
   * changes. `reseed` runs the opening-edge `0 -> reflow -> h` dance; a remeasure
   * of an already-open drawer passes `reseed=false` so it animates from its
   * current height instead of collapsing and re-opening (spec §3.4).
   *
   * ★★★ THE TRANSITION HAS TO BE OFF WHILE MEASURING, AND THAT IS NOT
   * BELT-AND-BRACES — WITHOUT IT THIS READS 0 EVERY TIME. Measured on the built
   * app 2026-08-20: `scrollHeight` said 113 while `offsetHeight` at `height:auto`
   * said 0.
   *
   * The cause is the very property §8 tells us not to rely on. `:root` carries
   * `interpolate-size: allow-keywords` (globals.css:890), which makes `0px -> auto`
   * an ANIMATABLE pair. So assigning `auto` to an element with a live
   * `transition: height` does not resolve the height — it STARTS A TRANSITION
   * toward it, and the very next layout read returns the current animated value,
   * which is still ~0. The measurement measures the animation it just kicked off.
   *
   * It is a perfect trap: it fails to 0, a 0-high drawer looks exactly like a
   * closed one, and the geometry underneath is completely correct — the same
   * silent-failure shape §8 warns about for `grid-template-rows`.
   *
   * `transition: none` for the duration of the read makes `auto` resolve
   * immediately, the way it would with no transition declared at all.
   */
  const measure = useCallback((reseed: boolean) => {
    const el = drawerRef.current;
    if (!el) return;
    const prevTransition = el.style.transition;
    el.style.transition = 'none';
    el.style.height = 'auto';
    const measured = el.offsetHeight;
    if (reseed) {
      el.style.height = '0px';
      // Force the layout the transition needs as its start value. Reading a
      // layout property is the documented way to flush it; without this the
      // browser coalesces 0 and `${measured}px` into one style pass and the
      // drawer snaps open with no animation at all.
      void el.offsetHeight;
    }
    // Restore BEFORE the final write, so the write is the thing that animates.
    el.style.transition = prevTransition;
    el.style.height = `${measured}px`;
  }, []);

  useEffect(() => {
    const el = drawerRef.current;
    if (!el) return;
    if (!open) {
      el.style.height = '0px';
      wasOpen.current = false;
      return;
    }
    // ★ THE 0 -> REFLOW -> h DANCE IS ONLY FOR THE OPENING EDGE (`!wasOpen`).
    //   Forcing it while already open — the comment arriving after the fetch, a
    //   reply count ticking — would animate a collapse and re-open under a reader
    //   mid-sentence. Measure always; re-seed only on the edge.
    measure(!wasOpen.current);
    wasOpen.current = true;
  }, [open, comment, thread, measure]);

  /*
   * ★★★ LATE HEIGHT CHANGES WHILE OPEN (thread-expand spec §3.4). The thread is
   * rendered hidden the moment data resolves, so its bulk is measured before the
   * click. But a reply's OWN height can change AFTER open without re-rendering
   * this drawer — a cast vote's tally, an image in a reply's body finishing load
   * — and none of those flow through the effect deps above. A ResizeObserver on
   * the inner content catches them and REMEASURES WITHOUT the 0-reseed, so the
   * drawer grows smoothly to fit rather than clipping the taller thread (the exact
   * "re-measure to the new height, do not snap" the spec asks for, §4 "Reader
   * votes a reply").
   *
   * ★ OBSERVE THE INNER, NOT THE DRAWER — this avoids a feedback loop. The
   * drawer's own height writes never change the inner's size (`overflow:hidden`
   * clips, it does not resize its children), so the observer fires only on real
   * content changes, never on our own measurement writes.
   */
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!open || !wasOpen.current) return; // only an already-open drawer
      measure(false);
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [open, measure]);

  // The wrapper is rendered unconditionally (see the a11y note above) but stays
  // measurably 0-high until there is something in it — `height: auto` on an
  // empty box is still 0, so an un-loaded drawer cannot make the card twitch.
  return (
    <div className={styles.drawer} data-testid="post-card-drawer" data-open={open ? 'true' : 'false'} ref={drawerRef}>
      {comment ? (
        <div className={styles.drawerInner} ref={innerRef}>
          <span className={styles.seam} aria-hidden="true" />
          <div className={styles.cbox}>
            {/* ★★★ A STRETCHED LINK, NOT A WRAPPING ONE. The block has to be a
                real anchor — keyboard-focusable, middle-clickable, "copy link
                address" — but §7 also puts a VOTE BUTTON inside it, and
                interactive content nested in an <a> is invalid HTML and behaves
                unpredictably. An absolutely-positioned anchor covering the block
                gives the whole surface one destination while leaving room for
                controls to sit above it (see `.counts` / `.cboxLink` in the CSS).

                ★ THE HREF CARRIES THE COMMENT, NOT JUST THE POST. §9: "Navigate
                to the post, then jump directly to that comment." The fragment is
                the same `@author/permlink` id `comment-list-item.tsx` puts on
                each comment, and `comments-section.tsx` resolves it on arrival —
                including switching to the right PAGE first, without which the
                anchor does not exist for any comment past the first 50. */}
            <Link
              href={`${postHref}#@${comment.author}/${comment.permlink}`}
              className={styles.cboxLink}
              /* ★★★ `scroll={false}` IS LOAD-BEARING, and without it the jump is a RACE
                 IT SOMETIMES LOSES. Next's App Router scrolls a new route to the top by
                 default. `comments-section.tsx` then lands on the comment — and the router's
                 reset can arrive AFTER that, putting the reader back at the top of the post
                 with the target's highlight flashing 9000px below them. Measured exactly
                 that way: flash fired, anchor present, scrollY 0.
                 It passed on earlier runs, which is the worst property a bug can have — the
                 two scrolls were simply landing in the other order. Telling the router not
                 to scroll removes the race rather than out-timing it: §9 says this link
                 navigates AND jumps, so the arrival owns the scroll position, not the
                 router. */
              scroll={false}
              data-testid="post-card-comment-link"
              aria-label={`Read ${comment.author}'s comment on this post`}
            />
            {/* ★★ THE WHOLE BLOCK IS ONE TARGET, so the avatar and the author
                name are NOT their own links any more (§9: "Comment block, in the
                drawer -> Navigate to the post, then jump directly to that
                comment"). §6 settles it from the other direction: on the block's
                hover "the author name goes --brand at the same time" as the
                wash, i.e. the name is part of the block's affordance, not a
                competing destination. Two overlapping targets 15px apart, one to
                a profile and one to a post, is a mis-click generator.

                `flex`, not just `shrink-0`: as a bare flex ITEM this wrapper
                still establishes an inline formatting context, so a 24px avatar
                sits on a line box of max(line-height, 24px) plus baseline
                descender space — it measured 26px. `flex` removes the line box.
                §4 budgets 24px. */}
            <span className="flex shrink-0" aria-hidden="true">
              {/* 24px, down from 30 (§4: "avatar 24px, gap 12px"). The avatar is
                  the tallest thing in the meta row but not what sets the row
                  height — the 20px text does — so this costs no height, it only
                  stops the avatar out-shouting a 15px name. */}
              <UserAvatarImg username={comment.author} pixelSize={24} alt="" />
            </span>
            <div className={styles.commentBody}>
              <div className={styles.commentMeta}>
                <span className={styles.commentAuthor}>{comment.author}</span>
                {/* Spec §5 gives the separator its own row in the type table —
                    15px/400 at --ink-4, i.e. a step quieter than both the name it
                    follows and the time it precedes. It is punctuation, not
                    structure, so it is aria-hidden: a screen reader reading
                    "author · 2 hours ago" gains nothing from the dot. */}
                <span className={styles.commentSep} aria-hidden="true">
                  ·
                </span>
                <span className={styles.commentTime}>
                  <TimeAgo date={comment.created} />
                </span>
                {/* Uppercase + tracking, never small-caps: Lora ships no `smcp`
                    table, so `font-variant-caps` would be synthesised from
                    scaled capitals and sit at the wrong stroke weight beside the
                    real ones.

                    ★ aria-hidden per spec §10: "The `TOP COMMENT` label is
                    decorative and aria-hidden. The comment's author and time
                    carry the same information in the text." */}
                <span className={styles.commentLabel} aria-hidden="true">
                  top comment
                </span>
              </div>
              {/* ★ SUMMARISED, NOT RAW. A comment body is markdown, and the card
                  above it already renders its own excerpt through the same
                  helper — printing raw markdown here would put `**bold**` and
                  bare image URLs in the one place the design uses to show what a
                  conversation reads like. `extractBodySummary` is what
                  `getPostSummary` falls back to for the dek, so the drawer and
                  the excerpt cannot disagree about how prose is flattened. */}
              <p className={styles.commentText}>{extractBodySummary(comment.body)}</p>
            </div>
            {/* ★★ THE TWO COUNTS (spec §7), and the action row that used to be
                here is GONE. §1: "The expansion has no action row of its own. It
                repeated the card's. Two counts remain, and they are readouts,
                not a second toolbar." What went with it is the payout: the card
                above already prints the post's, and a second money figure 113px
                under the first read as a total rather than as the comment's.

                They are positioned out of flow (see `.counts` in the CSS) so
                they cost the block no height — §4's 113px budget has no row for
                them, they sit against the body's last line. */}
            <div className={styles.counts}>
              {/*
                ★★★ A REAL VOTE, NOT A TALLY (spec §7 "Control? yes", §9 "The vote").
                This was a read-only number until 2026-08-20, on the reasoning that a
                live vote here "would need every guard `medium-post-card.tsx` spends
                200 lines on". That reasoning was right about the guards and wrong
                about the conclusion: the guards do not have to be rewritten, they
                have to be REUSED. `VotesComponent` already owns all of them — the
                lite-vs-Hive tier split, the self-engagement 400 a lite author gets
                on their own post, the hydration window where the tier is not yet
                known — and each one was added after a real defect. So the drawer
                mounts the shipped control at a new `quote` size rather than growing
                a second implementation that would rediscover those defects one at a
                time.

                What comes with it, all required by §9 and none of it written here:
                optimistic cast with revert on failure, `aria-pressed` carrying the
                state, and the frozen `lm-vote-pop` / `lm-vote-ring` /
                `lm-vote-count-up` curves — "a vote must feel identical wherever it
                is cast".

                ★ `stopPropagation` on BOTH click and keydown (§9). The block's
                navigation is a stretched anchor that is this control's SIBLING, not
                its ancestor, so a bubbling click cannot reach it today. This is
                deliberate belt-and-braces: the moment anyone wraps the block in a
                click handler — the obvious way to make "the card surface navigates"
                work — an unguarded Enter on the vote would start voting AND
                navigating. §9 asks for the keydown case by name.

                ★ `pointerEvents: auto` re-enables what `.counts` switches off. The
                counts row is `pointer-events: none` so that clicking the readouts
                falls through to the block's link; the vote is the one thing in
                there that must catch its own clicks. */}
              <span
                className={styles.voteSlot}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
                }}
              >
                <VotesComponentWrapper post={comment.entry} type="comment" size="quote" />
              </span>
              {/* ★ A NUMBER, NOT A BUTTON (spec §7): "No cursor:pointer, no hover
                  colour, no hit target. A count that lights up under the pointer
                  and does nothing is a false affordance." 16px glyph against the
                  vote's 18px, and --ink-3 against the vote's --ink-4. */}
              <span className={styles.replyCount} aria-label={`${comment.directResponseCount} replies`}>
                <Icons.comment className={cn(styles.iconComment, 'h-[16px] w-[16px]')} aria-hidden="true" />
                {comment.directResponseCount}
              </span>
              {/* ★ THE REPLY AFFORDANCE — a SEPARATE new control, NOT the count
                  turned into a button (§7 forbids that; §2.1). Signed out it is a
                  DialogLogin trigger; signed in it toggles this comment's composer.
                  Re-enables its own pointer events (`.counts` is pointer-events:none)
                  and stops propagation, exactly like the vote slot. */}
              <QuickReplyButton
                className={styles.replyAction}
                active={activeReplyKey === comment.key}
                onToggle={() => toggleReply(comment.key)}
                replyKey={comment.key}
              />
            </div>
          </div>
          {/* ★★★ THE TOP COMMENT'S COMPOSER — a sibling of `.cbox` (never a child:
              the stretched `.cboxLink` anchor would sit over its controls), mounted
              only when this comment is the active reply target (§2.2). Indented as a
              depth-1 child (`BASE_INDENT`) so it reads as part of the thread it will
              join. */}
          {activeReplyKey === comment.key ? (
            <div style={{ marginLeft: `${BASE_INDENT}px` }} data-testid="quick-reply-mount-top">
              <QuickReplyComposer
                parent={comment.entry}
                rootAuthor={author}
                rootPermlink={permlink}
                onClose={closeReply}
              />
            </div>
          ) : null}
          {/* ★★★ THE FULL REPLY THREAD, A SIBLING OF `.cbox` (thread-expand spec
              §2.4). Purely additive: the top comment above is byte-for-byte
              unchanged. Rendered whenever the data is present — INDEPENDENT of
              `open`, mirroring `.cbox`'s own `comment ? ... : null` gate — so the
              thread is laid out (hidden inside the `height:0; overflow:hidden`
              drawer) before any click, and the click is then a pure height
              animation (§3.3). Gated on a non-empty descendant set so a top
              comment with zero replies renders no section at all (§4). */}
          {thread.nodes.length > 0 ? (
            <TopCommentThread
              thread={thread}
              viewAllHref={`${postHref}#@${comment.author}/${comment.permlink}`}
              rootAuthor={author}
              rootPermlink={permlink}
              activeReplyKey={activeReplyKey}
              onReply={toggleReply}
              onCloseReply={closeReply}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
