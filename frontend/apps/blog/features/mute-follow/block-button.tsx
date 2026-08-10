'use client';

import { Button } from '@hive/ui';
import { CircleSpinner } from 'react-spinners-kit';
import clsx from 'clsx';
import { useTranslation } from '@/blog/i18n/client';

/**
 * Block / Unblock.
 *
 * Sits next to Follow and, where it is still shown, Mute. It is a DIFFERENT control
 * from Mute and the labels have to keep them apart: Mute is Hive's chain-wide,
 * viewer-only ignore; Block is Lumen's, and it also removes the blocked account's
 * replies from under the blocker's own posts for every reader.
 *
 * Rendered for BOTH account tiers, unlike Mute — a lite account has no key to sign a
 * chain mute, which is why it was hidden from them entirely and why they had no way
 * to get rid of anybody until now.
 */
const BlockButton = ({
  variant,
  loading,
  isBlocking,
  onClick,
  disabled
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
  isBlocking: boolean;
  onClick: () => void;
  disabled?: boolean;
}) => {
  const { t } = useTranslation('common_blog');

  return (
    <Button
      className={clsx('hover:text-destructive', { 'text-destructive': isBlocking })}
      variant={variant}
      size="sm"
      data-testid="profile-block-button"
      onClick={() => onClick()}
      disabled={loading || disabled}
    >
      {loading ? (
        <span className="flex h-5 w-12 items-center justify-center">
          <CircleSpinner loading={loading} size={18} color="#dc2626" />
        </span>
      ) : isBlocking ? (
        t('user_profile.unblock_button')
      ) : (
        t('user_profile.block_button')
      )}
    </Button>
  );
};
export default BlockButton;
