'use client';

import { useQuery } from '@tanstack/react-query';
import { Link, UserAvatarImg } from '@hive/ui';
import TimeAgo from '@ui/components/time-ago';
import { Icons } from '@ui/components/icons';
import { cn } from '@ui/lib/utils';
import { fetchDiscussion } from '@/blog/lib/lite/client/discussion-fetch';
import { extractBodySummary } from '@/blog/lib/utils';
import { Blade } from '@/blog/features/votes/blade';
import { discussionKey, selectTopComment } from './lib/top-comment';
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
  engaged
}: {
  author: string;
  permlink: string;
  /** The card has been hovered or focused for long enough to mean it. */
  engaged: boolean;
}) {
  const rootKey = discussionKey(author, permlink);

  const { data } = useQuery({
    queryKey: ['post-card-top-comment', rootKey],
    queryFn: () => fetchDiscussion(author, permlink),
    enabled: engaged,
    // A comment thread that has already been read once does not need re-reading
    // as the reader moves back up the feed.
    staleTime: 5 * 60 * 1000,
    // One retry only. This is decoration on a feed card: a thread that will not
    // load is a card without a drawer, not a reason to hammer the route.
    retry: 1,
    refetchOnWindowFocus: false
  });

  const comment = selectTopComment(rootKey, data);

  // The wrapper is rendered unconditionally (see the a11y note above) but stays
  // measurably 0-high until there is something in it — `height: auto` on an
  // empty box is still 0, so an un-loaded drawer cannot make the card twitch.
  return (
    <div className={styles.drawer} data-testid="post-card-drawer">
      {comment ? (
        <div className={styles.drawerInner}>
          <span className={styles.seam} aria-hidden="true" />
          <div className={styles.comment}>
            <Link href={`/@${comment.author}`} className="shrink-0" tabIndex={-1} aria-hidden="true">
              <UserAvatarImg username={comment.author} pixelSize={30} alt={comment.author} />
            </Link>
            <div className={styles.commentBody}>
              <div className={styles.commentMeta}>
                <Link href={`/@${comment.author}`} className={cn(styles.commentAuthor, 'hover:underline')}>
                  {comment.author}
                </Link>
                <span className={styles.commentTime}>
                  <TimeAgo date={comment.created} />
                </span>
                {/* Uppercase + tracking, never small-caps: Lora ships no `smcp`
                    table, so `font-variant-caps` would be synthesised from
                    scaled capitals and sit at the wrong stroke weight beside the
                    real ones. */}
                <span className={styles.commentLabel}>top comment</span>
              </div>
              {/* ★ SUMMARISED, NOT RAW. A comment body is markdown, and the card
                  above it already renders its own excerpt through the same
                  helper — printing raw markdown here would put `**bold**` and
                  bare image URLs in the one place the design uses to show what a
                  conversation reads like. `extractBodySummary` is what
                  `getPostSummary` falls back to for the dek, so the drawer and
                  the excerpt cannot disagree about how prose is flattened. */}
              <p className={styles.commentText}>{extractBodySummary(comment.body)}</p>
              <div className={styles.commentActions}>
                {/* Read-only tallies. Voting on a comment happens on the post
                    page, where the vote control has the tier/auth context it
                    needs; offering a live vote here would need every guard
                    `medium-post-card.tsx` spends 200 lines on, on a surface a
                    reader is only passing through. `aria-hidden` on the glyphs
                    and a real label on the group, because a count alone is not a
                    label. */}
                <span className={styles.act} aria-label={`${comment.upvotes} upvotes`}>
                  {/* `Blade`, not `BladeGlyph`. `BladeGlyph` wraps the mark in
                      `vote-control.module.css`'s `.glyph`, which owns the cast
                      animation's scale and the vote control's own sizing — a
                      read-only tally must not inherit either. The raw `Blade`
                      svg carries no width of its own and takes it from this
                      span, which is exactly what the 18px drawer size needs.
                      Its viewBox is already shifted `0 -3.5 24 24` to centre the
                      ink, so `.iconBlade` adds only the 0.5px digit correction
                      on top — see the §ICONS derivation in the CSS module. */}
                  <span className={cn(styles.iconBlade, 'flex h-[18px] w-[18px] items-center')} aria-hidden="true">
                    <Blade />
                  </span>
                  {comment.upvotes}
                </span>
                <span className={styles.act} aria-label={`${comment.directResponseCount} replies`}>
                  <Icons.comment className={cn(styles.iconComment, 'h-[18px] w-[18px]')} aria-hidden="true" />
                  {comment.directResponseCount}
                </span>
                <span className={cn(styles.pay, comment.payout === 0 && styles.payZero)}>
                  ${comment.payout.toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
