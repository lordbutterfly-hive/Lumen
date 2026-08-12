import { useTranslation } from '@/blog/i18n/client';
import { Button } from '@hive/ui';
import clsx from 'clsx';
import { CircleSpinner } from 'react-spinners-kit';

const FollowButton = ({
  variant,
  loading,
  isFollow,
  onClick,
  disabled,
  unknown = false
}: {
  variant:
    | 'default'
    | 'destructive'
    | 'outline'
    | 'secondary'
    | 'ghost'
    | 'outlineRed'
    | 'link'
    | 'redHover'
    | 'basic'
    | null
    | undefined;
  loading: boolean;
  isFollow: boolean;
  onClick: () => void;
  disabled?: boolean;
  /**
   * The Lumen follow-state read failed permanently (see `unknown` on
   * `use-lumen-follow.ts`'s `LumenFollow`) — render a disabled, honestly-labelled
   * button instead of guessing Follow/Unfollow. Mirrors `BlockButton`'s `unknown`
   * prop: the alternative is either claiming a relationship that may not exist, or —
   * the actual bug this closes — silently taking the on-chain path for a pair the
   * chain cannot represent at all.
   */
  unknown?: boolean;
}) => {
  const { t } = useTranslation('common_blog');

  return (
    <Button
      className={clsx('hover:text-destructive', {
        'text-destructive': disabled
      })}
      variant={variant}
      size="sm"
      data-testid="profile-follow-button"
      onClick={() => onClick()}
      disabled={loading || !!disabled || unknown}
      title={unknown ? t('user_profile.follow_status_unknown_hint') : undefined}
    >
      {loading ? (
        <span className="flex h-5 w-12 items-center justify-center">
          <CircleSpinner loading={loading} size={18} color="#dc2626" />
        </span>
      ) : unknown ? (
        t('user_profile.follow_status_unknown')
      ) : isFollow ? (
        t('user_profile.unfollow_button')
      ) : (
        t('user_profile.follow_button')
      )}
    </Button>
  );
};
export default FollowButton;
