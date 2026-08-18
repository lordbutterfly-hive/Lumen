'use client';

import { useEffect } from 'react';
import SettingsForm from '@/blog/features/account-settings/form';
import BlockedList from '@/blog/features/account-settings/blocked-list';
import { SETTINGS_CARD, SETTINGS_CARD_HINT, SETTINGS_CARD_TITLE } from '@/blog/features/account-settings/lib/card';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { Skeleton } from '@ui/components';

/** Written as one literal so Tailwind's source scanner generates all three. */
const LANDED_RING = 'ring-2 ring-line-brand-10 ring-offset-4 ring-offset-transparent';

/**
 * ★ LAND ON THE SECTION THE READER ASKED FOR (2026-08-13, audit §3.1).
 *
 * The four `/@user/lists/{muted,blacklisted,followed_blacklists,followed_muted_lists}`
 * routes redirect here with `#blocked-accounts`, because Lumen merged all four
 * of those concepts into the single Block list on this page (see each route
 * file, and `BlockedList`'s own header). The audit reported that they "all
 * collapse onto /settings ... the user lands on the settings page with no
 * indication which list they asked for" — that was measured with
 * `fetch(redirect:'follow')`, which drops the fragment; a real browser does
 * carry it, and does jump.
 *
 * What it does NOT do is stay there. Measured on the shipped build: the browser
 * jumps to the anchor, then `SettingsForm` mounts ABOVE the section and pushes
 * it down — landing at `scrollY 739` with the section 563px BELOW the top of
 * the viewport. Visible, but not where the reader was sent, and nothing on
 * screen says why they are on a settings page at all.
 *
 * So the jump is re-applied for as long as the page is still growing (the form,
 * the block list and the avatar all resolve asynchronously), and the card is
 * ringed briefly on arrival so the answer to "which list?" is the thing the eye
 * lands on. `scroll-margin` alone cannot fix this: the target moves AFTER the
 * browser has already scrolled.
 */
function useHashLanding() {
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;

    let stop = false;
    let lastTop: number | null = null;
    const started = Date.now();

    const settle = () => {
      if (stop) return;
      const el = document.getElementById(id);
      if (el) {
        const top = Math.round(el.getBoundingClientRect().top + window.scrollY);
        // Only re-scroll when the target actually MOVED. Re-scrolling every
        // frame would fight a reader who started scrolling away themselves.
        if (lastTop === null || Math.abs(top - lastTop) > 4) {
          lastTop = top;
          // 96px clears the sticky site header, the same offset the rails pin to.
          window.scrollTo({ top: Math.max(top - 96, 0) });
          el.classList.add(...LANDED_RING.split(' '));
        }
      }
      // Four seconds, not two: measured on a COLD first navigation the page was
      // still growing at t=2s and the reader was left 535px short of the
      // section, while a warm one had settled by 700ms. The loop costs one
      // `getBoundingClientRect` every 120ms and stops as soon as the window
      // closes, so the slow case is what the number has to cover.
      if (Date.now() - started < 4000) {
        window.setTimeout(settle, 120);
      } else {
        const el2 = document.getElementById(id);
        if (el2) window.setTimeout(() => el2.classList.remove(...LANDED_RING.split(' ')), 1600);
      }
    };

    settle();
    return () => {
      stop = true;
    };
  }, []);
}

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
          <Skeleton className="mb-1.5 h-[12px] w-24" />
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
  useHashLanding();

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
            className="mt-5 inline-block rounded-card bg-surface-brand-12 px-5 py-2.5 text-[14px] leading-[22px] font-bold text-ink-27 transition-colors hover:bg-surface-brand-17"
          >
            {identity.isLoggedIn ? 'Go to my settings' : 'Log in'}
          </a>
        </section>
      ) : identity.sessionUnavailable ? (
        /* ★★★ THE SKELETON BELOW WAS PERMANENT ON A FAILED SESSION READ
           (2026-08-13, adversarial review S4). `clientAnswered` is
           `dataUpdatedAt > 0` and React Query's error reducer never sets
           `dataUpdatedAt`, so a `/api/users/me` that only ever failed left this
           page showing six skeleton fields forever, with nothing to click.
           The gate itself is unchanged and still fails closed: this branch does
           NOT decide the reader is the owner, it only stops claiming the answer
           is still on its way. */
        <section className={`${SETTINGS_CARD} text-center`} data-testid="settings-owner-gate-error">
          <h2 className={SETTINGS_CARD_TITLE}>We couldn’t check your account</h2>
          <p className={`${SETTINGS_CARD_HINT} mx-auto max-w-[46ch]`}>
            Your settings are safe — we just couldn’t confirm who you are, so we can’t open the form yet.
          </p>
          <button
            type="button"
            onClick={identity.retrySession}
            className="mt-5 inline-block rounded-card bg-surface-brand-12 px-5 py-2.5 text-[14px] leading-[22px] font-bold text-ink-27 transition-colors hover:bg-surface-brand-17"
          >
            Try again
          </button>
        </section>
      ) : (
        <OwnerGateSkeleton />
      )}

      {/* ★ THE ONE MODERATION CARD (owner ruling, 2026-08-12): "there should be no
          muted list. its all block list, we merged it and it works all as
          block." `BlockedList` now reads BOTH Lumen blocks and the viewer's own
          on-chain mutes from the same `/api/lite/block/list` response — see its
          header comment for the removal-path wrinkle a chain entry keeps. The
          two cards that used to sit below it (`ModerationLists`, a set of links
          out to the four legacy `/lists/*` pages; `MutedList`, a second render of
          the same chain ignore list) are gone — those four routes now redirect
          here instead of rendering their own content. */}
      <BlockedList username={username} />
    </div>
  );
};

export default SettingsContent;
