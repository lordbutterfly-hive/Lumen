import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TransactionBroadcastResult, transactionService } from '@transaction/index';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { liteReblog } from '@/blog/lib/lite/client/lite-write';

/**
 * Makes reblog transaction.
 *
 * @export
 * @return {*}
 */
export function useReblogMutation() {
  const queryClient = useQueryClient();
  const { user } = useUserClient();
  const reblogMutation = useMutation({
    mutationFn: async (params: { author: string; permlink: string; username: string }) => {
      const { author, permlink, username } = params;

      // Keyless lite account: Lumen-local reblog (not proxied on-chain).
      if (user.account_tier === 'lite') {
        const result = await liteReblog(author, permlink);
        if (result.status !== 'ok') throw new Error(result.message);
        return { author, permlink, username, broadcastResult: undefined as unknown as TransactionBroadcastResult };
      }

      const broadcastResult: TransactionBroadcastResult = await transactionService.reblog(author, permlink, {
        observe: true
      });
      const response = { author, permlink, username, broadcastResult };
      return response;
    },
    onSettled: (data) => {
      if (!data) return;
      const { author, permlink, username } = data;
      queryClient.setQueriesData({ queryKey: ['PostRebloggedBy', author, permlink, username] }, true);
    },

    onSuccess: (data) => {
      const { author, permlink, username } = data;
      toast({
        title: 'Reblog successful',
        description: `You have successfully reblogged the post.`,
        variant: 'success'
      });
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['PostRebloggedBy', author, permlink, username] });
      }, 4000);
    },
    onError: (error: any, variables) => {
      handleError(error, {
        method: 'useReblogMutation',
        params: variables
      });
    }
  });

  return reblogMutation;
}
