import { useRef } from 'react';
import { haptic } from '@/blog/lib/haptics';
import { useMutation, QueryClient, useQueryClient } from '@tanstack/react-query';
import { TransactionBroadcastResult, transactionService } from '@transaction/index';
import { fetchListVotesByCommentVoter } from '@/blog/lib/chain-fetch';
import { getLogger } from '@ui/lib/logging';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { scheduleInvalidations, scheduleValidatedRefetch } from '@/blog/lib/react-query';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { liteVote } from '@/blog/lib/lite/client/lite-write';
import { recordRetentionAct } from '@/blog/features/retention/components/retention-moments';

const logger = getLogger('app');

const MAX_WALK_DEPTH = 8;

/**
 * A cached node is a vote target iff it carries this author+permlink AND a
 * numeric `stats.total_votes` — the one shape every live vote-count surface
 * shares (`Entry`, and every response wrapper that nests `Entry`s).
 */
function isVoteTarget(node: Record<string, unknown>, author: string, permlink: string): boolean {
  if (node.author !== author || node.permlink !== permlink) return false;
  const stats = node.stats;
  return (
    !!stats &&
    typeof stats === 'object' &&
    typeof (stats as { total_votes?: unknown }).total_votes === 'number'
  );
}

/**
 * Object kinds we must not recurse into: enumerating their keys is
 * meaningless (Date/RegExp/Promise) or would corrupt them (Map/Set/typed
 * arrays), and none of them can structurally hold a vote-target Entry.
 */
function isWalkable(value: object): boolean {
  return !(
    value instanceof Date ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof RegExp ||
    value instanceof Promise ||
    ArrayBuffer.isView(value)
  );
}

/**
 * Copy-on-write walk over one cached query's data: returns the SAME
 * reference when nothing below it changed, and only recreates the objects
 * on the path from the cache root down to a matched entry. That lets
 * memoized siblings (`post-list-item.tsx`'s comparator, which checks
 * `stats?.total_votes` and `original_entry` identity; `CommentListItem`'s
 * default shallow compare) skip re-rendering everything else on the page.
 */
function patchVoteTarget(
  value: unknown,
  author: string,
  permlink: string,
  delta: number,
  depth: number,
  seen: WeakSet<object>
): { value: unknown; changed: boolean } {
  if (depth > MAX_WALK_DEPTH || value === null || typeof value !== 'object') {
    return { value, changed: false };
  }
  if (seen.has(value)) return { value, changed: false }; // cycle guard
  seen.add(value);
  if (!isWalkable(value)) return { value, changed: false };

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = patchVoteTarget(item, author, permlink, delta, depth + 1, seen);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: next, changed: true } : { value, changed: false };
  }

  const node = value as Record<string, unknown>;
  // Match BEFORE any further narrowing — a missed match is the defect being
  // fixed here, so the vote-target check runs on every plain object node.
  if (isVoteTarget(node, author, permlink)) {
    const stats = node.stats as { total_votes: number };
    return {
      value: { ...node, stats: { ...stats, total_votes: Math.max(0, stats.total_votes + delta) } },
      changed: true
    };
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(node)) {
    const result = patchVoteTarget(node[key], author, permlink, delta, depth + 1, seen);
    changed ||= result.changed;
    next[key] = result.value;
  }
  return changed ? { value: next, changed: true } : { value, changed: false };
}

/**
 * Add `delta` to `stats.total_votes` on every cached node matching this
 * author/permlink, across the ENTIRE query cache — not a hand-maintained key
 * list. Rollback is the SAME call with `-delta`; see the block below.
 *
 * ★★★ WHY ROLLBACK IS A RE-WALK, NOT A SNAPSHOT RESTORE (2026-08-13, A1
 * review V-1). This used to return the pre-vote top-level reference of every
 * query it touched, and `onError` restored those references wholesale. The
 * reasoning was "copy-on-write means nothing below it was ever mutated in
 * place, so the old reference is an exact snapshot". The premise is true and
 * the conclusion does not follow: copy-on-write guarantees the snapshot was
 * never MUTATED, not that nothing else WROTE to that query key in the
 * meantime — and a wholesale `setQueryData(key, snapshot)` discards every
 * such write.
 *
 * That was survivable when the key list was three non-paginated keys. It is
 * not survivable now the walk covers `forYouRanked`, `topicFeed`,
 * `discoveryFeedEntries`, `searchByText`, `accountEntriesInfinite` and
 * `profileRedesignEntries` — every one an infinite query holding the pages
 * the reader has scrolled. Simulated against a real @tanstack/query-core v4
 * QueryClient:
 *
 *   vote -> reader scrolls (fetchNextPage adds page 2) -> vote FAILS
 *     snapshot restore : pages 2 -> 1   THE READER'S SECOND PAGE IS GONE
 *
 * and it does not come back: these queries are deliberately `staleTime:
 * Infinity` with every automatic refetch trigger off, and this hook
 * deliberately never invalidates them (see onSuccess), so the feed stays
 * truncated for the rest of the session with the scroll position now below
 * content that vanished. Re-walking with `-delta` cannot do that: it only
 * ever edits a number on a matched node, so pages the reader loaded are
 * untouchable by a rollback.
 *
 * It is also exact where the snapshot was not, in the case A1 measured:
 * two votes in flight on the same feed and the FIRST fails — the snapshot
 * restore wiped the second vote's optimistic +1 (which never self-heals,
 * because that vote SUCCEEDED and success refetches no feed keys); the
 * re-walk subtracts only this vote's own delta and leaves the other alone.
 *
 * ★ Honest about what it does NOT fix, so nobody re-derives the snapshot as
 * an improvement:
 *  - If a background refetch replaces a query's data mid-flight, the fresh
 *    data never received the `+delta`, so subtracting leaves that surface one
 *    LOW until its next refetch. (The snapshot's behaviour in the same case
 *    was to throw the fresh server data away entirely and restore a stale
 *    count — worse, and unbounded rather than off-by-one.)
 *  - The `Math.max(0, …)` clamp below is not symmetric: a node already at 0
 *    that gets `-1` stays 0, and the rollback then adds 1. That needs a
 *    cached `total_votes` of 0 on a post this reader demonstrably has a chain
 *    vote on — in which case 1 is closer to the truth than the 0 a snapshot
 *    would have restored.
 *
 * ★ Why a whole-cache walk, not a key list (2026-08-13): the list this
 * replaced named three keys (`postData`, `discussionData`,
 * `entriesInfinite`) while six live surfaces render vote counts
 * (`discoveryFeedEntries`, `accountEntriesInfinite`, `profileRedesignEntries`,
 * `topicFeed`, `forYouRanked`, `searchByText`), and two of those
 * (`forYouRanked`, `topicFeed`) wrap `Entry[]` inside a response object, so
 * even an up-to-date key list needs a shape-specific handler per key. A key
 * list silently rots — that's exactly how four keys got added over time
 * while the vote count never moved on five of six feeds and nothing failed
 * loudly enough to notice. A copy-on-write walk has no key list to fall out
 * of date; its only risk is over-matching, which is bounded (author +
 * permlink + a numeric `total_votes`) and cheap to test for (see the
 * negative control in the QA steps this ships with).
 */
function adjustCachedTotalVotes(
  queryClient: QueryClient,
  author: string,
  permlink: string,
  delta: number
): void {
  if (delta === 0) return;

  for (const query of queryClient.getQueryCache().getAll()) {
    const data = query.state.data;
    if (data === undefined) continue;
    const result = patchVoteTarget(data, author, permlink, delta, 0, new WeakSet());
    if (!result.changed) continue;
    queryClient.setQueryData(query.queryKey, result.value);
  }
}

/**
 * Makes vote transaction.
 * Uses optimistic UI - vote updates immediately after broadcast.
 *
 * @export
 * @return {*}
 */
export function useVoteMutation() {
  const { user } = useUserClient();
  const queryClient = useQueryClient();
  const cleanupRef = useRef<(() => void) | null>(null);

  const voteMutation = useMutation({
    // Optimistic update BEFORE broadcast
    onMutate: async (params: { voter: string; author: string; permlink: string; weight: number }) => {
      const { voter, author, permlink, weight } = params;
      const queryKey = ['votes', author, permlink, voter];

      // Cancel previous validated refetch schedule (handles rapid re-votes)
      cleanupRef.current?.();
      cleanupRef.current = null;

      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey });

      // Snapshot previous data for rollback
      const prevVoteData = queryClient.getQueryData(queryKey);

      // Optimistically update the vote data
      const newVoteData = {
        votes: [
          {
            author,
            id: 1,
            last_update: new Date().toISOString(),
            num_changes: 0,
            permlink,
            rshares: weight,
            vote_percent: weight,
            voter,
            weight
          }
        ]
      };
      queryClient.setQueryData(queryKey, newVoteData);

      // Determine vote count delta
      //
      // ★ THE ROW MUST BE THIS VOTER'S ROW (pre-existing bug, found 2026-08-12 while
      // verifying the chain-read reroute; NOT introduced by it — the direct
      // `getListVotesByCommentVoter` call this replaced had identical semantics).
      //
      // `database_api.list_votes` with `order: by_comment_voter` returns votes
      // lexicographically STARTING FROM the `[author, permlink, voter]` triple. So
      // when this reader has NOT voted, it does not return an empty list — it
      // returns the NEXT voter's row. Reproduced live: asking for `hbd-temp`'s vote
      // on a real trending post came back with `brain71`'s.
      //
      // Reading `votes[0].vote_percent` without checking whose vote it is therefore
      // reported "this reader already had a vote" for a stranger's vote, making
      // `isNewVote` false and the optimistic `voteDelta` 0 — so casting a first vote
      // left the count visibly unchanged until the 16s/30s invalidation corrected
      // it. The vote itself always broadcast fine; only the count was wrong, and
      // only briefly. The other two consumers of this exact query already guard the
      // same way (`votes-component.tsx`'s `userVote`, and the validator below).
      const prevVotes = (prevVoteData as { votes?: { voter: string; vote_percent: number }[] } | undefined)?.votes;
      const prevVote = Array.isArray(prevVotes) ? prevVotes[0] : undefined;
      const hadPreviousVote = !!prevVote && prevVote.voter === voter && prevVote.vote_percent !== 0;
      const isNewVote = weight !== 0 && !hadPreviousVote;
      const isRemovingVote = weight === 0 && hadPreviousVote;
      const voteDelta = isNewVote ? 1 : isRemovingVote ? -1 : 0;

      // Optimistically bump total_votes on every cached surface showing this post
      adjustCachedTotalVotes(queryClient, author, permlink, voteDelta);

      // Return context for rollback. `voteDelta` — not a set of cache
      // snapshots — IS the rollback instruction: onError re-walks with its
      // negation, which is exact under concurrent writes and, unlike a
      // snapshot restore, cannot destroy feed pages the reader has since
      // scrolled into. See adjustCachedTotalVotes.
      return { prevVoteData, queryKey, author, permlink, voteDelta };
    },

    mutationFn: async (params: { voter: string; author: string; permlink: string; weight: number }) => {
      const { voter, author, permlink, weight } = params;
      // Keyless lite account: record a Lumen-local vote (not on-chain — a vote is
      // attributed to the signer, so it can't be proxied per-user).
      if (user.account_tier === 'lite') {
        const result = await liteVote(author, permlink, weight);
        if (result.status !== 'ok') throw new Error(result.message);
        return { voter, author, permlink, weight, broadcastResult: undefined as unknown as TransactionBroadcastResult };
      }
      // Use observe: false - don't wait for blockchain confirmation
      // A successful broadcast guarantees inclusion in the blockchain
      const broadcastResult: TransactionBroadcastResult = await transactionService.upVote(
        author,
        permlink,
        weight,
        { observe: false }
      );

      logger.info('Vote broadcast successful: %o', { voter, author, permlink, weight, broadcastResult });
      return { voter, author, permlink, weight, broadcastResult };
    },

    onSuccess: async (data) => {
      // A tick in the hand the instant the vote lands. Fired on SUCCESS, never on click:
      // buzzing "done" for a broadcast that then fails is worse than no haptic at all.
      haptic('vote');
      const { voter, author, permlink, weight } = data;
      const isLiteVote = user.account_tier === 'lite';
      // Chain upvotes, for the act ledger. POSITIVE direction only: an undo-shaped call
      // is not an act, and a downvote is engagement in the literal sense and the
      // opposite of it in every sense that matters. A lite vote is recorded by
      // lite-write, so the tier guard keeps the two paths complementary.
      //
      // Note this feeds the toasts and the recap, NOT the daily goal — GOAL_KINDS in
      // retention-moments.ts counts posts and replies only, because a Hive vote never
      // reaches this server and a goal only one tier can fill is not a goal.
      if (!isLiteVote && weight > 0) recordRetentionAct('vote');
      // ★ SAY WHERE THE VOTE WENT (2026-08-09). This read "You have
      // successfully upvoted." for everyone — including a lite account, whose
      // vote is Lumen-local and never reaches Hive (see the comment below for
      // why it cannot). So the one class of user who most needs to know their
      // vote carries no curation reward and does not exist on chain was told
      // the same thing as a Hive voter whose vote does.
      //
      // The app already sets this standard for itself elsewhere: publishing a
      // lite post says "It's on your Lumen profile now, and queued to publish
      // to Hive." A vote should be equally plain about its own reach.
      const action = weight > 0 ? 'upvoted' : weight < 0 ? 'downvoted' : null;
      toast({
        title: isLiteVote ? (action ? 'Vote counted on Lumen' : 'Vote removed') : 'Vote successful',
        description: isLiteVote
          ? action
            ? `You ${action} this on Lumen. Votes from a keyless account stay on Lumen — they don't reach Hive, so there's no curation reward.`
            : 'Your vote has been removed.'
          : action
            ? `You have successfully ${action}.`
            : 'Your vote has been removed.',
        variant: 'success'
      });

      // A lite account's vote is Lumen-LOCAL: it is never on chain (a Hive vote is
      // attributed to the signing account, so N lite users would collapse into one).
      // Every refetch below therefore asks Hivemind about a vote that does not exist
      // there and reverts the optimistic update ~20s later — the vote visibly
      // disappears with no error, which reads as a bug. Keep the optimistic state and
      // refresh only the manabar-free local data instead.
      if (isLiteVote) {
        return;
      }

      // Vote data has optimistic update - use validated refetch to avoid
      // overwriting optimistic data with stale API responses from Hivemind
      //
      // ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). This called
      // `getListVotesByCommentVoter` directly (`getChain()`, `wax.common.wasm`)
      // to confirm the broadcast landed — fires after every vote a signed-in
      // reader casts. See `apps/blog/app/api/comment-vote/route.ts`.
      cleanupRef.current = scheduleValidatedRefetch(
        queryClient,
        ['votes', author, permlink, voter],
        () => fetchListVotesByCommentVoter(author, permlink, voter),
        (freshData) => {
          const vote = freshData.votes?.[0];
          if (weight === 0) {
            return !vote || vote.voter !== voter || vote.vote_percent === 0;
          }
          return !!vote && vote.voter === voter && vote.vote_percent === weight;
        }
      );

      // Manabars don't have optimistic data from this mutation
      scheduleInvalidations(queryClient, [['manabars', voter]]);

      // ★ ['entriesInfinite'] invalidation removed (2026-08-13). Confirmed
      // dead: `entriesInfinite`'s only definition (`list-of-posts.tsx`,
      // `SortedPagesPosts`) has zero importers anywhere under `app/`,
      // `features/`, `components/`, `lib/` — no `pages/` router directory
      // exists to render it. Invalidating a key nothing subscribes to is a
      // no-op. The nine OTHER hooks that still invalidate this key
      // (`use-blacklist-mutations.ts`, `use-follow-*-mutation.ts`,
      // `use-mute-mutations.ts`, `use-post-mutation.ts`,
      // `use-sign-in/out.tsx`) are untouched — that cleanup is not this
      // hook's to make.
      //
      // ★ DO NOT add the six live feed keys here instead
      // (`discoveryFeedEntries`, `topicFeed`, `forYouRanked`, etc.).
      // `invalidateQueries` refetches regardless of `staleTime`, and those
      // queries are deliberately `staleTime: Infinity` with every automatic
      // trigger off (`feed-tabs.tsx`, `topic-shell.tsx`) — a refetch
      // replaces `data.pages` wholesale and re-runs recsys ranking under the
      // reader. `adjustCachedTotalVotes` above is the whole client-side
      // fix for these surfaces; there is no invalidation half for them.

      // Discussion and post data need longer delays since Hivemind takes
      // longer to reflect vote changes in aggregated data
      scheduleInvalidations(
        queryClient,
        [['postData', author, permlink], ['discussionData']],
        [16000, 30000]
      );
    },

    onError: (error: unknown, variables, context) => {
      // Rollback to previous data on error.
      // When prevVoteData is undefined (first vote attempt), set explicit empty
      // structure so the query data is cleared instead of left as optimistic.
      if (context?.queryKey) {
        queryClient.setQueryData(
          context.queryKey,
          context.prevVoteData ?? { votes: [] }
        );
      }
      // Rollback the total_votes bump by re-walking with the negated delta —
      // NOT by restoring cache snapshots. A snapshot restore of an infinite
      // query throws away every page the reader loaded while the vote was in
      // flight, permanently for the session. See adjustCachedTotalVotes.
      if (context?.voteDelta) {
        adjustCachedTotalVotes(queryClient, context.author, context.permlink, -context.voteDelta);
      }

      handleError(error, {
        method: 'useVoteMutation',
        params: variables
      });
    }
  });
  return voteMutation;
}
