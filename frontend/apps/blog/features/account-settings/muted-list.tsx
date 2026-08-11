'use client';

import { useFollowListQuery } from '@/blog/components/hooks/use-follow-list';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useInitialFollowList } from '@/blog/components/observer-provider';
import { useUnmuteMutation } from '@/blog/features/mute-follow/hooks/use-mute-mutations';
import { useTranslation } from '@/blog/i18n/client';
import { handleError } from '@ui/lib/handle-error';
import { CircleSpinner } from 'react-spinners-kit';
import { Skeleton, UserAvatarImg } from '@ui/components';
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
  /**
   * ★★★ OWNERSHIP, FIXED (2026-08-11, fuckery-v2 G1: S1/S3). This was
   * `user.isLoggedIn && user.username === username` off raw `useUserClient()`,
   * which cannot answer during SSR and reports signed-out until `/api/users/me`
   * returns — so `canUnmute` stayed false long after the real owner had loaded
   * the page, and the hint fell through to `unmute_locked` ("Only @lordbutterfly
   * can change this list.") ON HIS OWN PAGE. Measured live, at t=97s: still zero
   * Unmute buttons for the actual owner.
   *
   * `identity` (`features/layouts/server-session.tsx`, the same fix the header
   * already shipped) is seeded from the session cookie the server read, so
   * `isOwnerMatch` is correct from the very first render. What it does NOT carry
   * is `account_tier` — that only exists on the real client user object, and a
   * keyless lite viewer has no signer at all, so granting write access before
   * we genuinely know the tier would reopen the exact `getSigner(undefined)`
   * crash `list-variant.tsx`'s own history already documents. So the WRITE gate
   * (`canUnmute`, which controls the actual button) still waits for
   * `identity.clientAnswered`; only the ACCUSATION ("this isn't yours") is
   * removed from the unresolved window — see `hint` below.
   */
  const identity = useSessionIdentity();
  const isOwnerMatch = identity.isLoggedIn && identity.username === username;
  const canUnmute = identity.clientAnswered
    ? isOwnerMatch && user.isLoggedIn && user.account_tier !== 'lite' && user.username === username
    : false;
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
      {/* ★ S3 — NEVER "Only @you can change this list" ON YOUR OWN PAGE.
          `unmute_locked` is only shown once `isOwnerMatch` is false, which
          `identity` already knows immediately from the session cookie — the
          same trust level the header gives it. The one genuinely uncertain
          window is `isOwnerMatch === true` but the tier is not confirmed yet
          (`!identity.clientAnswered`): a skeleton bar stands in rather than
          asserting either message, so the real owner is never told this
          isn't theirs while we're still waiting to find out whether they can
          write to it. */}
      {!isOwnerMatch ? (
        <p className={SETTINGS_CARD_HINT}>{t('settings_page.unmute_locked', { username })}</p>
      ) : identity.clientAnswered ? (
        <p className={SETTINGS_CARD_HINT}>
          {canUnmute ? t('settings_page.muted_users_hint') : t('settings_page.unmute_locked', { username })}
        </p>
      ) : (
        <Skeleton className="mt-1.5 h-[13px] w-56" data-testid="settings-muted-hint-skeleton" />
      )}

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
                {/* ★ SAME PATTERN AS THE WITNESS TABLE (audit item 14). This used
                    to be a Radix `Avatar` pointed at our own `/api/avatar` proxy
                    (the slow path — see the long note on `getUserAvatarDirectUrl`)
                    with a generic, uncached, non-personalised default picture as
                    the fallback: Radix shows that fallback for the entire time the
                    request is in flight, not just on a real error, so a page of
                    muted users read as a column of blank grey circles for as long
                    as the proxy took. Now the app's one avatar component (F6 item
                    22): direct host first, `/api/avatar` retried on error, letter
                    underneath the whole time so there is never a hole. */}
                <UserAvatarImg username={mutedUser.name} pixelSize={36} />

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
