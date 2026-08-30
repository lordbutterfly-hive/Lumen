import { useRef } from 'react';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import { appendAttributionFooter } from '@transaction/lib/attribution';
// ★ THE THREAD IS READ THROUGH OUR OWN SERVER, NEVER STRAIGHT FROM A HIVE NODE.
// A post owner's block removes a commenter's replies for EVERY reader (effect B),
// and only the server can apply that. These post-mutation refetches write straight
// into the ['discussionData', ...] cache the thread renders from, so a bridge call
// here would put every blocked comment back the moment somebody replied.
import { fetchDiscussion } from '@/blog/lib/lite/client/discussion-fetch';
import { Preferences, Entry } from '@hive/common-hiveio-packages/wax';
import { toast } from '@ui/components/hooks/use-toast';
import { getLogger } from '@ui/lib/logging';
import { handleError } from '@ui/lib/handle-error';
import { scheduleInvalidations, scheduleValidatedRefetch } from '@/blog/lib/react-query';
import { setStorageItem, removeStorageItem, StorageTTL } from '@ui/lib/storage-with-ttl';
import { litePostIdOf } from '@/blog/lib/lite/render/lite-post-id';
import { deleteLitePost, editLitePost } from '@/blog/lib/lite/client/lite-write';
import { recordRetentionAct } from '@/blog/features/retention/components/retention-moments';

const logger = getLogger('app');

/**
 * Makes comment transaction.
 * Uses optimistic UI - comment appears immediately with full interactivity.
 *
 * @export
 * @return {*}
 */
export function useCommentMutation() {
  const queryClient = useQueryClient();
  const { user } = useUserClient();
  const cleanupRef = useRef<(() => void) | null>(null);

  const commentMutation = useMutation({
    // Optimistic update BEFORE broadcast
    onMutate: async (params: {
      parentAuthor: string;
      parentPermlink: string;
      body: string;
      reputation: number;
      preferences: Preferences;
      discussionAuthor: string;
      discussionPermlink: string;
      observer: string;
    }) => {
      const { parentAuthor, parentPermlink, body, discussionAuthor, discussionPermlink, observer } = params;
      const queryKey = ['discussionData', discussionAuthor, discussionPermlink, observer];

      // Cancel previous validated refetch schedule
      cleanupRef.current?.();
      cleanupRef.current = null;

      // Cancel any outgoing refetches to avoid overwriting optimistic update
      await queryClient.cancelQueries({ queryKey });

      // Snapshot previous data for rollback
      const prevData: Record<string, Entry> | undefined = queryClient.getQueryData(queryKey);

      // Generate temporary permlink for optimistic comment
      const tempPermlink = `re-${parentAuthor}-${Date.now()}`;

      // Find parent post for context (could be in discussionData or could be the main post)
      const parentPost = prevData
        ? Object.values(prevData).find(
            (post) => post.author === parentAuthor && post.permlink === parentPermlink
          )
        : undefined;

      // For replies to the main post, parent won't be in discussionData
      // Use discussionAuthor/discussionPermlink to infer if we're replying to the main post
      const isReplyToMainPost = parentAuthor === discussionAuthor && parentPermlink === discussionPermlink;
      const parentDepth = parentPost?.depth ?? (isReplyToMainPost ? 0 : 0);

      // Create optimistic comment with _optimistic flag (allows full interactivity)
      const newComment = {
        active_votes: [],
        author: user.username,
        author_payout_value: '0.000 HBD',
        author_reputation: params.reputation,
        beneficiaries: [],
        blacklists: [],
        body: body,
        parent_author: parentAuthor,
        parent_permlink: parentPermlink,
        category: parentPost?.category ?? '',
        children: 0,
        created: new Date().toISOString(),
        curator_payout_value: '0.000 HBD',
        depth: parentDepth + 1,
        is_paidout: false,
        json_metadata: {
          images: [],
          author: user.username,
          image: ''
        },
        max_accepted_payout: '1000000.000 HBD',
        net_rshares: 0,
        payout: 0,
        payout_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        pending_payout_value: '0.000 HBD',
        percent_hbd: 10000,
        permlink: tempPermlink,
        post_id: Date.now(), // Use timestamp for unique ID
        promoted: '',
        replies: [],
        stats: { hide: false, gray: false, total_votes: 0, flag_weight: 0 },
        title: `Re: ${parentPost?.title ?? 'No title'}`,
        updated: new Date().toISOString(),
        url: `/${parentPost?.category ?? ''}/@${user.username}/${tempPermlink}`,
        _optimistic: true
      };

      // Build updated data - start with previous data or empty object
      const updatedData: Record<string, Entry> = {};

      if (prevData) {
        // Copy existing data, updating parent's children count if found
        for (const [key, post] of Object.entries(prevData)) {
          if (post.permlink === parentPermlink && post.author === parentAuthor) {
            updatedData[key] = {
              ...post,
              children: (post.children || 0) + 1,
              replies: [...(post.replies || []), tempPermlink]
            };
          } else {
            updatedData[key] = post;
          }
        }
      }

      // Add the new comment
      updatedData[tempPermlink] = newComment as Entry;

      // Update cache immediately - this triggers React Query subscribers to re-render
      queryClient.setQueryData<Record<string, Entry>>(queryKey, updatedData);

      logger.info('Optimistic comment added: %o', { tempPermlink, queryKey, hasPrevData: !!prevData });

      // Save shadow draft — insurance against tab crash before Hivemind indexes
      const shadowKey = `shadow-reply-${user.username}-${parentAuthor}-${parentPermlink}`;
      setStorageItem(shadowKey, { body, parentAuthor, parentPermlink }, StorageTTL.SHADOW_DRAFT);

      // Return context for rollback
      return { prevData, queryKey, shadowKey };
    },

    mutationFn: async (params: {
      parentAuthor: string;
      parentPermlink: string;
      body: string;
      preferences: Preferences;
      discussionAuthor: string;
      discussionPermlink: string;
      observer: string;
    }) => {
      const { parentAuthor, parentPermlink, body, preferences, discussionPermlink } = params;

      // ★ MANDATORY on-chain attribution for every full-Hive-account comment
      // (owner instruction, 2026-08-28). This mutation is only ever reached
      // for a non-lite author — reply-textbox.tsx forks a lite reply to
      // `createLitePost` before calling `commentMutation.mutateAsync` at all,
      // so there is no tier check to make here.
      const attributedBody = appendAttributionFooter(body);

      // Broadcast without waiting for blockchain confirmation
      // A successful broadcast guarantees inclusion in the blockchain
      const broadcastResult = await transactionService.comment(
        parentAuthor,
        parentPermlink,
        attributedBody,
        preferences,
        { observe: false }
      );

      logger.info('Comment broadcast successful: %o', { discussionPermlink, broadcastResult });
      return { ...params, broadcastResult };
    },

    onSuccess: (data) => {
      const { parentPermlink, discussionAuthor, discussionPermlink, observer } = data;
      const username = user.username;

      logger.info('useCommentMutation onSuccess data: %o', data);
      toast({
        title: 'Comment posted successfully',
        description: 'Your comment has been posted successfully.',
        variant: 'success'
      });
      // Chain replies, for the streak and the daily goal. Lite replies are recorded by
      // lite-write; the tier guard keeps the two paths from double-counting. This is
      // the CREATE mutation — the update mutation below deliberately records nothing,
      // because an edit is not a new act.
      if (user?.account_tier !== 'lite') recordRetentionAct('reply');

      // Discussion data has optimistic comment - use validated refetch to avoid
      // overwriting optimistic data with stale API responses from Hivemind
      const queryKey = ['discussionData', discussionAuthor, discussionPermlink, observer];
      const prevData: Record<string, Entry> | undefined = queryClient.getQueryData(queryKey);
      const prevRealCommentCount = prevData
        ? Object.values(prevData).filter(
            (e) => e.author === username && e.parent_permlink === parentPermlink && !e._optimistic
          ).length
        : 0;

      cleanupRef.current = scheduleValidatedRefetch(
        queryClient,
        queryKey,
        () => fetchDiscussion(discussionAuthor, discussionPermlink, observer),
        (freshData) => {
          if (!freshData) return false;
          const realComments = Object.values(freshData).filter(
            (e) => e.author === username && e.parent_permlink === parentPermlink
          );
          return realComments.length > prevRealCommentCount;
        },
        undefined,
        {
          onValidated: () => {
            removeStorageItem(`shadow-reply-${username}-${data.parentAuthor}-${parentPermlink}`);
          }
        }
      );
    },

    onError: (error: unknown, variables, context) => {
      // Rollback to previous data and remove shadow draft on error
      if (context?.queryKey) {
        if (context.prevData) {
          queryClient.setQueryData(context.queryKey, context.prevData);
        } else {
          queryClient.removeQueries({ queryKey: context.queryKey });
        }
      }
      if (context?.shadowKey) {
        removeStorageItem(context.shadowKey);
      }

      handleError(error, {
        method: 'useCommentMutation',
        params: variables
      });
    }
  });

  return commentMutation;
}

/**
 * Makes update comment transaction.
 *
 * @export
 * @return {*}
 */
export function useUpdateCommentMutation() {
  const queryClient = useQueryClient();
  const { user } = useUserClient();
  const cleanupRef = useRef<(() => void) | null>(null);

  const updateCommentMutation = useMutation({
    // Optimistic update BEFORE broadcast - prevents stale refetches from overwriting
    onMutate: async (params: {
      parentAuthor: string;
      parentPermlink: string;
      permlink: string;
      body: string;
      discussionAuthor: string;
      discussionPermlink: string;
      observer: string;
    }) => {
      const { permlink, body, discussionAuthor, discussionPermlink, observer } = params;
      const queryKey = ['discussionData', discussionAuthor, discussionPermlink, observer];

      // Cancel previous validated refetch schedule
      cleanupRef.current?.();
      cleanupRef.current = null;

      // Cancel any outgoing refetches to avoid overwriting optimistic update
      await queryClient.cancelQueries({ queryKey });

      // Snapshot previous data for rollback
      const prevData: Record<string, Entry> | undefined = queryClient.getQueryData(queryKey);

      // Optimistically update the comment body
      if (prevData) {
        const newData: Record<string, Entry> = Object.fromEntries(
          Object.entries(prevData).map(([key, post]) => [
            key,
            post.permlink === permlink ? { ...post, body } : post
          ])
        );
        queryClient.setQueryData<Record<string, Entry>>(queryKey, newData);
      }

      return { prevData, queryKey };
    },

    mutationFn: async (params: {
      parentAuthor: string;
      parentPermlink: string;
      permlink: string;
      body: string;
      discussionAuthor: string;
      discussionPermlink: string;
      observer: string;
    }) => {
      const { parentAuthor, parentPermlink, permlink, body, discussionPermlink } = params;

      // LITE fork: a keyless lite account has no Hive key — its session deliberately
      // carries a poison-pill signer — so the wax path below cannot work for it. The
      // proxy account re-broadcasts the edit instead, through our own API. The Lumen
      // post id is recoverable from the permlink (lib/lite/render/lite-post-id.ts).
      // Returns the same shape as the wax path so onSuccess/onError stay untouched.
      const liteEditId = litePostIdOf({ permlink });
      if (liteEditId) {
        const result = await editLitePost(liteEditId, { body, tier: 'normal' });
        if (result.status !== 'ok') throw new Error(result.message);
        logger.info('Done lite comment edit: %o', { permlink, liteEditId });
        return { ...params, broadcastResult: undefined };
      }

      // ★ MANDATORY on-chain attribution for every full-Hive-account comment
      // edit (owner instruction, 2026-08-28). Reached only past the lite fork
      // above, so this is always a real Hive-keyed author.
      //
      // Strips any existing footer first: `body` here is whatever the editor
      // round-tripped from `comment.body` (reply-textbox.tsx's `commentBody`),
      // which for an already-published comment already carries the footer
      // this same call appended on the PREVIOUS save. Without the strip,
      // editing a comment twice would stack two attributions.
      const attributedBody = appendAttributionFooter(body);

      const broadcastResult = await transactionService.updateComment(
        parentAuthor,
        parentPermlink,
        permlink,
        attributedBody,
        {
          observe: false
        }
      );

      logger.info('Done update comment transaction: %o', { discussionPermlink, broadcastResult });
      // ★ `body` OVERRIDDEN, NOT THE ORIGINAL `params.body`. `onSuccess` below
      // destructures `body` from this return value and uses it to validate the
      // post-edit refetch (`comment.body === body`) — that has to be checked
      // against what was ACTUALLY broadcast, or the comparison can never be
      // true and the validated refetch runs out its retries every single time,
      // leaving the optimistic (footer-less) text in the cache indefinitely.
      return { ...params, body: attributedBody, broadcastResult };
    },

    onSuccess: (data) => {
      const { username } = user;
      const { permlink, body, discussionAuthor, discussionPermlink, observer } = data;
      logger.info('useUpdateCommentMutation onSuccess data: %o', data);
      toast({
        title: 'Comment updated successfully',
        description: 'Your comment has been updated successfully.',
        variant: 'success'
      });

      // Discussion data has optimistic edit - use validated refetch to avoid
      // overwriting optimistic data with stale API responses from Hivemind
      cleanupRef.current = scheduleValidatedRefetch(
        queryClient,
        ['discussionData', discussionAuthor, discussionPermlink, observer],
        () => fetchDiscussion(discussionAuthor, discussionPermlink, observer),
        (freshData) => {
          if (!freshData) return false;
          const comment = Object.values(freshData).find(
            (e) => e.permlink === permlink && e.author === username
          );
          return !!comment && comment.body === body;
        }
      );

      // postData doesn't have optimistic data from this mutation
      scheduleInvalidations(queryClient, [['postData', username, permlink, observer]]);
    },

    onError: (error: unknown, variables, context) => {
      // Rollback to previous data on error
      if (context?.queryKey) {
        if (context.prevData) {
          queryClient.setQueryData(context.queryKey, context.prevData);
        }
      }

      handleError(error, {
        method: 'useUpdateCommentMutation',
        params: variables
      });
    }
  });

  return updateCommentMutation;
}

/**
 * Makes delete comment transaction.
 *
 * @export
 * @return {*}
 */
export function useDeleteCommentMutation() {
  const queryClient = useQueryClient();
  const cleanupRef = useRef<(() => void) | null>(null);

  const deleteCommentMutation = useMutation({
    // Optimistic update BEFORE broadcast - prevents stale refetches from overwriting
    onMutate: async (params: {
      permlink: string;
      discussionAuthor: string;
      discussionPermlink: string;
      observer: string;
    }) => {
      const { permlink, discussionAuthor, discussionPermlink, observer } = params;
      const queryKey = ['discussionData', discussionAuthor, discussionPermlink, observer];

      // Cancel previous validated refetch schedule
      cleanupRef.current?.();
      cleanupRef.current = null;

      // Cancel any outgoing refetches to avoid overwriting optimistic update
      await queryClient.cancelQueries({ queryKey });

      // Snapshot previous data for rollback
      const prevData: Record<string, Entry> | undefined = queryClient.getQueryData(queryKey);

      // Optimistically remove the comment
      if (prevData) {
        const newData: Record<string, Entry> = Object.fromEntries(
          Object.entries(prevData).filter(([_, post]) => post.permlink !== permlink)
        );
        queryClient.setQueryData<Record<string, Entry>>(queryKey, newData);
      }

      return { prevData, queryKey };
    },

    mutationFn: async (params: {
      permlink: string;
      discussionAuthor: string;
      discussionPermlink: string;
      observer: string;
    }) => {
      const { permlink, discussionPermlink } = params;
      // LITE fork — see the edit fork above for why the wax path cannot serve a
      // keyless account. Backend: DELETE /api/lite/posts/:id (hides it immediately,
      // then removes it on chain if Hive still allows, else blanks it).
      const litePostId = litePostIdOf({ permlink });
      if (litePostId) {
        const result = await deleteLitePost(litePostId);
        if (result.status !== 'ok') throw new Error(result.message);
        logger.info('Done lite comment delete: %o', { permlink, litePostId });
        return { ...params, broadcastResult: undefined };
      }

      const broadcastResult = await transactionService.deleteComment(permlink, { observe: false });
      logger.info('Done delete comment transaction: %o', { discussionPermlink, broadcastResult });
      return { ...params, broadcastResult };
    },

    onSuccess: (data) => {
      const { permlink, discussionAuthor, discussionPermlink, observer } = data;
      logger.info('useDeleteCommentMutation onSuccess data: %o', data);
      toast({
        title: 'Comment deleted successfully',
        description: 'Your comment has been deleted successfully.',
        variant: 'success'
      });

      // Discussion data has optimistic deletion - use validated refetch to avoid
      // overwriting optimistic data with stale API responses from Hivemind
      cleanupRef.current = scheduleValidatedRefetch(
        queryClient,
        ['discussionData', discussionAuthor, discussionPermlink, observer],
        () => fetchDiscussion(discussionAuthor, discussionPermlink, observer),
        (freshData) => {
          if (!freshData) return false;
          return !Object.values(freshData).some((e) => e.permlink === permlink);
        },
        [4000, 10000, 20000]
      );
    },

    onError: (error: unknown, variables, context) => {
      // Rollback to previous data on error
      if (context?.queryKey) {
        if (context.prevData) {
          queryClient.setQueryData(context.queryKey, context.prevData);
        }
      }

      handleError(error, {
        method: 'useDeleteCommentMutation',
        params: variables
      });
    }
  });

  return deleteCommentMutation;
}
