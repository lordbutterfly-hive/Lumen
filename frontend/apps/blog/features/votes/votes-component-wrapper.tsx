'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import VotesComponent from './votes-component';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { BladeGlyph, VoteTally, voteStyles, type VoteSize } from './blade';
import { splitTally } from './vote-tallies';
import { FEATURE_INLINE_DOWNVOTE } from './feature-flags';

const VotesComponentWrapper = ({
  post,
  type,
  size = 'sm'
}: {
  post: Entry;
  type: 'comment' | 'post';
  size?: VoteSize;
}) => {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!isMounted) {
    /**
     * ★ THE PLACEHOLDER NOW SHOWS THE REAL BLADE AND COUNT, not two blank
     * circles (2026-09-03, owner-reported: "the cards are missing the upvote
     * blade and the upvote amount till it loads... the comment icon, reblog
     * icon and payout are there").
     *
     * The interactive control below is `'use client'` and reads
     * `useUserClient()` / `useSessionIdentity()`, neither of which can answer
     * during SSR, so it is deferred to `isMounted` to avoid a hydration
     * mismatch on the personalised parts (my-vote tint, the weight picker, the
     * click handlers). But the two things the reader was actually missing — the
     * blade glyph and the vote count — need NONE of that: the count comes from
     * `splitTally`, which reads only the post object, and the glyph is static
     * artwork. So the placeholder renders them, and only the interactivity waits
     * for mount.
     *
     * ★ SHIFT-FREE BY CONSTRUCTION (layout and the count). It mirrors
     * `VotesComponent`'s exact box: the same `voteStyles.root/side/btn` classes,
     * the same `BladeGlyph`, the same `VoteTally`, gated by the same
     * `FEATURE_INLINE_DOWNVOTE` so the down side is present or absent identically
     * — so the swap to the live control changes zero pixels of layout, satisfying
     * the handoff's "transform and opacity only, nothing that triggers layout"
     * budget the old two-square placeholder was written to protect. (The one
     * thing that DOES change on the swap is paint, not layout: for a post the
     * viewer has already voted on, the live control resolves my-vote and tints
     * the blade brand + fills it; the placeholder cannot know my-vote so it
     * paints neutral. No shift, no roll, and it only touches posts you voted on.)
     *
     * ★ THE NUMBER DOES NOT CHANGE ON MOUNT. `splitTally` is viewer-independent
     * by design (it excludes the caller from the scraped down count and adds them
     * back from `myVote`, so `up = total - down` is the same whether the caller
     * voted or not — see its own note). Computing it here with an empty voter and
     * `myVote='none'` therefore yields exactly the numbers `VotesComponent` will
     * compute for the real viewer, so `VoteTally` mounts on the same value, does
     * not roll (its change-detector sees no change and `rollOnMount` is false),
     * and no count animation fires on load.
     */
    const showDownvote = FEATURE_INLINE_DOWNVOTE;
    const tally = splitTally(post, '', 'none');
    const rootClass = clsx(voteStyles.root, {
      [voteStyles.sm]: size === 'sm',
      [voteStyles.quote]: size === 'quote',
      [voteStyles.upOnly]: !showDownvote
    });
    return (
      <div className={clsx(rootClass, 'pointer-events-none')} data-testid="vote-control" aria-hidden="true">
        <span className={voteStyles.side}>
          {/* A span, not a button: the static placeholder carries no action, and
              `voteStyles.btn` defines the whole box, so the element matches the
              live button's footprint without its interactivity or :disabled dim. */}
          <span className={clsx(voteStyles.btn, voteStyles.up)}>
            <BladeGlyph />
          </span>
          <VoteTally value={tally.up} side="up" mine={false} testId="vote-tally-up" />
        </span>
        {showDownvote ? (
          // ★ The down SIDE follows `showDownvote` alone, and only the TALLY
          // follows `tally.down > 0` — EXACTLY as VotesComponent does (its
          // `downTally` is null at zero while the side/button always render when
          // showDownvote). Gating the whole side on `down > 0` here would render
          // nothing while the live control renders a down button, shifting the
          // row sideways on mount for every zero-downvote post the instant
          // FEATURE_INLINE_DOWNVOTE is flipped on.
          <span className={voteStyles.side}>
            <span className={clsx(voteStyles.btn, voteStyles.down)}>
              <BladeGlyph />
            </span>
            {tally.down > 0 ? (
              <VoteTally value={tally.down} side="down" mine={false} testId="vote-tally-down" />
            ) : null}
          </span>
        ) : null}
      </div>
    );
  }

  return <VotesComponent post={post} type={type} size={size} />;
};

export default VotesComponentWrapper;
