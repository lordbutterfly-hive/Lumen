import { useTranslation } from '@/blog/i18n/client';
import ListArea from './list-area';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import type { FullAccount, IFollowList } from '@hive/common-hiveio-packages/wax';
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
  /**
   * ★★★ OWNERSHIP, FIXED (2026-08-11, fuckery-v2 G1: S1/S2). This was
   * `user.username === username && user.isLoggedIn && !isLite` off raw
   * `useUserClient()`, which cannot answer during SSR and reports signed-out
   * until `/api/users/me` returns. Measured live on `/lists/blacklisted`: no add
   * input, no per-row unblacklist buttons, no Reset Options for the actual
   * owner — while a direct `bridge.get_follow_list` call at that same moment
   * returned the list fine, so it was never a data problem.
   *
   * `identity` (`features/layouts/server-session.tsx`) is seeded from the
   * session cookie the server already read, so `isOwnerMatch` is correct on the
   * very first render. `account_tier` is NOT on `identity` (it only exists on
   * the real client `user` object), and the comment this replaces documents
   * exactly why that still matters: these four lists are chain-only features —
   * every write is a `transactionService` custom_json — and a keyless lite
   * account has no signer at all. Granting `userOwner` before the tier is
   * confirmed would reopen the raw `getSigner(undefined)` crash this file's
   * history already fixed once, so the WRITE gate still waits for
   * `identity.clientAnswered`; only the "resolves false forever" bug is gone.
   */
  const identity = useSessionIdentity();
  const isOwnerMatch = identity.isLoggedIn && identity.username === username;
  const isLite = user.account_tier === 'lite';
  const userOwner = identity.clientAnswered
    ? isOwnerMatch && user.username === username && user.isLoggedIn && !isLite
    : false;

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
          // ★ B2 — no local try/catch here: `useBlacklistBlogMutation`'s own
          // `onError` already calls `handleError` (a second call here just
          // duplicated the toast), and the add-form's state machine
          // (use-add-to-list-form.ts) needs this promise to actually REJECT
          // so it can tell "confirming" apart from "timed out" / "rejected".
          handleAdd={(name: string) => blacklistBlogMutation.mutateAsync({ otherBlogs: name })}
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
          // ★ B2 — see the blacklisted case above: let the mutation's own onError
          // handle the toast, and let this promise actually reject.
          handleAdd={(name: string) => muteMutation.mutateAsync({ username: name })}
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
          // ★ B2 — see the blacklisted case above: let the mutation's own onError
          // handle the toast, and let this promise actually reject.
          handleAdd={(name: string) => followBlacklistBlogMutation.mutateAsync({ otherBlogs: name })}
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
          // ★ B2 — see the blacklisted case above: let the mutation's own onError
          // handle the toast, and let this promise actually reject.
          handleAdd={(name: string) => followMutedBlogMutation.mutateAsync({ otherBlogs: name })}
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
