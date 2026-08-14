import { useEffect, useRef, useState } from 'react';
import { useStorageWithTTL } from '@ui/hooks/useStorageWithTTL';
import { StorageTTL } from '@ui/lib/storage-with-ttl';
import clsx from 'clsx';
import { CircleSpinner } from 'react-spinners-kit';
import TooltipContainer from '@ui/components/tooltip-container';
import { Slider } from '@ui/components/slider';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import DialogLogin from '@/blog/components/dialog-login';
import { useQuery } from '@tanstack/react-query';
import { fetchListVotesByCommentVoter } from '@/blog/lib/chain-fetch';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { Popover, PopoverTrigger, PopoverContent } from '@ui/components/popover';
import { useLoggedUserContext } from '@/blog/features/votes/hooks/use-logged-user';
import { useTranslation } from '@/blog/i18n/client';
import { handleError } from '@ui/lib/handle-error';
import { fetchLiteEngagement } from '@/blog/lib/lite/client/lite-engagement';
import { useVoteMutation } from './hooks/use-vote-mutation';
import { VoteRemovalDialog } from './vote-removal-dialog';
import { BladeGlyph, CommitRing, VoteTally, useCommitRing, voteStyles, type VoteSize } from './blade';
import { splitTally, type MyVote } from './vote-tallies';

const VOTE_WEIGHT_DROPDOWN_THRESHOLD = 1.0 * 1000.0 * 1000.0;

const offsetSlider = {
  popoverSideOffset: -37,
  popoverAlignOfset: -19
};

// Default votes values - defined outside component for stable reference
const DEFAULT_VOTES_VALUES = {
  post: {
    upvote: [100],
    downvote: [100]
  },
  comment: {
    upvote: [100],
    downvote: [100]
  }
};

// Safe accessor for vote values - handles legacy/malformed localStorage data
const getVoteValue = (
  stored: typeof DEFAULT_VOTES_VALUES | null | undefined,
  voteType: 'post' | 'comment',
  direction: 'upvote' | 'downvote'
): number[] => {
  return stored?.[voteType]?.[direction] ?? DEFAULT_VOTES_VALUES[voteType][direction];
};

const VotesComponent = ({
  post,
  type,
  size = 'sm'
}: {
  post: Entry;
  type: 'comment' | 'post';
  /**
   * Handoff sizes: `default` is the post page (28px glyph / 53x53 target / 18px
   * tally), `sm` is feed density (22px / 38x38 / 14.5px). Defaults to `sm`
   * because four of the five surfaces that mount this are cards or comments,
   * and because the files those live in are owned by other agents this session
   * — an untouched call site therefore gets the correct size for where it is.
   * The post page passes `size="default"`.
   */
  size?: VoteSize;
}) => {
  const { user, sessionUnavailable } = useUserClient();
  /**
   * ★★★ SAME DEFECT AS /witnesses, NOW ON EVERY SINGLE POST AND COMMENT
   * (2026-08-11, class sweep). `user.isLoggedIn` cannot answer during SSR and
   * reports "signed out" on the client until `/api/users/me` returns, so every
   * upvote/downvote control on every card, everywhere in the app, rendered the
   * logged-OUT branch (icon wrapped in `DialogLogin`, opening the login modal
   * instead of casting the vote) for up to several seconds after every page load —
   * this is the single most-rendered instance of the bug in the app. `identity`
   * prefers the client's answer once it has genuinely arrived and falls back to
   * the session the SERVER read from the cookie until then. `identity.username` is
   * used as `voter` below instead of the raw, possibly-still-empty
   * `user.username` — the two hooks' `isLoggedIn`/`username` pairs are read
   * together so they never disagree with each other. See
   * features/layouts/server-session.tsx.
   */
  const identity = useSessionIdentity();
  const { t } = useTranslation('common_blog');
  const [clickedVoteButton, setClickedVoteButton] = useState('');
  const [storedVotesValues, storeVotesValues] = useStorageWithTTL(
    'votesValues',
    DEFAULT_VOTES_VALUES,
    StorageTTL.PERMANENT
  );
  const [sliderUpvote, setSliderUpvote] = useState(() =>
    getVoteValue(storedVotesValues, type, 'upvote')
  );
  const [sliderDownvote, setSliderDownvote] = useState(() =>
    getVoteValue(storedVotesValues, type, 'downvote')
  );
  const voter = identity.username;
  const pastPayout = new Date(`${post.payout_at}Z`) < new Date();
  useEffect(() => {
    setSliderUpvote(getVoteValue(storedVotesValues, type, 'upvote'));
  }, [type, storedVotesValues]);
  useEffect(() => {
    setSliderDownvote(getVoteValue(storedVotesValues, type, 'downvote'));
  }, [type, storedVotesValues]);
  const checkVote = post.active_votes.find((e) => e.voter === voter);
  const isLite = user?.account_tier === 'lite';
  /**
   * ★★★ THE TIER IS NOT KNOWN AS EARLY AS THE LOGIN IS (2026-08-13, A1 review
   * V-2). `identity` decides WHICH branch renders and answers from the server
   * cookie immediately; `isLite` above and the mutation's own branch
   * (`use-vote-mutation.ts`, `user.account_tier === 'lite'`) read the RAW
   * client object, which `useSessionIdentity` does not carry. On a cold tab —
   * new device, cleared storage, private window — there is no localStorage
   * seed, so for the first few hundred ms to few seconds `identity.isLoggedIn`
   * is TRUE while `user` is still `defaultUser` with NO `account_tier`.
   *
   * `isLite` therefore false-negatives to "not lite" in exactly that window,
   * and a keyless Lumen account clicking upvote takes the CHAIN branch of
   * `mutationFn` -> `transactionService.upVote` -> it has no keys -> the vote
   * fails, having never been offered the lite path that would have worked.
   *
   * Same hazard, and same starting point, as the guard
   * `wallet-right-rail.tsx:83-98` already documents for the Advanced Tools
   * card. The wallet's answer is to HIDE the card; hiding here (or falling
   * back to the signed-out branch) would reintroduce the very logged-out
   * flash `identity` exists to remove, so the controls render in their
   * signed-in form and are DISABLED until the tier is known. A vote arrow
   * that is briefly not clickable is honest; one that silently sends a lite
   * user's vote down a path that cannot work is not.
   *
   * ★ THE GATE IS NARROW ON PURPOSE — three near-misses are baked into it:
   *
   * 1. NOT `!user?.account_tier`. `account_tier` is only ever SET to 'lite'
   *    (every check in the codebase is `=== 'lite'` / `!== 'lite'`, and
   *    `defaultUser` omits it) — it is `undefined` for every full Hive
   *    account even after the answer lands. Gating on its absence would have
   *    disabled the vote arrows for every Hive user, permanently.
   *
   * 2. `!user.isLoggedIn` narrows this to the ONLY window where the tier is
   *    genuinely unknown. `useSessionIdentity` has three sources, and the
   *    localStorage seed (`user.isLoggedIn` true, no answer yet) carries the
   *    whole saved User object including `account_tier` — a returning lite
   *    reader is already correctly detected from it. The unknown case is
   *    strictly the third source: signed in per the SERVER COOKIE with no
   *    client seed at all, i.e. a cold tab. Without this term every signed-in
   *    reader would get dead vote arrows for the first seconds of every page
   *    load, to protect a case that had already resolved itself.
   *
   * 3. `!sessionUnavailable` stops the wait from becoming permanent. When
   *    `/api/users/me` has failed and never once succeeded, `clientAnswered`
   *    stays false FOREVER (React Query's error reducer never touches
   *    `dataUpdatedAt` — see use-user-core.ts), so a bare `!clientAnswered`
   *    gate is a dead control, not a wait. This deliberately does NOT follow
   *    the "we could not check resolves to no" rule the four sibling gates
   *    use: those gate a HIVE-ONLY capability, where refusing is the safe
   *    answer. Voting is available to BOTH tiers, so refusing it is not the
   *    safe answer — it denies every full account the app's core action
   *    because our own session endpoint is down. Once we know no answer is
   *    coming we fall back to exactly today's behaviour, which is no worse
   *    than the status quo for anyone.
   */
  const tierPending =
    identity.isLoggedIn && !identity.clientAnswered && !user.isLoggedIn && !sessionUnavailable;

  // A lite vote is Lumen-LOCAL and never reaches the chain, so `active_votes` can
  // never contain this voter and Hivemind can never confirm the vote. Reading the
  // chain here is what made a lite vote light up and then vanish on the next load.
  // Source the vote from Lumen instead, and enable the query on sign-in rather than
  // on a chain vote that will never be there.
  //
  // ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). This called
  // `getListVotesByCommentVoter` directly — it reaches `getChain()` and
  // downloads `wax.common.wasm`. `enabled` below fires on mount for any
  // rendered post/comment the signed-in viewer has already voted on (no click
  // needed) — every `MediumPostCard` on the home feed and both profile tabs,
  // every comment in a post's thread. See `apps/blog/app/api/comment-vote/route.ts`.
  const { data: userVotes } = useQuery({
    queryKey: ['votes', post.author, post.permlink, voter],
    queryFn: () =>
      isLite
        ? fetchLiteEngagement(post.author, post.permlink)
        : fetchListVotesByCommentVoter(post.author, post.permlink, voter),
    enabled: isLite ? !!voter : !!checkVote || !!clickedVoteButton,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false
  });
  const { net_vests, vestsKnown } = useLoggedUserContext();
  /**
   * ★★★ THE PERCENTAGE PICKER MUST NOT BE DECIDED BY A PLACEHOLDER
   * (2026-08-13 — the "I can't set the % of a vote, it's either 100% or it
   * doesn't work" report).
   *
   * This read `net_vests > THRESHOLD`, and `net_vests` is 0 both when the
   * account really is below the threshold AND whenever the answer has not
   * arrived — including for good, when `/api/account` or `/api/users/me`
   * fails. See the long note in `use-logged-user.tsx` for the four states 0
   * stands for. Every one of those non-answers fell through to the plain
   * one-shot branch further down, which is not an inert placeholder: it is a
   * live button whose onClick is `submitVote(10000)`. Same icon, same size,
   * same position as the picker — nothing tells the reader that this click
   * spends 100% of their voting power irreversibly instead of opening a
   * slider.
   *
   * Measured on :3000 with a real signed-in account (lordbutterfly,
   * net_vests = 112,275,707.67, i.e. 112x the threshold, so the picker was
   * always the correct branch):
   *   · normal load ....... one-shot button from t=731ms to t=1138ms
   *   · slow chain read ... one-shot button from t=721ms to t=6592ms
   *   · /api/account 502 .. one-shot button from t=818ms, permanently
   *   · /api/users/me 500 . one-shot button from t=3537ms, permanently
   * and a click in that state was confirmed to take the vote path, not to
   * open a picker and not to open a login dialog.
   *
   * UNKNOWN THEREFORE RESOLVES TO "OFFER THE PICKER", not to "cast 100%".
   * The threshold exists so accounts too small for the percentage to matter
   * are not made to drag a slider — a convenience. Showing a picker to an
   * account that turns out to be below it costs one extra click; withholding
   * it from an account above it costs a full-power vote the reader never
   * chose. Those are not comparable, so the fallback goes to the side that
   * cannot destroy anything. This deliberately follows the same reasoning as
   * `tierPending` above — never let "we could not check" silently become an
   * action — while reaching the opposite conclusion about DISABLING, for the
   * reason recorded there: refusing to vote is not a safe answer for voting.
   *
   * ★ Known cost, stated rather than hidden: an account BELOW the threshold
   * now sees the picker until its own vests land, then settles to the plain
   * arrow. If it had the popover open at that instant the popover closes. It
   * needs a sub-threshold account (~530 HP) opening the picker inside the
   * sub-second window before its own account read returns, and it resolves
   * itself; the alternative was a live 100% button on every account above the
   * threshold in the same window, and permanently whenever a read failed.
   */
  const enable_slider = !vestsKnown || net_vests > VOTE_WEIGHT_DROPDOWN_THRESHOLD;

  const userVote =
    userVotes?.votes[0] && userVotes?.votes[0].voter === voter ? userVotes.votes[0] : undefined;
  const voteMutation = useVoteMutation();
  // Single disabled expression for every vote control: in flight, or the
  // account tier is not yet known (see `tierPending` above).
  const voteDisabled = voteMutation.isLoading || tierPending;

  /**
   * ★★★ WHICH WAY I VOTED — AND WHY `checkVote` IS NOW A FALLBACK
   * (2026-08-14, Blade rebuild).
   *
   * This used to read ONLY `userVote`, i.e. only the `['votes', …]` query. That
   * query is `enabled: !!checkVote || !!clickedVoteButton`, so on a post I have
   * already voted on it does fire — but it has to round-trip before it answers,
   * and until it does, both flags below were false and the component rendered
   * the NOT-YET-VOTED branch. Clicking in that window submits a fresh vote
   * instead of opening the withdraw dialog. That is not a theory: the project's
   * own fixture guide documents it as the "`list_votes` race" and tells test
   * authors to wait for the filled icon before clicking
   * (`playwright/tests/fixture/CLAUDE.md`).
   *
   * `checkVote` is the SAME fact, already present in the SSR payload —
   * `active_votes` carries `{voter, rshares}` and the sign of `rshares` is the
   * direction. Reading it as the fallback closes the race with data the page
   * already had, and matters far more now than it did: the tallies below are
   * derived from this, so getting it wrong would not just mis-target a click,
   * it would print a wrong NUMBER (`stats.total_votes` already counts my vote,
   * so failing to attribute it to me lands it on the wrong side of the split).
   *
   * Precedence is deliberate and must not be swapped: `userVote` FIRST. It is
   * the one that goes optimistic the instant I click, and it is the only one
   * that can represent "I just withdrew" — `active_votes` still holds the stale
   * chain row at that moment, so a `checkVote`-first order would resurrect a
   * vote I had just removed.
   */
  const myVote: MyVote = userVote
    ? userVote.vote_percent > 0
      ? 'up'
      : userVote.vote_percent < 0
        ? 'down'
        : 'none'
    : checkVote
      ? Number(checkVote.rshares) < 0
        ? 'down'
        : Number(checkVote.rshares) > 0
          ? 'up'
          : 'none'
      : 'none';
  const vote_upvoted = myVote === 'up';
  const vote_downvoted = myVote === 'down';

  // Split tallies — see vote-tallies.ts for why `down` is scraped and `up` is
  // the remainder of the authoritative total, and for the Hivemind 1000-vote
  // cap that bounds it.
  const tally = splitTally(post, voter, myVote);

  const [upRing, fireUpRing, clearUpRing] = useCommitRing();
  const [downRing, fireDownRing, clearDownRing] = useCommitRing();

  /**
   * ★★★ THE CAST ANIMATION FIRES ON THE TRANSITION, NOT ON THE CLICK
   * (2026-08-14). Driving it from the click handlers looked simpler and was
   * wrong three ways:
   *
   *  · the picker's confirm button UNMOUNTS the instant `voteMutation.isLoading`
   *    swaps that side to the spinner, taking the ring with it, so the cast
   *    through the percentage picker — the primary path for anyone above the
   *    vests threshold — animated for a few frames and then vanished;
   *  · nothing fired at all when a vote arrived from anywhere other than a click
   *    on this instance;
   *  · the ring's own safety timeout could expire during a slow broadcast, so
   *    whether the animation played at all depended on chain latency.
   *
   * `myVote` is the single fact the whole control is drawn from, and it flips
   * the moment the optimistic update lands. Watching it means the animation
   * marks exactly the frame the blade fills, on every path, once.
   *
   * ★★★ A FIRST-RENDER GUARD ALONE IS NOT ENOUGH — MEASURED (2026-08-14).
   * The obvious version of this was just `previous === null` as a mount guard.
   * On `/@lordbutterfly` it fired 38 animations (19 pops + 19 rings) on page
   * load, on the 19 posts this reader had voted on days earlier. The reason is
   * that `myVote` is not `'up'` at the first render there: it depends on
   * `voter`, which depends on `useSessionIdentity`, which needs a beat before it
   * answers — so the sequence is a perfectly ordinary `'none' -> 'up'` a render
   * or two in, indistinguishable from a cast by shape alone. The same is true of
   * a lite account, whose vote arrives from `fetchLiteEngagement` after mount.
   *
   * So the test is not "did it change" but "did THIS READER change it".
   * `clickedVoteButton` answers exactly that, and it is component state, so it
   * survives the confirm button inside the picker being unmounted by the
   * in-flight spinner — which is what made the click handlers themselves an
   * unusable place to fire from.
   */
  const prevMyVote = useRef<MyVote | null>(null);
  useEffect(() => {
    const previous = prevMyVote.current;
    prevMyVote.current = myVote;
    if (previous === null || previous === myVote) return;
    // Learning about an existing vote is not casting one.
    if (!clickedVoteButton) return;
    if (myVote === 'up') fireUpRing();
    else if (myVote === 'down') fireDownRing();
    // Withdrawing (-> 'none') deliberately animates nothing: nothing was cast.
  }, [myVote]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (userVote && userVote.vote_percent > 0) {
      setSliderUpvote([userVote.vote_percent / 100]);
    }
    if (userVote && userVote.vote_percent < 0) {
      setSliderDownvote([-userVote.vote_percent / 100]);
    }
  }, [userVotes]);

  const submitVote = async (weight: number) => {
    // ★ Belt and braces for V-2: every control below is already `disabled`
    // while `tierPending`, but this is the single funnel every one of them
    // goes through, so the write itself refuses rather than relying on six
    // separate `disabled` props staying correct.
    if (tierPending) return;
    const { author, permlink } = post;
    try {
      await voteMutation.mutateAsync({ voter, author, permlink, weight });
    } catch (error) {
      setClickedVoteButton('');
      handleError(error, { method: 'vote', params: { voter, author, permlink, weight } });
    }
  };

  /**
   * ★ THE TAP TARGET IS NOW THE BUTTON ITSELF (2026-08-14, Blade rebuild).
   *
   * This used to be `'group inline-flex items-center justify-center p-2'` — a
   * Tailwind string whose whole job was to grow a ~20px icon into a ~36px box
   * and to supply the `group` that six `group-hover:` rules depended on. The
   * Blade control sizes its own button (53x53, or 38x38 at `--sm`) and states
   * its hover in plain CSS on that same element, so both problems the old
   * string existed to solve are gone rather than re-solved. The measured floor
   * from the handoff — never under a 38px target, never under a 20px glyph,
   * because the concave flanks fuse below that — is enforced in
   * `vote-control.module.css`, not here.
   */
  const rootClass = clsx(voteStyles.root, { [voteStyles.sm]: size === 'sm' });
  const upBtnClass = clsx(voteStyles.btn, voteStyles.up, {
    [voteStyles.mine]: vote_upvoted,
    [voteStyles.casting]: upRing
  });
  const downBtnClass = clsx(voteStyles.btn, voteStyles.down, {
    [voteStyles.mine]: vote_downvoted,
    [voteStyles.casting]: downRing
  });

  const upvoteUndoLabel =
    userVote && userVote.vote_percent === 10000 && !enable_slider
      ? t('cards.post_card.undo_upvote')
      : t('cards.post_card.undo_upvote_percent', {
          votePercent: ((userVote?.vote_percent ?? 0) / 100).toFixed(2)
        });
  const downvoteUndoLabel =
    userVote && userVote.vote_percent === -10000 && !enable_slider
      ? t('cards.post_card.undo_downvote')
      : t('cards.post_card.undo_downvote_percent', {
          votePercent: (-(userVote?.vote_percent ?? 0) / 100).toFixed(2)
        });

  /**
   * ★★★ HOW THE PERCENTAGE PICKER AND THE BLADE COEXIST — the one thing the
   * handoff does not answer (2026-08-14).
   *
   * The handoff says under "Not included": *"Vote-weight slider (Hive's
   * percentage picker) — this is the 100% control only."* The owner, in the
   * same breath, says the slider must still be there. So the design does not
   * specify the join, and this is the decision taken, stated plainly:
   *
   *   **The Blade is the control. The percentage picker stays exactly where it
   *   already is — behind the primary click, as the popover this component
   *   already ships — for accounts above the vests threshold. Below it (and for
   *   lite accounts) the primary click casts 100% directly, which is the
   *   handoff's "100% control only" behaviour, unchanged and pixel-for-pixel as
   *   drawn.**
   *
   * Both halves of the brief are therefore true at once, on the same control,
   * with no new gesture to learn.
   *
   * ★ WHY NOT A LONG-PRESS, which was the suggested alternative. Because a
   * long-press makes the plain click cast 100% — and that is precisely the
   * defect this same session was opened to fix. The owner's report was "I can't
   * set the % of a vote once I click vote. It's either 100% or it doesn't
   * work"; measured, the cause was the control falling through to a one-shot
   * 100% button (see `enable_slider` above). Demoting the picker to a hidden
   * gesture would re-create that experience by design, on every click, for
   * everyone — and long-press has no discoverable affordance on desktop and
   * fights scroll on touch. The percentage step stays on the primary path.
   *
   * ★ WHERE THE CAST ANIMATION FIRES. On the action that actually casts. In the
   * picker that is the confirm blade inside the popover, not the trigger — the
   * trigger only opens a menu, and popping/ringing on it would be a lie about
   * what just happened. On the one-shot branch the trigger IS the cast, so it
   * fires there.
   */

  const upTally = (
    <VoteTally value={tally.up} side="up" mine={vote_upvoted} testId="vote-tally-up" />
  );
  /**
   * ★ ABSENT, NOT HIDDEN. The handoff is explicit that a post with no downvotes
   * renders no down tally element at all — not an empty span, not
   * `visibility: hidden` — so the UI never advertises downvoting. `null` here is
   * the whole implementation; there is deliberately no CSS rule that could be
   * "fixed" later into hiding an element that should not exist.
   */
  const downTally =
    tally.down > 0 ? (
      <VoteTally value={tally.down} side="down" mine={vote_downvoted} testId="vote-tally-down" />
    ) : null;

  return (
    <div className={rootClass} data-testid="vote-control">
      <span className={voteStyles.side}>
        {/* Upvote */}
        {clickedVoteButton === 'up' && voteMutation.isLoading ? (
          <span className={voteStyles.pending}>
            <CircleSpinner loading size={20} color="#c0392b" />
          </span>
        ) : identity.isLoggedIn && enable_slider && !vote_upvoted ? (
          <Popover>
            {/* ★ ONE REAL <button>, TWO NESTED `asChild` (2026-08-13, item 3).
                `TooltipTrigger asChild` clones its child (`PopoverTrigger`);
                `PopoverTrigger asChild` clones ITS child (the button). Both are
                genuine Radix primitives that spread merged props all the way
                down (verified against @radix-ui/react-primitive's `Primitive.button`
                and @radix-ui/react-popover's `PopoverTrigger` source), so the
                tooltip's hover/focus handlers AND the popover's click-to-open
                both land on the same single, natively focusable element. */}
            <TooltipContainer
              side="top"
              title={
                <VoteTooltip
                  text={t('cards.post_card.upvote')}
                  afterPayout={pastPayout && !vote_upvoted}
                />
              }
              contentTestId="upvote-button-tooltip"
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-testid="upvote-button"
                  aria-label={t('cards.post_card.upvote')}
                  aria-pressed={false}
                  disabled={voteDisabled}
                  className={upBtnClass}
                >
                  <BladeGlyph />
                </button>
              </PopoverTrigger>
            </TooltipContainer>
            <PopoverContent
              className="z-50 max-w-xs rounded-lg bg-background-secondary p-4 shadow-lg"
              sideOffset={offsetSlider.popoverSideOffset}
              align="start"
              alignOffset={offsetSlider.popoverAlignOfset}
              data-testid="upvote-slider-modal"
            >
              <div className="flex h-full items-center gap-2">
                <TooltipContainer
                  side="top"
                  title={
                    <VoteTooltip
                      text={t('cards.post_card.upvote')}
                      afterPayout={pastPayout && !vote_upvoted}
                    />
                  }
                  contentTestId="upvote-button-slider-tooltip"
                >
                  <button
                    type="button"
                    data-testid="upvote-button-slider"
                    aria-label={t('cards.post_card.upvote')}
                    className={clsx(voteStyles.btn, voteStyles.up)}
                    disabled={voteDisabled}
                    onClick={() => {
                      setClickedVoteButton('up');
                      submitVote(sliderUpvote[0] * 100);
                      storeVotesValues((prev) => ({
                        ...prev,
                        [type]: {
                          ...prev[type],
                          upvote: sliderUpvote
                        }
                      }));
                    }}
                  >
                    {upRing ? <CommitRing onDone={clearUpRing} /> : null}
                    <BladeGlyph />
                  </button>
                </TooltipContainer>
                <Slider
                  dataTestId="upvote-slider"
                  defaultValue={sliderUpvote}
                  value={sliderUpvote}
                  min={1}
                  className="w-36"
                  onValueChange={(e: number[]) => setSliderUpvote(e)}
                />
                <div className="w-fit" data-testid="upvote-slider-percentage-value">
                  {sliderUpvote}%
                </div>
              </div>
            </PopoverContent>
          </Popover>
        ) : identity.isLoggedIn && vote_upvoted ? (
          // ★ BRANCH B WAS KEYBOARD-UNREACHABLE (2026-08-13, item 3). The old
          // `AlertDialogTrigger asChild` landed on a bare, non-focusable
          // `<span>` — removing your own upvote was impossible without a mouse.
          // `VoteRemovalDialog` now forwards ref + extra props (see that file),
          // so the same double-`asChild` composition as above works here too:
          // Tooltip -> VoteRemovalDialog(AlertDialogTrigger) -> button.
          <TooltipContainer
            side="top"
            title={<VoteTooltip text={upvoteUndoLabel} afterPayout={pastPayout && !vote_upvoted} />}
            contentTestId="upvote-button-tooltip"
          >
            <VoteRemovalDialog
              voteType="upvote"
              onConfirm={() => {
                setClickedVoteButton('up');
                submitVote(0);
              }}
            >
              <button
                type="button"
                data-testid="upvote-button"
                aria-label={upvoteUndoLabel}
                aria-pressed={true}
                disabled={voteDisabled}
                className={upBtnClass}
              >
                {upRing ? <CommitRing onDone={clearUpRing} /> : null}
                <BladeGlyph />
              </button>
            </VoteRemovalDialog>
          </TooltipContainer>
        ) : identity.isLoggedIn ? (
          <TooltipContainer
            side="top"
            title={
              <VoteTooltip
                text={t('cards.post_card.upvote')}
                afterPayout={pastPayout && !vote_upvoted}
              />
            }
            contentTestId="upvote-button-tooltip"
          >
            <button
              type="button"
              data-testid="upvote-button"
              aria-label={t('cards.post_card.upvote')}
              aria-pressed={false}
              disabled={voteDisabled}
              className={upBtnClass}
              onClick={() => {
                if (voteDisabled) return;
                setClickedVoteButton('up');
                submitVote(10000);
              }}
            >
              {upRing ? <CommitRing onDone={clearUpRing} /> : null}
              <BladeGlyph />
            </button>
          </TooltipContainer>
        ) : (
          // ★ BRANCHES D KEPT WITHOUT THE SHARED TOOLTIP (2026-08-13, item 3).
          // `DialogLogin` (`apps/blog/components/dialog-login.tsx`) is outside
          // this fix's owned files. It IS already `forwardRef`, so nesting a
          // Tooltip outside it does not break DialogLogin's own job (its
          // internal `DialogTrigger asChild` wires the real button directly,
          // independent of props an outer wrapper injects onto DialogLogin
          // itself) — verified against its source. But DialogLogin does not
          // spread arbitrary extra props (only `children`/`redirectTo`), so
          // the tooltip's own hover/focus handlers would never reach the real
          // button and the popup would silently never open. Rather than ship
          // a Tooltip wrapper that structurally cannot work, `aria-label` on
          // the real button carries the same text a screen reader needs; the
          // decorative hover tooltip is the one thing this branch does not
          // get, and that is a deliberate, scoped trade-off, not an oversight.
          <DialogLogin>
            <button
              type="button"
              data-testid="upvote-button"
              aria-label={t('cards.post_card.upvote')}
              aria-pressed={false}
              disabled={voteDisabled}
              className={upBtnClass}
            >
              <BladeGlyph />
            </button>
          </DialogLogin>
        )}
        {upTally}
      </span>

      <span className={voteStyles.side}>
        {/* Downvote */}
        {clickedVoteButton === 'down' && voteMutation.isLoading ? (
          <span className={voteStyles.pending}>
            <CircleSpinner loading size={20} color="#5b6470" />
          </span>
        ) : identity.isLoggedIn && enable_slider && !vote_downvoted ? (
          <Popover>
            <TooltipContainer
              side="top"
              title={
                <VoteTooltip
                  text={t('cards.post_card.downvote')}
                  afterPayout={pastPayout && !vote_downvoted}
                />
              }
              contentTestId="downvote-button-tooltip"
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-testid="downvote-button"
                  aria-label={t('cards.post_card.downvote')}
                  aria-pressed={false}
                  disabled={voteDisabled}
                  className={downBtnClass}
                >
                  <BladeGlyph />
                </button>
              </PopoverTrigger>
            </TooltipContainer>
            <PopoverContent
              className="z-50 max-w-xs rounded-lg bg-background-secondary p-4 shadow-lg"
              sideOffset={offsetSlider.popoverSideOffset}
              align="start"
              alignOffset={offsetSlider.popoverAlignOfset}
              data-testid="downvote-slider-modal"
            >
              <div className="flex h-full items-center gap-2">
                <TooltipContainer
                  side="top"
                  title={
                    <VoteTooltip
                      text={t('cards.post_card.downvote')}
                      afterPayout={pastPayout && !vote_downvoted}
                    />
                  }
                  contentTestId="downvote-button-slider-tooltip"
                >
                  <button
                    type="button"
                    data-testid="downvote-button-slider"
                    aria-label={t('cards.post_card.downvote')}
                    className={clsx(voteStyles.btn, voteStyles.down)}
                    disabled={voteDisabled}
                    onClick={() => {
                      setClickedVoteButton('down');
                      submitVote(-sliderDownvote[0] * 100);
                      storeVotesValues((prev) => ({
                        ...prev,
                        [type]: {
                          ...prev[type],
                          downvote: sliderDownvote
                        }
                      }));
                    }}
                  >
                    {downRing ? <CommitRing onDone={clearDownRing} /> : null}
                    <BladeGlyph />
                  </button>
                </TooltipContainer>
                <Slider
                  dataTestId="downvote-slider"
                  defaultValue={sliderDownvote}
                  value={sliderDownvote}
                  min={1}
                  className="w-36"
                  onValueChange={(e: number[]) => setSliderDownvote(e)}
                />
                <div
                  className="w-fit text-destructive"
                  data-testid="downvote-slider-percentage-value"
                >
                  -{sliderDownvote}%
                </div>
              </div>
              <div
                className="flex flex-col gap-1 pt-2 text-sm"
                data-testid="downvote-description-content"
              >
                <p>{t('cards.post_card.downvote_warning')}</p>
                <ul>
                  <li>{t('cards.post_card.reason_1')}</li>
                  <li>{t('cards.post_card.reason_2')}</li>
                  <li>{t('cards.post_card.reason_3')}</li>
                  <li>{t('cards.post_card.reason_4')}</li>
                </ul>
              </div>
            </PopoverContent>
          </Popover>
        ) : identity.isLoggedIn && vote_downvoted ? (
          <TooltipContainer
            side="top"
            title={
              <VoteTooltip text={downvoteUndoLabel} afterPayout={pastPayout && !vote_downvoted} />
            }
            contentTestId="downvote-button-tooltip"
          >
            <VoteRemovalDialog
              voteType="downvote"
              onConfirm={() => {
                setClickedVoteButton('down');
                submitVote(0);
              }}
            >
              <button
                type="button"
                data-testid="downvote-button"
                aria-label={downvoteUndoLabel}
                aria-pressed={true}
                disabled={voteDisabled}
                className={downBtnClass}
              >
                {downRing ? <CommitRing onDone={clearDownRing} /> : null}
                <BladeGlyph />
              </button>
            </VoteRemovalDialog>
          </TooltipContainer>
        ) : identity.isLoggedIn ? (
          <TooltipContainer
            side="top"
            title={
              <VoteTooltip
                text={t('cards.post_card.downvote')}
                afterPayout={pastPayout && !vote_downvoted}
              />
            }
            contentTestId="downvote-button-tooltip"
          >
            <button
              type="button"
              data-testid="downvote-button"
              aria-label={t('cards.post_card.downvote')}
              aria-pressed={false}
              disabled={voteDisabled}
              className={downBtnClass}
              onClick={() => {
                if (voteDisabled) return;
                setClickedVoteButton('down');
                submitVote(-10000);
              }}
            >
              {downRing ? <CommitRing onDone={clearDownRing} /> : null}
              <BladeGlyph />
            </button>
          </TooltipContainer>
        ) : (
          <DialogLogin>
            <button
              type="button"
              data-testid="downvote-button"
              aria-label={t('cards.post_card.downvote')}
              aria-pressed={false}
              disabled={voteDisabled}
              className={downBtnClass}
            >
              <BladeGlyph />
            </button>
          </DialogLogin>
        )}
        {downTally}
      </span>
    </div>
  );
};

export default VotesComponent;

/**
 * Presentational tooltip body: a bold label plus an optional after-payout
 * note. Replaces the old local `TooltipContainer`'s inline JSX — it renders
 * no trigger and creates no focusable node, so it is safe to pass as the
 * shared `TooltipContainer`'s `title` (now `ReactNode`, not `string`).
 */
function VoteTooltip({ text, afterPayout }: { text: string; afterPayout?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center">
      <div className="font-bold">{text}</div>
      {afterPayout && (
        <div className="text-xs text-destructive opacity-80">
          Voting on Content after their payout does not generate any new rewards
        </div>
      )}
    </div>
  );
}
