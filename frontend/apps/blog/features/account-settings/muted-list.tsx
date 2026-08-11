'use client';

import { useFollowListQuery } from '@/blog/components/hooks/use-follow-list';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useInitialFollowList } from '@/blog/components/observer-provider';
import { useUnmuteMutation } from '@/blog/features/mute-follow/hooks/use-mute-mutations';
import { useTranslation } from '@/blog/i18n/client';
import { handleError } from '@ui/lib/handle-error';
import { CircleSpinner } from 'react-spinners-kit';
import { Avatar, AvatarFallback, AvatarImage, getUserAvatarUrl, getDefaultImageUrl } from '@ui/components';
import BasePathLink from '@/blog/components/base-path-link';
import { SETTINGS_CARD, SETTINGS_CARD_HINT, SETTINGS_CARD_TITLE } from './lib/card';

/**
 * ★ THIS WAS A NUMBERED TEXT LIST (2026-08-10, fuckery list L-2).
 *
 * It rendered "1. someone [unmute]" — an ordered list of bare names with the
 * action written as a link inside square brackets, which is how a 2016 forum
 * writes a control, not a product. Same data, now a real list: avatar, handle
 * that goes to the profile, and an Unmute button that looks like the buttons
 * everywhere else. The empty case says so instead of rendering nothing.
 */
const MutedList = ({ username }: { username: string }) => {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  // ★ OWNERSHIP. This list belongs to `username` — the profile being VIEWED — but
  // the unmute mutation always signs as the LOGGED-IN user. Nothing gates
  // /@anyone/settings, so on someone else's settings page every Unmute button
  // broadcast an unmute from the viewer's own account against a name from a
  // stranger's list: a wasted chain write at best, and at worst it silently
  // undid a mute the viewer had deliberately set. A lite viewer has no signer at
  // all and got a raw crash.
  //
  // The list stays visible (it is public follow data); only the WRITE is gated.
  const canUnmute = user.isLoggedIn && user.account_tier !== 'lite' && user.username === username;
  const initialFollowList = useInitialFollowList();
  const mutedQuery = useFollowListQuery(username, 'muted', initialFollowList);
  const unmuteMutation = useUnmuteMutation();

  // A failed or still-running first load is not "you have muted nobody", so the
  // card only claims an empty list once there is an answer to be empty.
  if (!mutedQuery.data) return null;

  const muted = mutedQuery.data;

  return (
    <section className={SETTINGS_CARD} data-testid="settings-muted-users">
      <h2 className={SETTINGS_CARD_TITLE}>{t('settings_page.muted_users')}</h2>
      <p className={SETTINGS_CARD_HINT}>
        {canUnmute ? t('settings_page.muted_users_hint') : t('settings_page.unmute_locked', { username })}
      </p>

      {muted.length === 0 ? (
        <p className="mt-4 rounded-[14px] bg-[#f7f7f7] px-4 py-5 text-center text-[13.5px] text-[#6b7280]">
          {t('settings_page.muted_users_empty')}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-[#f1f3f5] border-t border-[#f1f3f5]">
          {muted.map((mutedUser) => {
            const pending =
              unmuteMutation.isPending && unmuteMutation.variables?.username === mutedUser.name;
            return (
              <li key={mutedUser.name} className="flex items-center gap-3 px-1 py-3">
                {/* The tinted ground matters: Radix renders NOTHING while the
                    avatar request is in flight and only swaps in the fallback on
                    an error, so 22 rows of pending avatars left 22 holes in the
                    list. A filled circle reads as "loading", not as broken. */}
                <Avatar className="h-9 w-9 shrink-0 bg-[#f1f3f5]">
                  <AvatarImage
                    className="h-full w-full object-cover"
                    src={getUserAvatarUrl(mutedUser.name, 'small')}
                    alt=""
                  />
                  <AvatarFallback>
                    <img className="h-full w-full object-cover" src={getDefaultImageUrl()} alt="" />
                  </AvatarFallback>
                </Avatar>

                <BasePathLink
                  href={`/@${mutedUser.name}`}
                  className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[#161511] hover:text-[#c0392b]"
                >
                  @{mutedUser.name}
                </BasePathLink>

                {canUnmute ? (
                  <button
                    type="button"
                    data-testid="settings-unmute-button"
                    className="inline-flex h-9 min-w-[92px] items-center justify-center rounded-[14px] border border-[#e4e6e9] bg-white px-4 text-[13px] font-bold text-[#c0392b] transition-colors hover:border-[#c0392b] hover:bg-[#fdf2f0] disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={async () => {
                      const params = { username: mutedUser.name };
                      try {
                        await unmuteMutation.mutateAsync(params);
                      } catch (error) {
                        handleError(error, { method: 'unmute', params });
                      }
                    }}
                    disabled={pending}
                  >
                    {pending ? (
                      <CircleSpinner loading size={16} color="#c0392b" />
                    ) : (
                      t('settings_page.unmute_button')
                    )}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default MutedList;
