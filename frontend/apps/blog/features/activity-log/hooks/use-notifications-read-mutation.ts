import { useMutation, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';

/**
 * Makes mark all notifications as read transaction.
 *
 * @export
 * @return {*}
 */
export function useMarkAllNotificationsAsReadMutation() {
  const queryClient = useQueryClient();
  const { user } = useUserClient();
  const markAllNotificationsAsReadMutation = useMutation({
    mutationFn: async (params: { date: string }) => {
      const { date } = params;
      const broadcastResult = await transactionService.markAllNotificationAsRead(date, { observe: true });
      const response = { ...params, broadcastResult };
      return response;
    },
    onSettled: (data) => {
      // ★ THE FIELD IS `lastread`, NOT `lastRead` (2026-08-10). This optimistic
      // write invented a key nothing reads: `bridge.unread_notifications`
      // returns `{ unread, lastread }`, and both consumers — the header bell
      // (app-header.tsx) and the notifications panel — read `data.lastread`.
      // Writing `lastRead` left the cached entry with NO lastread at all, so
      // every consumer fell back to `new Date()` between the broadcast and the
      // refetch 6s later. Harmless-looking, and exactly the sort of thing that
      // makes "mark all as read" appear to work while the read cursor is
      // guessed rather than known.
      queryClient.setQueryData(['unreadNotifications', user.username], {
        lastread: data?.date || new Date().toISOString(),
        unread: 0
      });
    },
    onSuccess: () => {
      const { username } = user;
      toast({
        title: 'Notifications marked as read',
        description: 'All notifications have been marked as read successfully.',
        variant: 'success'
      });
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['unreadNotifications', username] });
      }, 6000);
    },
    onError: (error: any, variables) => {
      handleError(error, {
        method: 'useMarkAllNotificationsAsReadMutation',
        params: variables
      });
    }
  });

  return markAllNotificationsAsReadMutation;
}
