'use client';

import BasePathLink from '@/blog/components/base-path-link';
import { useTranslation } from '@/blog/i18n/client';
import { SETTINGS_CARD, SETTINGS_CARD_HINT, SETTINGS_CARD_TITLE } from './lib/card';

/**
 * ★ THE MODERATION LISTS MOVED HERE (2026-08-10, fuckery list L-3).
 *
 * Blacklisted Users / Muted Users / Followed Blacklists / Followed Muted Lists
 * used to sit in the legacy profile header, on one row with the follower,
 * post and following counts. On a personal profile that gave four moderation
 * tools the same billing as "how many people follow this person", which is not
 * what a profile is for and not what a visitor came to read. They are account
 * housekeeping, so they live in settings with the rest of the housekeeping.
 *
 * The list pages themselves are unchanged and still public — these are the same
 * four routes, just reached from somewhere that makes sense.
 */
const ModerationLists = ({ username }: { username: string }) => {
  const { t } = useTranslation('common_blog');

  const links = [
    { href: `/@${username}/lists/blacklisted`, label: t('user_profile.lists.blacklisted_users') },
    { href: `/@${username}/lists/muted`, label: t('user_profile.lists.muted_users') },
    { href: `/@${username}/lists/followed_blacklists`, label: t('user_profile.lists.followed_blacklists') },
    { href: `/@${username}/lists/followed_muted_lists`, label: t('user_profile.lists.followed_muted_lists') }
  ];

  return (
    <section className={SETTINGS_CARD} data-testid="settings-moderation-lists">
      <h2 className={SETTINGS_CARD_TITLE}>{t('settings_page.moderation_lists')}</h2>
      <p className={SETTINGS_CARD_HINT}>{t('settings_page.moderation_lists_hint')}</p>

      <ul className="mt-4 divide-y divide-[#f1f3f5] border-t border-[#f1f3f5]">
        {links.map((link) => (
          <li key={link.href}>
            <BasePathLink
              href={link.href}
              className="flex items-center justify-between rounded-[14px] px-3 py-3 text-[14px] font-semibold text-[#161511] transition-colors hover:bg-[#fdf2f0] hover:text-[#c0392b]"
            >
              {link.label}
              <span aria-hidden className="text-[16px] leading-none text-[#9ca3af]">
                &rsaquo;
              </span>
            </BasePathLink>
          </li>
        ))}
      </ul>
    </section>
  );
};

export default ModerationLists;
