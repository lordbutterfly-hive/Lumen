'use client';

import SettingsForm from '@/blog/features/account-settings/form';
import MutedList from '@/blog/features/account-settings/muted-list';
import BlockedList from '@/blog/features/account-settings/blocked-list';
import ModerationLists from '@/blog/features/account-settings/moderation-lists';
import { SETTINGS_CARD, SETTINGS_CARD_HINT, SETTINGS_CARD_TITLE } from '@/blog/features/account-settings/lib/card';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { Skeleton } from '@ui/components';

/**
 * ★ THIS PAGE WAS THE LAST UNMIGRATED FRONT DOOR (2026-08-10, fuckery list L-2).
 *
 * It is linked from the primary left rail AND the account menu, and it rendered
 * with no rails, no page shell, no card chrome and no house type: a bare form on
 * a white background under the legacy profile banner. It now sits in the same
 * 3-column frame as Home and Witnesses (mounted by this route's layout.tsx) and
 * is built from the same cards as the rest of the product.
 */

/** Stands in for the profile-settings card while ownership is unresolved — see
 * the big comment below for why this exists instead of just waiting quietly. */
const OwnerGateSkeleton = () => (
  <section className={SETTINGS_CARD} data-testid="settings-owner-gate-skeleton" aria-hidden="true">
    <Skeleton className="h-[19px] w-64" />
    <Skeleton className="mt-2 h-[13px] w-[28rem] max-w-full" />
    <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i}>
          <Skeleton className="mb-1.5 h-[12.5px] w-24" />
          <Skeleton className="h-10 w-full" />
        </div>
      ))}
    </div>
  </section>
);

const SettingsContent = ({ username }: { username: string }) => {
  /**
   * ★★★ THE OWNER GATE, FIXED (2026-08-11, fuckery-v2 G1: S1/S3/S4).
   *
   * This used to be `useUserClient()` directly: `isOwner = user.isLoggedIn &&
   * user.username === username`. `useUserClient()` cannot answer during SSR and
   * reports signed-out until `/api/users/me` returns — exactly the bug
   * `useSessionIdentity` (`features/layouts/server-session.tsx`) and the header
   * were already fixed for (see that file's big comment, and
   * `app-header.tsx`'s "NEVER SHOW A SIGNED-IN READER A SIGNED-OUT HEADER").
   * Measured live: `isOwner` stayed false — and this component's OWN "not your
   * settings" branch, gated only on `isHydrated` (which flips true almost
   * immediately, well before the client's real answer lands), fired instead —
   * so the actual owner's own page told him "These aren't your settings" (S3),
   * `SettingsForm` never mounted (S1: zero "Public Profile Settings", zero
   * "Preferences"), and when the client finally did resolve, `SettingsForm`
   * popped in ABOVE `ModerationLists`/`MutedList` and shoved them ~470px (S4).
   *
   * `identity.isLoggedIn`/`identity.username` are seeded from the session
   * cookie the SERVER already read (or a localStorage seed), so they are
   * correct on the very FIRST render — server and client alike — which is what
   * makes the real owner's form mount immediately instead of popping in late.
   */
  const identity = useSessionIdentity();
  const isOwner = identity.isLoggedIn && identity.username === username;

  return (
    <div className="flex flex-col gap-5" data-testid="public-profile-settings">
      {isOwner ? (
        <SettingsForm username={identity.username} />
      ) : identity.clientAnswered ? (
        /* ★ NEVER A BLANK PAGE (2026-08-08). When the viewer was not the owner —
            signed out, or looking at someone else's settings URL — this rendered
            the profile header, the tab bar, and then nothing at all: a screen of
            empty white with no explanation and no way onward. `/wallet` gets this
            right ("Log in to see your Hive wallet"), so settings now says the same
            kind of thing.

            ★ Gated on `identity.clientAnswered`, NOT on `isOwner` being false. The
            house rule from the build map: "render a skeleton while unresolved,
            never a silent viewer fallback" — this card asserts "these aren't your
            settings" to the reader, and that assertion must only ever be made once
            the client has actually confirmed it, never on the cookie/localStorage
            best-guess alone. The real owner never sees it at all (isOwner is true
            from the first paint); this branch is reachable only once we are SURE. */
        <section className={`${SETTINGS_CARD} text-center`} data-testid="settings-owner-mismatch">
          <h2 className={SETTINGS_CARD_TITLE}>
            {identity.isLoggedIn ? 'These aren’t your settings' : 'Log in to change your settings'}
          </h2>
          <p className={`${SETTINGS_CARD_HINT} mx-auto max-w-[46ch]`}>
            {identity.isLoggedIn
              ? `You’re signed in as @${identity.username}, so you can only change your own settings.`
              : 'Your settings live on your own account. Sign in and you’ll land back here.'}
          </p>
          <a
            href={identity.isLoggedIn ? `/@${identity.username}/settings` : '/login'}
            className="mt-5 inline-block rounded-[14px] bg-[#c0392b] px-5 py-2.5 text-[14px] font-bold text-white transition-colors hover:bg-[#96271b]"
          >
            {identity.isLoggedIn ? 'Go to my settings' : 'Log in'}
          </a>
        </section>
      ) : (
        <OwnerGateSkeleton />
      )}

      {/* ★ FIRST, ABOVE THE LEGACY LISTS (owner ruling, 2026-08-12). Block is now
          the ONE primary moderation control across the profile/post/comment
          overflow menus; this card is where "make sure it persists" gets proven —
          see `blocked-list.tsx`'s header comment. Mute/Blacklist keep their own
          cards below for anyone with pre-existing chain-based entries. */}
      <BlockedList username={username} />
      <ModerationLists username={username} />
      <MutedList username={username} />
    </div>
  );
};

export default SettingsContent;
