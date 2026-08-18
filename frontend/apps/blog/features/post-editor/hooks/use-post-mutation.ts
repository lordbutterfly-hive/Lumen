import { NaiAsset } from '@hiveio/wax';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import { litePostIdOf } from '@/blog/lib/lite/render/lite-post-id';
import { deleteLitePost } from '@/blog/lib/lite/client/lite-write';
import { Beneficiarie } from '@hive/common-hiveio-packages/wax';
import { toast } from '@ui/components/hooks/use-toast';
import { getLogger } from '@ui/lib/logging';
import { handleError } from '@ui/lib/handle-error';
import { formatNaiAsset } from '@ui/lib/helpers';
import { scheduleInvalidations, scheduleValidatedRefetch } from '@/blog/lib/react-query';
import { fetchPost } from '@/blog/lib/chain-fetch';
import { setStorageItem, removeStorageItem, StorageTTL } from '@ui/lib/storage-with-ttl';
import { recordRetentionAct } from '@/blog/features/retention/components/retention-moments';

const logger = getLogger('app');

/**
 * Makes post transaction.
 * Uses optimistic UI - post page is available immediately after broadcast.
 *
 * @export
 * @return {*}
 */
export function usePostMutation() {
  const queryClient = useQueryClient();
  const { user } = useUserClient();

  const postMutation = useMutation({
    // Seed cache with optimistic post data before broadcast
    onMutate: async (params: {
      permlink: string;
      title: string;
      body: string;
      reputation: number;
      tags: string[];
      category: string;
      summary: string;
      altAuthor: string;
      /** One URL, or several — the short-form composer can attach up to four. */
      image?: string | string[];
      /**
       * Extra top-level `json_metadata` keys. The short-form composer sends
       * `{ type: 'note' }`; the long-form editor sends nothing and is unchanged.
       */
      extraJsonMetadata?: Record<string, unknown>;
      editMode: boolean;
      beneficiaries: Beneficiarie[];
      maxAcceptedPayout: NaiAsset;
      percentHbd: number;
      rewardOptionsChanged?: boolean;
    }) => {
      const {
        permlink,
        title,
        body,
        tags,
        category,
        summary,
        reputation,
        image,
        extraJsonMetadata,
        editMode,
        beneficiaries,
        maxAcceptedPayout,
        percentHbd
      } = params;
      const username = user.username;

      // For new posts, seed the post data cache so the post page renders immediately
      if (!editMode) {
        // Convert NaiAsset to string format using wax helper (e.g., "1000000.000 HBD")
        const maxPayoutString = maxAcceptedPayout
          ? formatNaiAsset(maxAcceptedPayout)
          : '1000000.000 HBD';

        const optimisticPost = {
          author: username,
          permlink,
          title,
          body,
          category,
          tags,
          json_metadata: {
            tags,
            // Same shape the chain will end up with — see `normalizeImages` in
            // packages/transaction/index.ts. An optimistic card that carried
            // `[""]` while the real post carried nothing (or vice versa) is a
            // card that flickers a broken thumbnail the moment Hivemind answers.
            image: (Array.isArray(image) ? image : [image]).filter(
              (url): url is string => typeof url === 'string' && url.trim() !== ''
            ),
            description: summary,
            // Must match what transactionService.post actually broadcasts,
            // or the optimistic card and the real post disagree.
            app: 'lumen/1.0',
            ...(extraJsonMetadata ?? {})
          },
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          active_votes: [],
          children: 0,
          author_reputation: reputation,
          pending_payout_value: '0.000 HBD',
          curator_payout_value: '0.000 HBD',
          author_payout_value: '0.000 HBD',
          payout: 0,
          payout_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          is_paidout: false,
          net_rshares: 0,
          url: `/${category}/@${username}/${permlink}`,
          // Use actual user-selected values for payout settings
          max_accepted_payout: maxPayoutString,
          beneficiaries: beneficiaries ?? [],
          percent_hbd: percentHbd ?? 10000,
          // Default values for other required fields
          blacklists: [],
          depth: 0,
          promoted: '0.000 HBD',
          replies: [],
          stats: {
            total_votes: 0,
            hide: false,
            gray: false,
            flag_weight: 0
          },
          _optimistic: true
        };

        // Seed the post data cache
        // Observer is username when logged in (required to post)
        queryClient.setQueryData(['postData', username, permlink, username], optimisticPost);

        // Save shadow draft — insurance against tab crash before Hivemind indexes
        setStorageItem(
          `shadow-post-${username}-${permlink}`,
          { title, body, tags, category, summary },
          StorageTTL.SHADOW_DRAFT
        );
      }

      return { username, permlink, editMode };
    },

    mutationFn: async (params: {
      permlink: string;
      title: string;
      body: string;
      tags: string[];
      category: string;
      summary: string;
      altAuthor: string;
      image?: string | string[];
      extraJsonMetadata?: Record<string, unknown>;
      editMode: boolean;
      beneficiaries: Beneficiarie[];
      maxAcceptedPayout: NaiAsset;
      percentHbd: number;
      rewardOptionsChanged?: boolean;
    }) => {
      const {
        permlink,
        title,
        body,
        beneficiaries,
        maxAcceptedPayout,
        tags,
        category,
        summary,
        altAuthor,
        percentHbd,
        image,
        extraJsonMetadata,
        editMode
      } = params;

      // Use observe: true - wait for block inclusion (~1.5s avg) before resolving.
      // This ensures the draft is not deleted until the transaction is confirmed on-chain.
      if (!editMode && !!maxAcceptedPayout) {
        const broadcastResult = await transactionService.post(
          permlink,
          title,
          body,
          beneficiaries,
          maxAcceptedPayout,
          tags,
          category,
          summary,
          altAuthor,
          percentHbd,
          image,
          extraJsonMetadata,
          { observe: true }
        );
        logger.info('Post broadcast successful: %o', { permlink, broadcastResult });
        return { ...params, broadcastResult };
      }
      if (editMode) {
        const broadcastResult = await transactionService.updatePost(
          permlink,
          title,
          body,
          tags,
          category,
          summary,
          altAuthor,
          image,
          extraJsonMetadata,
          { observe: true }
        );
        logger.info('Post update broadcast successful: %o', { permlink, broadcastResult });

        // If reward options were changed (made more restrictive), broadcast comment_options
        if (maxAcceptedPayout && params.rewardOptionsChanged) {
          const optionsResult = await transactionService.updatePostOptions(
            permlink,
            maxAcceptedPayout,
            percentHbd,
            { observe: true }
          );
          logger.info('Post options update broadcast successful: %o', { permlink, optionsResult });
        }

        return { ...params, broadcastResult };
      } else {
        throw new Error('maxAcceptedPayout is required for new posts');
      }
    },

    onSuccess: (data) => {
      const { permlink } = data;
      const { username } = user;
      toast({
        title: 'Post submitted successfully',
        description: 'Your post has been submitted',
        variant: 'success'
      });
      // ★ THE RETENTION LEDGER, FOR CHAIN ACCOUNTS. `recordRetentionAct` used to be
      // called from `lib/lite/client/lite-write.ts` and nowhere else, so the streak
      // toasts and the weekly recap were dark for every Hive user. Guarded on the tier
      // because a lite write already records itself in lite-write — the two paths are
      // exact complements, not overlapping.
      //
      // `!editMode` matters: an edit is not a new act, and counting it would let one
      // post tick a daily goal repeatedly. Same rule lite-write already applies
      // (`if (!input.editOfPostId)`).
      if (user?.account_tier !== 'lite' && !data.editMode) recordRetentionAct('post');
      // ★ H7: THE RANK CARD, THE STREAK AND THE PROFILE'S POST COUNT ALL READ CACHES
      // THIS MUTATION NEVER TOUCHED. Measured live: right after a successful publish, on
      // the SAME profile screen, the header still read "1 post" (the count from before
      // this post), the rank card said "Nothing published yet, so nothing to measure" /
      // "Lumen has not counted a day for you yet", and the daily card had not moved —
      // three React Query caches that had each already been read once this session and
      // were never told a post landed. A hard reload fixed all three, which is exactly
      // what these two invalidations reproduce without one.
      //
      // `['retention', username]` is the ONE key both `ProfileLeagueCard` (via
      // `useProfileRetention`) and `StreakCard` (via `useViewerRetention`) read for a
      // signed-in CHAIN account — see use-retention.ts / use-viewer-retention.ts.
      // `['profileData', username]` is the key `ProfileMain` reads `post_count` from for
      // the header stat line — the SAME key `use-follow-mutations.ts` and
      // `use-mute-mutations.ts` already invalidate after their own writes, followed here
      // rather than a new pattern.
      //
      // Gated on `!data.editMode` only, not the tier check above: this mutation's
      // `mutationFn` only ever broadcasts a CHAIN post (a lite publish goes through
      // `createLitePost` in use-post-form-actions.ts and never reaches this hook, and
      // `useNotePublish`'s short-post path is the only other caller and is chain-only
      // too), so `['lite-retention']` is never the right key here. An edit changes
      // neither the post count nor anything the ladder measures, same reasoning as the
      // `recordRetentionAct` guard just above.
      if (!data.editMode) {
        queryClient.invalidateQueries({ queryKey: ['retention', username] });
        queryClient.invalidateQueries({ queryKey: ['profileData', username] });
      }
      // Use validated refetch for post data to avoid overwriting optimistic cache
      // with stale Hivemind responses (Hivemind may not have indexed the post yet)
      //
      // ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). This called
      // `getPost` directly (`getChain()`, `wax.common.wasm`) to confirm a
      // just-published/edited post indexed — fires after every publish for a
      // signed-in reader. See `apps/blog/app/api/post-status/route.ts`
      // (`fetchPost` is the same route `content.tsx`'s `postData`/
      // `crossPostData` queries use).
      scheduleValidatedRefetch(
        queryClient,
        ['postData', username, permlink, username],
        () => fetchPost(username, permlink, username),
        (freshData) => freshData != null && !freshData._optimistic,
        undefined,
        {
          onValidated: () => {
            removeStorageItem(`shadow-post-${username}-${permlink}`);
          }
        }
      );
      // Invalidate feed caches separately (no optimistic data to protect)
      scheduleInvalidations(queryClient, [['entriesInfinite'], ['accountEntriesInfinite']]);
    },

    onError: (error: unknown, variables, context) => {
      // Remove optimistic post data and shadow draft on error
      if (context && !variables.editMode) {
        queryClient.removeQueries({ queryKey: ['postData', context.username, context.permlink, context.username] });
        removeStorageItem(`shadow-post-${context.username}-${context.permlink}`);
      }
      handleError(error, {
        method: 'usePostMutation',
        params: variables
      });
    }
  });

  return postMutation;
}

/**
 * Makes delete comment transaction.
 *
 * @export
 * @return {*}
 */
export function useDeletePostMutation() {
  const { user } = useUserClient();
  const queryClient = useQueryClient();
  const deletePostMutation = useMutation({
    mutationFn: async (params: { permlink: string }) => {
      const { permlink } = params;

      // LITE fork: a keyless lite account has no Hive key — its session carries a
      // deliberate poison-pill signer — so the wax path below cannot serve it. The
      // proxy account performs the removal via our own API. The Lumen post id is
      // recoverable from the permlink (lib/lite/render/lite-post-id.ts). Same return
      // shape as the wax path so onSuccess/onError stay untouched.
      const litePostId = litePostIdOf({ permlink });
      if (litePostId && user?.account_tier === 'lite') {
        const result = await deleteLitePost(litePostId);
        if (result.status !== 'ok') throw new Error(result.message);
        return { ...params, broadcastResult: undefined };
      }

      const broadcastResult = await transactionService.deleteComment(permlink, { observe: false });
      const response = { ...params, broadcastResult };
      return response;
    },
    onSuccess: (data) => {
      const { permlink } = data;
      const { username } = user;
      toast({
        title: 'Post deleted successfully',
        description: 'Your post has been deleted',
        variant: 'success'
      });
      // Multiple invalidation attempts to handle slow operations
      scheduleInvalidations(queryClient, [
        ['postData', username, permlink, username],
        ['entriesInfinite']
      ]);
    },
    onError: (error: any, variables) => {
      handleError(error, {
        method: 'useDeletePostMutation',
        params: variables
      });
    }
  });

  return deletePostMutation;
}
