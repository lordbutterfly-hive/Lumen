/**
 * ★★★ THE DOWNVOTE MOVED TO THE OVERFLOW MENU (2026-08-16, spec
 * "Demote the downvote to an overflow-menu action", owner: Damir).
 *
 * The downvote arrow sat beside the upvote on every card, post and comment,
 * giving a destructive and rarely-used action the same visual weight as the
 * primary positive one, on every item in the feed. It is now an item inside the
 * existing "More options" menu. Downvoting keeps working and keeps affecting
 * payout exactly as before: only the affordance moved, never the maths.
 *
 * ★ WHY A FLAG RATHER THAN A DELETION (spec §8). Flipping this to `true`
 * restores the inline control at every call site at once, so a rollback is a
 * config change rather than a revert. It also keeps the downvote branch of
 * `VoteControl` compiled and exercised by a test, so it cannot rot into
 * something that no longer works if it is ever brought back.
 *
 * It is read as the DEFAULT of `VoteControl`'s `showDownvote` prop rather than
 * being threaded through three call sites, so no surface can accidentally
 * disagree with the others about whether the arrow exists.
 */
export const FEATURE_INLINE_DOWNVOTE = false;
