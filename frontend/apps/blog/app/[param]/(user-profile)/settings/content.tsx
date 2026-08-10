'use client';

import SettingsForm from '@/blog/features/account-settings/form';
import MutedList from '@/blog/features/account-settings/muted-list';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';

const SettingsContent = ({ username }: { username: string }) => {
  const { user, isHydrated } = useUserClient();
  const isOwner = Boolean(user?.isLoggedIn && user?.username === username);

  return (
    <div className="flex flex-col" data-testid="public-profile-settings">
      {isOwner ? <SettingsForm username={user.username} /> : null}

      {/* ★ NEVER A BLANK PAGE (2026-08-08). When the viewer was not the owner —
          signed out, or looking at someone else's settings URL — this rendered
          the profile header, the tab bar, and then nothing at all: a screen of
          empty white with no explanation and no way onward. `/wallet` gets this
          right ("Log in to see your Hive wallet"), so settings now says the same
          kind of thing. Waits for hydration first, so a signed-in owner never
          sees a "log in" flash on their own page. */}
      {isHydrated && !isOwner ? (
        <div className="rounded-2xl border border-[#ebebeb] bg-white px-6 py-10 text-center">
          <p className="mb-1 font-serif text-[17px] font-semibold text-[#161511]">
            {user?.isLoggedIn ? 'These aren’t your settings' : 'Log in to change your settings'}
          </p>
          <p className="mx-auto mb-5 max-w-[46ch] text-[13.5px] leading-[1.6] text-[#6b7280]">
            {user?.isLoggedIn
              ? `You’re signed in as @${user.username}, so you can only change your own settings.`
              : 'Your settings live on your own account. Sign in and you’ll land back here.'}
          </p>
          <a
            href={user?.isLoggedIn ? `/@${user.username}/settings` : '/login'}
            className="inline-block rounded-[13px] bg-[#c0392b] px-5 py-2.5 text-[14px] font-bold text-white hover:bg-[#96271b]"
          >
            {user?.isLoggedIn ? 'Go to my settings' : 'Log in'}
          </a>
        </div>
      ) : null}

      <MutedList username={username} />
    </div>
  );
};

export default SettingsContent;
