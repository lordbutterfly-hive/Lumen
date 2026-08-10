import ProfileChromeSwitch from '@/blog/features/account-profile/redesign/profile-chrome-switch';
import { ReactNode } from 'react';
import { Metadata } from 'next';
import { dehydrate, Hydrate } from '@tanstack/react-query';
import { siteConfig } from '@ui/config/site';
import { getQueryClient } from '@/blog/lib/react-query';
import { getAccountFullCached } from '@/blog/lib/cached-api';
import { liteAccountAsProfile } from '@/blog/lib/lite/render/lite-account';
import { getAccountFull, getAccountReputations, getDynamicGlobalProperties } from '@transaction/lib/hive-api';
import { getTwitterInfo, isThirdPartyApiEnabled } from '@transaction/lib/custom-api';
import { isValidAccountNameFormat } from '@transaction/lib/validation';
import { isBannedAuthor } from '@/blog/lib/moderation/banned-authors';
import { notFound } from 'next/navigation';
import { getLogger } from '@ui/lib/logging';

const logger = getLogger('app');

// Matches app/layout.tsx's SITE_DESC — not imported (that constant isn't
// exported) but kept word-for-word so the fallback title/description here
// reads as the same site, not a second one.
const SITE_DESC =
  'Communities without borders. A social network owned and operated by its users, powered by Hive.';

export async function generateMetadata({ params }: { params: { param: string } }): Promise<Metadata> {
  const raw = params.param;
  // Only process if it looks like a username (starts with @ or %40)
  if (!raw.startsWith('@') && !raw.startsWith('%40')) {
    return {
      title: siteConfig.name,
      description: SITE_DESC
    };
  }
  const username = raw.startsWith('%40') ? raw.replace('%40', '') : raw.replace('@', '');
  // Metadata is generated independently of the layout's 404, so it needs the ban
  // too — otherwise a banned account's `about` text and avatar would still be
  // emitted as the page title, description and OpenGraph image.
  if (isBannedAuthor(username)) {
    return { title: siteConfig.name, description: SITE_DESC };
  }
  try {
    // Use cached version - deduplicated with Layout's prefetch within the same request
    const account = await getAccountFullCached(username);
    const image = account?.profile?.profile_image || 'https://hive.blog/images/hive-blog-share.png';
    // "on Hive" here is a factual statement about the chain the account lives
    // on (Lumen is a Hive frontend), not a branding mismatch — left as-is.
    const about = account?.profile?.about || `Profile of @${username} on Hive.`;
    const title = `Blog ${username}`;
    return {
      title: {
        default: title,
        template: `%s - ${siteConfig.name}`
      },
      description: about,
      openGraph: {
        title,
        description: about,
        images: [image]
      },
      twitter: {
        card: 'summary_large_image',
        title,
        description: about,
        images: [image]
      }
    };
  } catch (error) {
    logger.error(error, 'Error in generateMetadata:');
    return {
      title: siteConfig.name,
      description: SITE_DESC,
      openGraph: {
        title: siteConfig.name,
        description: SITE_DESC
      }
    };
  }
}

const Layout = async ({ children, params }: { children: ReactNode; params: { param: string } }) => {
  const queryClient = getQueryClient();
  const { param } = params;

  // Only process if it looks like a username (starts with @ or %40)
  if (!param.startsWith('@') && !param.startsWith('%40')) {
    notFound();
  }

  const username = param.startsWith('%40') ? param.replace('%40', '') : param.replace('@', '');

  // ★ GLOBAL AUTHOR BAN — the profile, and everything hanging off it.
  //
  // This is the LAYOUT, deliberately, because a profile is nine routes, not one:
  // the posts tab, comments, communities, followers, followed, the four list
  // pages and settings all render inside it. Gating here 404s every one of them
  // together, and no future profile sub-route can be added that quietly forgets
  // the check. It also runs BEFORE the chain lookup, so a banned account costs
  // nothing upstream and its avatar, bio and follower counts are never fetched,
  // let alone serialised into the page.
  //
  // Note this also covers `generateMetadata` above in practice: a 404 layout
  // renders the not-found page, so no OpenGraph card is ever produced for him
  // and Lumen links to him stop generating share previews.
  if (isBannedAuthor(username)) {
    notFound();
  }

  // Layer 1: Format validation (cheap, WASM-based, no API call)
  const validFormat = await isValidAccountNameFormat(username);
  if (!validFormat) {
    notFound();
  }

  // Layer 2: Existence check (API call) - fixes 500 for nonexistent users
  // Uses getAccountFullCached for request-level dedup with generateMetadata
  //
  // ★★★ A RATE-LIMITED CHAIN CALL IS NOT "THIS ACCOUNT DOESN'T EXIST".
  //
  // Reproduced live (2026-08-08): under concurrent traffic on this shared box,
  // api.hive.blog answers database_api.find_accounts with HTTP 429 ("Received
  // malformed JSON while requesting given resource... #429" in the server log).
  // That rejection used to fall straight through to the lite-account fallback
  // below, which has nothing for a real Hive handle either, so the profile
  // 404'd for an account that plainly exists — "Page Not Found" on
  // /@blocktrades. Load again a moment later, once the burst has passed, and
  // it works: exactly the report's "opening Comments showed an error, going
  // back in a second time it worked" (this gate runs before ANY tab renders,
  // so every tab is equally exposed, not just Comments).
  //
  // getAccountFullCached is request-memoized (React cache()), so calling it a
  // second time here would just replay the same already-rejected promise —
  // the retry has to bypass the cache and go through the plain getAccountFull.
  let account = await getAccountFullCached(username).catch(async (error) => {
    logger.error(error, 'getAccountFullCached failed; retrying once before treating as not-found');
    await new Promise((resolve) => setTimeout(resolve, 600));
    return getAccountFull(username).catch(() => null);
  });

  // Lumen lite account fallback. A lite user has no Hive account until they upgrade,
  // so this lookup fails and the page 404'd — meaning a lite user could not view their
  // own profile, and everything that hangs off a profile (Follow, post list) was
  // unreachable. Serve a profile built from what we know, with every chain-shaped
  // figure zeroed rather than invented.
  if (!account || !account.name) {
    account = await liteAccountAsProfile(username);
  }
  if (!account || !account.name) {
    notFound();
  }

  try {
    const prefetchPromises = [
      // Seed React Query cache with already-fetched account data (no extra API call)
      queryClient.prefetchQuery({
        queryKey: ['profileData', username],
        queryFn: () => account
      }),
      queryClient.prefetchQuery({
        queryKey: ['accountReputationData', username],
        queryFn: () => getAccountReputations(username, 1)
      }),
      queryClient.prefetchQuery({
        queryKey: ['dynamicGlobalData'],
        queryFn: () => getDynamicGlobalProperties()
      })
    ];

    // Only prefetch Twitter data if third-party APIs are enabled
    if (isThirdPartyApiEnabled()) {
      prefetchPromises.push(
        queryClient.prefetchQuery({
          queryKey: ['twitterData', username],
          queryFn: () => getTwitterInfo(username)
        })
      );
    }

    await Promise.all(prefetchPromises);
  } catch (error) {
    logger.error(error, 'Error in Layout:');
  }
  const dehydratedState = dehydrate(queryClient);
  queryClient.clear();
  return (
    <Hydrate state={dehydratedState}>
      <ProfileChromeSwitch>{children}</ProfileChromeSwitch>
    </Hydrate>
  );
};

export default Layout;
