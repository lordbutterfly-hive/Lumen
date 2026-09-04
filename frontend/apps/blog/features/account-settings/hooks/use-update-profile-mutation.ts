import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import type { FullAccount } from '@hive/common-hiveio-packages/wax';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';

/**
 * Makes update profile transaction.
 *
 * @export
 * @return {*}
 */
export function useUpdateProfileMutation() {
  const { user } = useUserClient();
  const queryClient = useQueryClient();
  const updateProfileMutation = useMutation({
    mutationFn: async (params: {
      profile_image?: string;
      cover_image?: string;
      name?: string;
      about?: string;
      location?: string;
      website?: string;
      witness_owner?: string;
      witness_description?: string;
      blacklist_description?: string;
      muted_list_description?: string;
      version?: number;
      /**
       * ★ THE ACCOUNT'S CURRENT `posting_json_metadata`, so the broadcast MERGES
       * instead of replacing (2026-08-30). Without it the write destroys every
       * profile key this form does not enumerate — measured at 61% of 108 real
       * accounts: pinned posts, other apps' state, the user's own social links,
       * gone on chain under a success toast. Optional only so an existing caller
       * cannot be silently broken; every caller in this repo passes it.
       */
      existingPostingJsonMetadata?: string;
    }) => {
      const {
        profile_image,
        cover_image,
        name,
        about,
        location,
        website,
        witness_owner,
        witness_description,
        blacklist_description,
        muted_list_description,
        version,
        existingPostingJsonMetadata
      } = params;
      const broadcastResult = await transactionService.updateProfile(
        profile_image,
        cover_image,
        name,
        about,
        location,
        website,
        witness_owner,
        witness_description,
        blacklist_description,
        muted_list_description,
        version,
        { observe: true },
        existingPostingJsonMetadata
      );
      const prevProfileData: FullAccount | undefined = queryClient.getQueryData([
        'profileData',
        user.username
      ]);

      const response = { ...params, broadcastResult, prevProfileData };
      return response;
    },
    onSettled: (data) => {
      if (!data) return;
      const {
        prevProfileData,
        profile_image,
        cover_image,
        name,
        about,
        location,
        website,
        blacklist_description,
        muted_list_description,
        version
      } = data;
      if (!!prevProfileData) {
        queryClient.setQueryData(['profileData', user.username], {
          ...prevProfileData,
          profile: {
            ...prevProfileData.profile,
            profile_image,
            name,
            about,
            location,
            website,
            blacklist_description,
            muted_list_description,
            cover_image,
            version
          },
          _temporary: true
        });
      }
    },
    onSuccess: () => {
      toast({
        title: 'Profile updated successfully',
        description: 'Your profile has been updated.',
        variant: 'success'
      });
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['profileData', user.username] });
      }, 4000);
    },
    onError: (error: any, variables) => {
      handleError(error, {
        method: 'useUpdateProfileMutation',
        params: variables
      });
    }
  });

  return updateProfileMutation;
}
