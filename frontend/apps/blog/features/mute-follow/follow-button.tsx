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
  unknown = false,
  className
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
  /**
   * ★ POST-HEADER PILL PARITY (owner ruling 2026-08-19: "the positioning and
   * outlines are off" on the post detail page). `variant="outlineRed"` gives this
   * button `border-line-info-5` (slate, rgb(71,85,105)), a transparent
   * background and the shared `font-medium` (500) base weight, while the Reblog
   * pill it now sits directly beside (`reblog-trigger.tsx`'s `showLabel` button)
   * uses `border-border` (rgb(237,237,237)), `bg-background` (white) and no
   * weight override (400). Appended last, these utilities win over the
   * variant's via `cn`'s `twMerge` (Button component) without touching
   * `outlineRed` itself or any other caller of this component that does not
   * pass a `className`.
   */
  className?: string;
}) => {
  const { t } = useTranslation('common_blog');

  return (
    <Button
      className={clsx(
        'hover:text-destructive',
        {
          'text-destructive': disabled
        },
        className
      )}
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
