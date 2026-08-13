import { useEffect, useState } from 'react';
import { useStorageWithTTL } from '@ui/hooks/useStorageWithTTL';
import { StorageTTL } from '@ui/lib/storage-with-ttl';
import clsx from 'clsx';
import { CircleSpinner } from 'react-spinners-kit';
import TooltipContainer from '@ui/components/tooltip-container';
import { Slider } from '@ui/components/slider';
import { Icons } from '@ui/components/icons';
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

const VotesComponent = ({ post, type }: { post: Entry; type: 'comment' | 'post' }) => {
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
  const { net_vests } = useLoggedUserContext();
  const enable_slider = net_vests > VOTE_WEIGHT_DROPDOWN_THRESHOLD;

  const userVote =
    userVotes?.votes[0] && userVotes?.votes[0].voter === voter ? userVotes.votes[0] : undefined;
  const voteMutation = useVoteMutation();
  // Single disabled expression for every vote control: in flight, or the
  // account tier is not yet known (see `tierPending` above).
  const voteDisabled = voteMutation.isLoading || tierPending;
  const vote_upvoted = userVote ? userVote.vote_percent > 0 : false;
  const vote_downvoted = userVote ? userVote.vote_percent < 0 : false;

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

  // ★ THUMB-SIZED TAP TARGET (2026-08-08, preserved). `p-2` grows the ~20px
  // icon to a ~36px box and pushes upvote/downvote apart — was on a wrapper
  // `<span>`, now lives directly on each real `<button>` below.
  //
  // ★ `group` ADDED (2026-08-13, A1 review V-3). Six icons below style their
  // hover state with `group-hover:` — which Tailwind emits as the DESCENDANT
  // selector `.group:hover .group-hover\:x` (confirmed in this app's own built
  // CSS) — but no element in the tree carried the `group` class: not this tap
  // target, and not any of the five ancestors that render this component
  // (medium-post-card, post-list-item, comment-list-item,
  // profile-comment-card, [permlink]/content). So those rules matched nothing
  // and the vote arrows had NO hover feedback at all — but only when signed
  // IN, because both signed-OUT branches put `group` on their own button. Same
  // page, opposite behaviour depending on session state.
  //
  // Fixed by supplying the missing `group` rather than by rewriting the icons
  // to plain `hover:`: the hover target is meant to be the whole ~36px tap
  // box, not the ~20px icon inside it, which is exactly what the signed-out
  // branches already do.
  const tapTargetClass = 'group inline-flex items-center justify-center p-2';

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

  return (
    <div className="flex items-center gap-1.5">
      {/* Upvote with slider - trigger */}
      {clickedVoteButton === 'up' && voteMutation.isLoading ? (
        <CircleSpinner
          loading={clickedVoteButton === 'up' && voteMutation.isLoading}
          size={20}
          color="#dc2626"
        />
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
            title={<VoteTooltip text={t('cards.post_card.upvote')} afterPayout={pastPayout && !vote_upvoted} />}
            contentTestId="upvote-button-tooltip"
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="upvote-button"
                aria-label={t('cards.post_card.upvote')}
                disabled={voteDisabled}
                className={tapTargetClass}
              >
                <Icons.arrowUpCircle
                  className={clsx(
                    'h-5 w-5 rounded-xl text-destructive transition-colors group-hover:text-[#96271b]',
                    { 'bg-destructive-icon text-white': userVote && userVote.vote_percent > 0 }
                  )}
                />
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
                title={<VoteTooltip text={t('cards.post_card.upvote')} afterPayout={pastPayout && !vote_upvoted} />}
                contentTestId="upvote-button-slider-tooltip"
              >
                <button
                  type="button"
                  data-testid="upvote-button-slider"
                  aria-label={t('cards.post_card.upvote')}
                  className={clsx('group flex h-full items-center justify-center', 'p-2')}
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
                  <Icons.arrowUpCircle className="h-[24px] w-[24px] cursor-pointer rounded-xl text-destructive transition-colors group-hover:text-[#96271b] sm:mr-1" />
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
              disabled={voteDisabled}
              className={tapTargetClass}
            >
              <Icons.arrowUpCircle className="h-5 w-5 cursor-pointer rounded-xl bg-destructive-icon text-white hover:bg-destructive-icon hover:text-white" />
            </button>
          </VoteRemovalDialog>
        </TooltipContainer>
      ) : identity.isLoggedIn ? (
        <TooltipContainer
          side="top"
          title={<VoteTooltip text={t('cards.post_card.upvote')} afterPayout={pastPayout && !vote_upvoted} />}
          contentTestId="upvote-button-tooltip"
        >
          <button
            type="button"
            data-testid="upvote-button"
            aria-label={t('cards.post_card.upvote')}
            disabled={voteDisabled}
            className={tapTargetClass}
            onClick={() => {
              if (voteDisabled) return;
              setClickedVoteButton('up');
              submitVote(10000);
            }}
          >
            <Icons.arrowUpCircle className="h-5 w-5 rounded-xl text-destructive transition-colors group-hover:text-[#96271b]" />
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
            disabled={voteDisabled}
            className={clsx(tapTargetClass, 'rounded-xl transition-colors hover:bg-[#fdf2f0]')}
          >
            <Icons.arrowUpCircle className="h-5 w-5 rounded-xl text-destructive transition-colors group-hover:text-[#96271b]" />
          </button>
        </DialogLogin>
      )}
      {/* Downvote with slider - trigger */}
      {clickedVoteButton === 'down' && voteMutation.isLoading ? (
        <CircleSpinner
          loading={clickedVoteButton === 'down' && voteMutation.isLoading}
          size={20}
          color="#dc2626"
        />
      ) : identity.isLoggedIn && enable_slider && !vote_downvoted ? (
        <Popover>
          <TooltipContainer
            side="top"
            title={<VoteTooltip text={t('cards.post_card.downvote')} afterPayout={pastPayout && !vote_downvoted} />}
            contentTestId="downvote-button-tooltip"
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="downvote-button"
                aria-label={t('cards.post_card.downvote')}
                disabled={voteDisabled}
                className={tapTargetClass}
              >
                <Icons.arrowDownCircle
                  className={clsx(
                    'h-5 w-5 rounded-xl text-gray-600 transition-colors group-hover:bg-[#f1f3f5] group-hover:text-[#3f4650]',
                    { 'bg-gray-600 text-white': userVote && userVote.vote_percent < 0 }
                  )}
                />
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
                title={<VoteTooltip text={t('cards.post_card.downvote')} afterPayout={pastPayout && !vote_downvoted} />}
                contentTestId="downvote-button-slider-tooltip"
              >
                <button
                  type="button"
                  data-testid="downvote-button-slider"
                  aria-label={t('cards.post_card.downvote')}
                  className="group flex h-full items-center justify-center p-2"
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
                  <Icons.arrowDownCircle className="h-[24px] w-[24px] cursor-pointer rounded-xl text-gray-600 transition-colors group-hover:bg-[#f1f3f5] group-hover:text-[#3f4650] sm:mr-1" />
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
              <div className="w-fit text-destructive" data-testid="downvote-slider-percentage-value">
                -{sliderDownvote}%
              </div>
            </div>
            <div className="flex flex-col gap-1 pt-2 text-sm" data-testid="downvote-description-content">
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
          title={<VoteTooltip text={downvoteUndoLabel} afterPayout={pastPayout && !vote_downvoted} />}
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
              disabled={voteDisabled}
              className={tapTargetClass}
            >
              <Icons.arrowDownCircle className="h-5 w-5 cursor-pointer rounded-xl bg-destructive-icon text-white opacity-80 hover:bg-gray-600 hover:text-white" />
            </button>
          </VoteRemovalDialog>
        </TooltipContainer>
      ) : identity.isLoggedIn ? (
        <TooltipContainer
          side="top"
          title={<VoteTooltip text={t('cards.post_card.downvote')} afterPayout={pastPayout && !vote_downvoted} />}
          contentTestId="downvote-button-tooltip"
        >
          <button
            type="button"
            data-testid="downvote-button"
            aria-label={t('cards.post_card.downvote')}
            disabled={voteDisabled}
            className={tapTargetClass}
            onClick={() => {
              if (voteDisabled) return;
              setClickedVoteButton('down');
              submitVote(-10000);
            }}
          >
            <Icons.arrowDownCircle className="h-5 w-5 rounded-xl text-gray-600 transition-colors group-hover:bg-[#f1f3f5] group-hover:text-[#3f4650]" />
          </button>
        </TooltipContainer>
      ) : (
        <DialogLogin>
          <button
            type="button"
            data-testid="downvote-button"
            aria-label={t('cards.post_card.downvote')}
            disabled={voteDisabled}
            className={clsx(tapTargetClass, 'rounded-xl transition-colors hover:bg-[#f1f3f5]')}
          >
            <Icons.arrowDownCircle className="h-5 w-5 rounded-xl text-gray-600 transition-colors group-hover:bg-[#f1f3f5] group-hover:text-[#3f4650]" />
          </button>
        </DialogLogin>
      )}
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
