import { useUnblacklistBlogMutation } from '@/blog/components/hooks/use-blacklist-mutations';
import { useUnfollowBlacklistBlogMutation } from '@/blog/components/hooks/use-follow-blacklist-mutation';
import { useUnfollowMutedBlogMutation } from '@/blog/components/hooks/use-follow-muted-list-mutation';
import { useUnmuteMutation } from '@/blog/features/mute-follow/hooks/use-mute-mutations';
import type { IFollowList } from '@hive/common-hiveio-packages/wax';
import { Button } from '@ui/components';
import { handleError } from '@ui/lib/handle-error';
import BasePathLink from '@/blog/components/base-path-link';
import { CircleSpinner } from 'react-spinners-kit';
import { UserAvatarImg } from '@hive/ui';

const ListItem = ({
  item,
  loading,
  accountOwner,
  listTitle,
  variant
}: {
  item: IFollowList;
  loading: boolean;
  accountOwner: boolean;
  listTitle: string;
  variant: 'blacklisted' | 'muted' | 'followBlacklist' | 'followMutedList';
}) => {
  const unblacklistBlogMutation = useUnblacklistBlogMutation();
  const unmuteMutation = useUnmuteMutation();
  const unfollowBlacklistBlogMutation = useUnfollowBlacklistBlogMutation();
  const unfollowMutedBlogMutation = useUnfollowMutedBlogMutation();

  const handleDelete = async (name: string) => {
    try {
      switch (variant) {
        case 'blacklisted':
          await unblacklistBlogMutation.mutateAsync({ blog: name });
          break;
        case 'followBlacklist':
          await unfollowBlacklistBlogMutation.mutateAsync({ blog: name });
          break;
        case 'muted':
          await unmuteMutation.mutateAsync({ username: name });
          break;
        case 'followMutedList':
          await unfollowMutedBlogMutation.mutateAsync({ blog: name });
          break;
      }
    } catch (error) {
      handleError(error, { method: variant, params: { blog: name } });
    }
  };
  const currentItem =
    unblacklistBlogMutation.variables?.blog ||
    unfollowBlacklistBlogMutation.variables?.blog ||
    unmuteMutation.variables?.username ||
    unfollowMutedBlogMutation.variables?.blog;

  const deleteIsLoading =
    unblacklistBlogMutation.isPending ||
    unfollowBlacklistBlogMutation.isPending ||
    unmuteMutation.isPending ||
    unfollowMutedBlogMutation.isPending;

  const isItemLoading = (deleteIsLoading && currentItem === item.name) || loading;

  return (
    <li
      data-testid="user-list-item"
      className={`flex items-center justify-between border-b border-[#ebebeb] px-3 py-2 transition-colors last:border-b-0 odd:bg-background-tertiary/50 hover:bg-[#fdf2f0] ${item._temporary ? 'opacity-50' : ''}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        {/* ★ CONVERGED (F6 item 22). No fallback at all before — a broken avatar
            was just a broken `<img>` glyph in this list. */}
        <UserAvatarImg username={item.name} pixelSize={24} />
        {!item._temporary ? (
          <BasePathLink
            data-testid="user-list-item-name"
            className="truncate text-sm font-semibold text-destructive hover:underline"
            href={`/@${item.name}`}
          >
            {item.name}
          </BasePathLink>
        ) : (
          <span
            data-testid="user-list-item-name"
            className="truncate text-sm font-semibold text-primary/50"
          >
            {item.name}
          </span>
        )}
        {item.blacklist_description ? (
          <span className="hidden truncate text-caption text-primary/50 sm:inline">
            {item.blacklist_description}
          </span>
        ) : null}
      </span>
      {accountOwner ? (
        <Button
          variant="outlineRed"
          // ★ CAPITALIZED (F9, 2026-08-11, buildmap item 15). The translation
          // strings themselves ("unblacklist", "unfollow blacklist", ...) are
          // lowercase by convention — every other button label in the app is
          // Title Case, so this is a presentational fix, not a copy change; a
          // locale that capitalizes its own strings differently is unaffected.
          className="ml-2 min-w-[90px] shrink-0 whitespace-nowrap px-2 py-1 text-caption capitalize"
          size="xs"
          onClick={() => handleDelete(item.name)}
          disabled={isItemLoading || item._temporary}
        >
          {isItemLoading ? (
            <CircleSpinner loading={isItemLoading} size={16} color="#dc2626" />
          ) : (
            listTitle
          )}
        </Button>
      ) : null}
    </li>
  );
};

export default ListItem;
