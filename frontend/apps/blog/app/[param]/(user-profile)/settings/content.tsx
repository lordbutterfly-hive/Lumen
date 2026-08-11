'use client';

import SettingsForm from '@/blog/features/account-settings/form';
import MutedList from '@/blog/features/account-settings/muted-list';
import ModerationLists from '@/blog/features/account-settings/moderation-lists';
import { SETTINGS_CARD, SETTINGS_CARD_HINT, SETTINGS_CARD_TITLE } from '@/blog/features/account-settings/lib/card';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';

/**
 * ★ THIS PAGE WAS THE LAST UNMIGRATED FRONT DOOR (2026-08-10, fuckery list L-2).
 *
 * It is linked from the primary left rail AND the account menu, and it rendered
 * with no rails, no page shell, no card chrome and no house type: a bare form on
 * a white background under the legacy profile banner. It now sits in the same
 * 3-column frame as Home and Witnesses (mounted by this route's layout.tsx) and
 * is built from the same cards as the rest of the product.
 */
const SettingsContent = ({ username }: { username: string }) => {
  const { user, isHydrated } = useUserClient();
  const isOwner = Boolean(user?.isLoggedIn && user?.username === username);

  return (
    <div className="flex flex-col gap-5" data-testid="public-profile-settings">
      {isOwner ? <SettingsForm username={user.username} /> : null}

      {/* ★ NEVER A BLANK PAGE (2026-08-08). When the viewer was not the owner —
          signed out, or looking at someone else's settings URL — this rendered
          the profile header, the tab bar, and then nothing at all: a screen of
          empty white with no explanation and no way onward. `/wallet` gets this
          right ("Log in to see your Hive wallet"), so settings now says the same
          kind of thing. Waits for hydration first, so a signed-in owner never
          sees a "log in" flash on their own page. */}
      {isHydrated && !isOwner ? (
        <section className={`${SETTINGS_CARD} text-center`}>
          <h2 className={SETTINGS_CARD_TITLE}>
            {user?.isLoggedIn ? 'These aren’t your settings' : 'Log in to change your settings'}
          </h2>
          <p className={`${SETTINGS_CARD_HINT} mx-auto max-w-[46ch]`}>
            {user?.isLoggedIn
              ? `You’re signed in as @${user.username}, so you can only change your own settings.`
              : 'Your settings live on your own account. Sign in and you’ll land back here.'}
          </p>
          <a
            href={user?.isLoggedIn ? `/@${user.username}/settings` : '/login'}
            className="mt-5 inline-block rounded-[14px] bg-[#c0392b] px-5 py-2.5 text-[14px] font-bold text-white transition-colors hover:bg-[#96271b]"
          >
            {user?.isLoggedIn ? 'Go to my settings' : 'Log in'}
          </a>
        </section>
      ) : null}

      <ModerationLists username={username} />
      <MutedList username={username} />
    </div>
  );
};

export default SettingsContent;
