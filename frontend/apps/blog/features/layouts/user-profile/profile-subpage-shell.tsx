'use client';

import { ReactNode } from 'react';
import LeftRail from '@/blog/features/layouts/left-rail';
import RightRail from '@/blog/features/layouts/right-rail';
import PageMasthead from '@/blog/features/layouts/page-masthead';
import BasePathLink from '@/blog/components/base-path-link';
import { useTranslation } from '@/blog/i18n/client';

/**
 * The one chrome for every `/@username/<sub-page>` route.
 *
 * ★★★ WHY IT REPLACED A SWITCH (2026-08-10, fuckery list L-3).
 *
 * `/@username` used to render TWO different profiles depending on how you got
 * there. The route group's layout wrapped every child in the legacy
 * `ProfileLayout` — dark-navy cover, translucent card, a slate "Blog / Social"
 * tab bar and four moderation links sitting next to the follower stats — and a
 * client component (`profile-chrome-switch`) then read `usePathname()` and
 * removed that chrome again on the exact string `/@username`. So the profile URL
 * space carried a second, complete profile implementation: step one route
 * sideways (Settings, Followers, Social, any list) and the old product came
 * back, header and all, under the Lumen header. Clicking "Blog" in that old tab
 * bar returned to `/@username` and the redesigned profile reappeared, which is
 * what made it read as two pages on one URL.
 *
 * A pathname string is the wrong thing to switch on: it is client state that has
 * to agree with a server-rendered tree, and getting it wrong renders someone
 * else's page chrome. So there is no switch any more. `/@username` renders the
 * redesigned profile (`ProfileGrid`, which brings its own shell) and NOTHING
 * else; each sub-route mounts THIS shell from its own `layout.tsx`, statically,
 * by the router. A route now cannot render a chrome that does not belong to it.
 *
 * The grid is the shared app frame — 200 / 1fr / 312, gap 44, max-width 1720,
 * px-11 — the same one HomeShell, WitnessesShell and ProfileGrid use.
 */

// ★ `following`, not `followed` (2026-08-13). The route was renamed to
// `/@user/following` — the word the heading, the profile stat tile and every
// label in the product already used — so the key that selects that heading is
// renamed with it. `followed` is gone from this union because the only segment
// that used it (`(user-profile)/followed`) is now a bare redirect and mounts no
// shell at all; leaving a dead key here is how a "route and label disagree" bug
// grows back.
export type ProfileSubpage = 'settings' | 'followers' | 'following' | 'communities' | 'lists';

const ProfileSubpageShell = ({
  username,
  page,
  children,
  rightRail
}: {
  username: string;
  page: ProfileSubpage;
  children: ReactNode;
  /**
   * ★ /settings DOES NOT WANT THE FEED RAIL (audit item 13). The default here
   * is the same `<RightRail />` every sub-page used to get unconditionally —
   * the streak card, the prediction-market widget and Topics, all of them
   * feed context that has nothing to do with account settings. `undefined`
   * (every caller except settings) keeps that default so followers/followed/
   * communities/lists are unchanged; passing `null` drops the rail — and its
   * grid column — entirely, which settings/layout.tsx does.
   */
  rightRail?: ReactNode;
}) => {
  const { t } = useTranslation('common_blog');

  const titles: Record<ProfileSubpage, string> = {
    settings: t('navigation.profile_navbar.settings'),
    followers: t('user_profile.lists.followers_label'),
    following: t('user_profile.lists.following_label'),
    communities: t('navigation.profile_navbar.social'),
    lists: t('profile.subpage.lists_title')
  };

  const rail = rightRail === undefined ? <RightRail /> : rightRail;
  /**
   * ★ ONLY WHEN THIS SHELL IS USING THE DEFAULT RAIL. A caller that passed
   * `rightRail={null}` (/settings does) declined the feed rail; it did not ask for the
   * rail's contents to reappear inside the content column at narrow widths instead.
   */
  const usesDefaultRail = rightRail === undefined;

  return (
    <div
      className={`relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 ${
        rail ? 'xl:grid-cols-[200px_minmax(0,1fr)_312px]' : ''
      }`}
    >
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-surface-26 md:block"
        aria-hidden
      />

      <aside className="sticky top-24 hidden h-fit bg-background-secondary md:block">
        <LeftRail />
      </aside>

      <main className="min-w-0" data-testid="profile-subpage-main">
        <PageMasthead eyebrow={`@${username}`} title={titles[page]}>
          {/* The way back to the profile. The legacy chrome carried the whole
              identity block for this; a link is enough, and it is the only thing
              from that header a sub-page actually needed. */}
          <BasePathLink
            href={`/@${username}`}
            className="font-semibold text-ink-brand-6 hover:text-ink-brand-4"
            data-testid="profile-subpage-back"
          >
            {t('profile.subpage.back_to_profile')}
          </BasePathLink>
        </PageMasthead>

        {children}
      </main>

      {rail ? <aside className="sticky top-24 hidden h-fit bg-background-secondary xl:block">{rail}</aside> : null}
    </div>
  );
};

export default ProfileSubpageShell;
