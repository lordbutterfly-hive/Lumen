'use client';

import { Button } from '@hive/ui';
import { CircleSpinner } from 'react-spinners-kit';
import clsx from 'clsx';
import { useTranslation } from '@/blog/i18n/client';

/**
 * Block / Unblock.
 *
 * Sits next to Follow — the ONE moderation control here (owner ruling, 2026-08-12:
 * "mute and personal blacklist should be the same damn thing... just call it
 * block"). This used to sit next to a separate on-chain Mute button; that button
 * was retired from every primary surface (this one, the profile/post/comment
 * overflow menus) in the same pass. Block hides the target from the viewer's own
 * feeds AND removes the blocked account's replies from under the blocker's own
 * posts, for every reader — the second half is the reason it replaced Mute rather
 * than sitting beside it.
 *
 * Rendered for BOTH account tiers, unlike the old Mute — a lite account has no key
 * to sign a chain mute, which is why Mute was hidden from them entirely and why
 * they had no way to get rid of anybody until Block existed.
 */
const BlockButton = ({
  variant,
  loading,
  isBlocking,
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
  isBlocking: boolean;
  onClick: () => void;
  disabled?: boolean;
  /**
   * The block-state read failed permanently (see `unknown` on `use-lumen-block.ts`'s
   * `LumenBlock`) — render a disabled, honestly-labelled button instead of Block/
   * Unblock. The caller still mounts this component in that case (rather than the
   * usual `block.available` gate) precisely so the control does not disappear during
   * a backend outage with nothing telling the reader why.
   */
  unknown?: boolean;
}) => {
  const { t } = useTranslation('common_blog');

  return (
    <Button
      className={clsx('hover:text-destructive', { 'text-destructive': isBlocking })}
      variant={variant}
      size="sm"
      data-testid="profile-block-button"
      onClick={() => onClick()}
      disabled={loading || disabled || unknown}
      title={unknown ? t('user_profile.block_status_unknown_hint') : undefined}
    >
      {loading ? (
        <span className="flex h-5 w-12 items-center justify-center">
          <CircleSpinner loading={loading} size={18} color="#dc2626" />
        </span>
      ) : unknown ? (
        t('user_profile.block_status_unknown')
      ) : isBlocking ? (
        t('user_profile.unblock_button')
      ) : (
        t('user_profile.block_button')
      )}
    </Button>
  );
};
export default BlockButton;
