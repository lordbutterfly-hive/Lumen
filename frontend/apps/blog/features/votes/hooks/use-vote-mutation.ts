import { useRef } from 'react';
import { useMutation, QueryClient, useQueryClient } from '@tanstack/react-query';
import { TransactionBroadcastResult, transactionService } from '@transaction/index';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { getListVotesByCommentVoter } from '@transaction/lib/hive-api';
import { getLogger } from '@ui/lib/logging';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { scheduleInvalidations, scheduleValidatedRefetch } from '@/blog/lib/react-query';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { liteVote } from '@/blog/lib/lite/client/lite-write';
import { recordRetentionAct } from '@/blog/features/retention/components/retention-moments';

const logger = getLogger('app');

type CacheSnapshot = { queryKey: readonly unknown[]; data: unknown };

/**
 * Optimistically update total_votes in postData, discussionData, and entriesInfinite caches.
 * Returns snapshots for rollback.
 */
function optimisticUpdateTotalVotes(
  queryClient: QueryClient,
  author: string,
  permlink: string,
  delta: number
): CacheSnapshot[] {
  if (delta === 0) return [];

  const snapshots: CacheSnapshot[] = [];

  // Update postData queries (single Entry objects)
  const postQueries = queryClient.getQueriesData<Entry>({ queryKey: ['postData', author, permlink] });
  for (const [key, data] of postQueries) {
    if (!data?.stats) continue;
    snapshots.push({ queryKey: key, data: structuredClone(data) });
    queryClient.setQueryData(key, {
      ...data,
      stats: { ...data.stats, total_votes: Math.max(0, data.stats.total_votes + delta) }
    });
  }

  // Update discussionData queries (record of entries keyed by path)
  const discussionQueries = queryClient.getQueriesData<Record<string, Entry>>({ queryKey: ['discussionData'] });
  for (const [key, data] of discussionQueries) {
    if (!data) continue;
    const entryKey = Object.keys(data).find((k) => {
      const entry = data[k];
      return entry?.author === author && entry?.permlink === permlink;
    });
    if (!entryKey || !data[entryKey]?.stats) continue;
    snapshots.push({ queryKey: key, data: structuredClone(data) });
    const entry = data[entryKey];
    queryClient.setQueryData(key, {
      ...data,
      [entryKey]: {
        ...entry,
        stats: { ...entry.stats, total_votes: Math.max(0, (entry.stats?.total_votes ?? 0) + delta) }
      }
    });
  }

  // Update entriesInfinite queries (paginated arrays of Entry objects)
  const infiniteQueries = queryClient.getQueriesData<{ pages: Entry[][]; pageParams: unknown[] }>({
    queryKey: ['entriesInfinite']
  });
  for (const [key, data] of infiniteQueries) {
    if (!data?.pages) continue;
    let found = false;
    const updatedPages = data.pages.map((page) =>
      page.map((entry) => {
        if (entry.author === author && entry.permlink === permlink && entry.stats) {
          found = true;
          return {
            ...entry,
            stats: { ...entry.stats, total_votes: Math.max(0, (entry.stats.total_votes ?? 0) + delta) }
          };
        }
        return entry;
      })
    );
    if (!found) continue;
    snapshots.push({ queryKey: key, data: structuredClone(data) });
    queryClient.setQueryData(key, { ...data, pages: updatedPages });
  }

  return snapshots;
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
      const hadPreviousVote = prevVoteData
        && Array.isArray((prevVoteData as { votes: unknown[] }).votes)
        && (prevVoteData as { votes: { vote_percent: number }[] }).votes.length > 0
        && (prevVoteData as { votes: { vote_percent: number }[] }).votes[0].vote_percent !== 0;
      const isNewVote = weight !== 0 && !hadPreviousVote;
      const isRemovingVote = weight === 0 && hadPreviousVote;
      const voteDelta = isNewVote ? 1 : isRemovingVote ? -1 : 0;

      // Optimistically update total_votes in postData and discussionData caches
      const prevCacheSnapshots = optimisticUpdateTotalVotes(queryClient, author, permlink, voteDelta);

      // Return context for rollback
      return { prevVoteData, queryKey, prevCacheSnapshots };
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
      cleanupRef.current = scheduleValidatedRefetch(
        queryClient,
        ['votes', author, permlink, voter],
        () => getListVotesByCommentVoter([author, permlink, voter], 1),
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

      // entriesInfinite has optimistic total_votes — delayed invalidation for full data refresh
      scheduleInvalidations(queryClient, [['entriesInfinite']], [16000, 30000]);

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
      // Rollback total_votes optimistic updates
      if (context?.prevCacheSnapshots) {
        for (const { queryKey: key, data } of context.prevCacheSnapshots) {
          queryClient.setQueryData(key, data);
        }
      }

      handleError(error, {
        method: 'useVoteMutation',
        params: variables
      });
    }
  });
  return voteMutation;
}
