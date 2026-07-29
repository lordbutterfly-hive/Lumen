import { useTranslation } from '@/blog/i18n/client';
import ListArea from './list-area';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { FullAccount, IFollowList } from '@hive/common-hiveio-packages/wax';
import {
  useBlacklistBlogMutation,
  useResetBlacklistBlogMutation
} from '@/blog/components/hooks/use-blacklist-mutations';
import {
  useMuteMutation,
  useResetBlogListMutation
} from '@/blog/features/mute-follow/hooks/use-mute-mutations';
import { handleError } from '@ui/lib/handle-error';
import {
  useFollowBlacklistBlogMutation,
  useResetFollowBlacklistBlogMutation
} from '@/blog/components/hooks/use-follow-blacklist-mutation';
import {
  useFollowMutedBlogMutation,
  useResetFollowMutedBlogMutation
} from '@/blog/components/hooks/use-follow-muted-list-mutation';

interface ListVariantProps {
  variant: 'blacklisted' | 'muted' | 'follow_blacklist' | 'follow_muted';
  username: string;
  profileData: FullAccount;
  data: IFollowList[] | undefined;
  splitArrays: IFollowList[][];
  onSearchChange: (e: string) => void;
}

const ListVariant = ({
  variant,
  username,
  profileData,
  data,
  splitArrays,
  onSearchChange
}: ListVariantProps) => {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  // ★ NOT just "is this my page". These four lists (blacklist, muted, and the
  // followed-list variants) are chain-only features: every write goes through
  // `transactionService`, and there is no Lumen-local equivalent — a mute or a
  // blacklist is a Hive custom_json or it is nothing.
  //
  // A keyless lite account viewing its OWN lists satisfied the old check, so every
  // Add / Reset / Un-X control rendered and then threw a raw TypeError out of
  // `getSigner(undefined)` on click. Treating a lite viewer as a non-owner hides
  // the write controls while leaving the lists themselves readable, which is the
  // same shape as the Mute fix in mute-follow/buttons-container.tsx.
  const isLite = user.account_tier === 'lite';
  const userOwner = user.username === username && user.isLoggedIn && !isLite;

  const blacklistBlogMutation = useBlacklistBlogMutation();
  const resetBlacklistBlogMutation = useResetBlacklistBlogMutation();

  const muteMutation = useMuteMutation();
  const resetBlogListMutation = useResetBlogListMutation();

  const followBlacklistBlogMutation = useFollowBlacklistBlogMutation();
  const resetFollowBlacklistBlogMutation = useResetFollowBlacklistBlogMutation();

  const followMutedBlogMutation = useFollowMutedBlogMutation();
  const resetFollowMutedBlogMutation = useResetFollowMutedBlogMutation();

  switch (variant) {
    case 'blacklisted':
      return (
        <ListArea
          titleBy={t('user_profile.lists.list.accounts_blacklisted_by', { username: username })}
          listTitle={t('user_profile.lists.list.unblacklist')}
          resetTitle={t('user_profile.lists.list.reset_blacklist')}
          listDescription={profileData?.profile?.blacklist_description}
          data={data}
          splitArrays={splitArrays}
          isLoading={blacklistBlogMutation.isPending}
          resetListIsLoading={resetBlacklistBlogMutation.isPending}
          accountOwner={userOwner}
          variant="blacklisted"
          onSearchChange={onSearchChange}
          handleAdd={async (name: string) => {
            try {
              await blacklistBlogMutation.mutateAsync({ otherBlogs: name });
            } catch (error) {
              handleError(error, { method: 'blacklistBlog', params: { otherBlogs: name } });
            }
          }}
          handleReset={async () => {
            try {
              await resetBlacklistBlogMutation.mutateAsync();
            } catch (error) {
              handleError(error, { method: 'resetBlacklistBlog', params: {} });
            }
          }}
        />
      );
    case 'muted':
      return (
        <ListArea
          titleBy={t('user_profile.lists.list.accounts_muted_by', { username: username })}
          listTitle={t('user_profile.lists.list.unmute')}
          resetTitle={t('user_profile.lists.list.reset_muted_list')}
          listDescription={profileData?.profile?.muted_list_description}
          data={data}
          splitArrays={splitArrays}
          isLoading={muteMutation.isPending}
          resetListIsLoading={resetBlogListMutation.isPending}
          accountOwner={userOwner}
          variant="muted"
          onSearchChange={onSearchChange}
          handleAdd={async (name: string) => {
            try {
              await muteMutation.mutateAsync({ username: name });
            } catch (error) {
              handleError(error, { method: 'mute', params: { username: name } });
            }
          }}
          handleReset={async () => {
            try {
              await resetBlogListMutation.mutateAsync();
            } catch (error) {
              handleError(error, { method: 'resetBlogList', params: {} });
            }
          }}
        />
      );
    case 'follow_blacklist':
      return (
        <ListArea
          titleBy={t('user_profile.lists.followed_blacklists', { username: username })}
          listTitle={t('user_profile.lists.list.unfollow_blacklist')}
          resetTitle={t('user_profile.lists.list.reset_followed_blacklists')}
          variant="followBlacklist"
          data={data}
          splitArrays={splitArrays}
          isLoading={followBlacklistBlogMutation.isPending}
          resetListIsLoading={resetFollowBlacklistBlogMutation.isPending}
          accountOwner={userOwner}
          onSearchChange={onSearchChange}
          handleAdd={async (name: string) => {
            try {
              await followBlacklistBlogMutation.mutateAsync({ otherBlogs: name });
            } catch (error) {
              handleError(error, { method: 'followBlacklistBlog', params: { otherBlogs: name } });
            }
          }}
          handleReset={async () => {
            try {
              await resetFollowBlacklistBlogMutation.mutateAsync();
            } catch (error) {
              handleError(error, { method: 'resetFollowBlacklistBlog', params: {} });
            }
          }}
        />
      );
    case 'follow_muted':
      return (
        <ListArea
          titleBy={t('user_profile.lists.followed_muted_lists', { username: username })}
          listTitle={t('user_profile.lists.list.unfollow_muted_list')}
          resetTitle={t('user_profile.lists.list.reset_followed_muted_list')}
          data={data}
          splitArrays={splitArrays}
          isLoading={followMutedBlogMutation.isPending}
          resetListIsLoading={resetFollowMutedBlogMutation.isPending}
          accountOwner={userOwner}
          onSearchChange={onSearchChange}
          variant="followMutedList"
          handleAdd={async (name: string) => {
            try {
              await followMutedBlogMutation.mutateAsync({ otherBlogs: name });
            } catch (error) {
              handleError(error, { method: 'followMutedBlog', params: { otherBlogs: name } });
            }
          }}
          handleReset={async () => {
            try {
              await resetFollowMutedBlogMutation.mutateAsync();
            } catch (error) {
              handleError(error, { method: 'resetFollowMutedBlog', params: {} });
            }
          }}
        />
      );
    default:
      return null;
  }
};

export default ListVariant;
