import { ReactNode } from 'react';
import { Metadata } from 'next';
import { dehydrate, Hydrate } from '@tanstack/react-query';
import { siteConfig } from '@ui/config/site';
import { getQueryClient } from '@/blog/lib/react-query';
import { InitialProfileProvider } from '@/blog/components/observer-provider';
import { getAccountFullCached, primeAccountFullCache } from '@/blog/lib/cached-api';
import { liteAccountAsProfile } from '@/blog/lib/lite/render/lite-account';
import { getAccountFull, getAccountReputations, getDynamicGlobalProperties } from '@transaction/lib/hive-api';
import { getTwitterInfo, isThirdPartyApiEnabled } from '@transaction/lib/custom-api';
import { isValidAccountNameFormat } from '@transaction/lib/validation';
import { isBannedAuthor } from '@/blog/lib/moderation/banned-authors';
import { notFound } from 'next/navigation';
import { getLogger } from '@ui/lib/logging';
import { renderTimer } from '@ui/lib/render-timing';

const logger = getLogger('app');

/**
 * How long the profile layout will wait for its React Query prefetches before
 * sending the page anyway. Originally sized against two real network
 * prefetches this race used to carry — `get_account_reputations` (~362ms) and
 * `get_dynamic_global_properties` (~364ms) against api.hive.blog, in parallel
 * — both removed from the race outright on 2026-09-05 (see the comment above
 * `prefetchPromises`). Left at 400ms rather than retuned down: the only
 * candidate still inside it is the optional Twitter-info fetch below, and a
 * healthy answer still keeps the full hydration benefit while a degraded one
 * still stops costing the reader their first byte.
 */
const PREFETCH_BUDGET_MS = 400;

/** Backoff before the single account-fetch retry. See its call site. */
const RETRY_BACKOFF_MS = 200;

// Matches app/layout.tsx's SITE_DESC — not imported (that constant isn't
// exported) but kept word-for-word so the fallback title/description here
// reads as the same site, not a second one.
// ★ Was Hive's boilerplate, describing Hive (2026-08-18). Kept identical to the
// root layout's string on purpose, so a shared profile or post reads as the same
// site as a shared home page rather than a second one.
const SITE_DESC =
  'A calmer place to read and write. Read what is worth your time. Write without chasing an audience.';

// ★ NEVER `siteConfig.name` HERE (audit item 15). The root layout wraps every
// page's title in `%s - ${siteConfig.name}` ("Lumen"), and a segment that
// hands back the SITE name itself as its own title becomes the %s — "Lumen -
// Lumen" in the tab, observed live while this layout's data was loading. A
// real, if generic, word for what the page IS reads correctly through that
// same template ("Profile - Lumen") and never collides with it.
const FALLBACK_TITLE = 'Profile';

export async function generateMetadata({ params }: { params: { param: string } }): Promise<Metadata> {
  const raw = params.param;
  // Only process if it looks like a username (starts with @ or %40)
  if (!raw.startsWith('@') && !raw.startsWith('%40')) {
    return {
      title: FALLBACK_TITLE,
      description: SITE_DESC
    };
  }
  const username = raw.startsWith('%40') ? raw.replace('%40', '') : raw.replace('@', '');
  // Metadata is generated independently of the layout's 404, so it needs the ban
  // too — otherwise a banned account's `about` text and avatar would still be
  // emitted as the page title, description and OpenGraph image.
  if (isBannedAuthor(username)) {
    return { title: FALLBACK_TITLE, description: SITE_DESC };
  }
  try {
    // Use cached version - deduplicated with Layout's prefetch within the same request
    const account = await getAccountFullCached(username);
    const image = account?.profile?.profile_image || '/lumen/og-plain.png';
    // "on Hive" here is a factual statement about the chain the account lives
    // on (Lumen is a Hive frontend), not a branding mismatch — left as-is.
    const about = account?.profile?.about || `Profile of @${username} on Hive.`;
    // ★ NOT "Blog {username}" ANY MORE (audit item 15). "Blog" was the name of
    // a tab in the legacy two-tab profile header (Blog / Social) that this
    // redesign removed — see the shell's own comment further down this file.
    // The tab is gone; the word describing it stayed behind in every browser
    // tab and share card. `@{username}` is how the product refers to a
    // profile everywhere else (the sub-page shell's eyebrow, bylines, links).
    const title = `@${username}`;
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
      title: FALLBACK_TITLE,
      description: SITE_DESC,
      openGraph: {
        title: FALLBACK_TITLE,
        description: SITE_DESC
      }
    };
  }
}

const Layout = async ({ children, params }: { children: ReactNode; params: { param: string } }) => {
  // ★ RENDER TIMING, OFF UNLESS `LUMEN_RENDER_TIMING=yes` (2026-09-05). The
  // profile is our slowest route and every number we had for it came from the
  // outside (curl TTFB), which cannot say WHICH await cost the second. See
  // `@ui/lib/render-timing`. A `notFound()` below throws, so a 404 render simply
  // emits no line -- the timer never changes control flow to get one.
  const timer = renderTimer('profile-layout');
  // ★ EVERY 404 PATH REPORTS TOO (2026-09-05, review). `notFound()` THROWS, so
  // the `timer.done()` at the bottom of this function is unreachable on all
  // four of them -- including the most expensive render in the file, the
  // account read that failed, backed off RETRY_BACKOFF_MS and retried before
  // giving up. That is precisely the path a timing instrument must not be blind
  // to. This emits the line and then throws exactly as before, so the timer
  // still cannot change control flow; it just stops missing the slow exits.
  const bail = (outcome: string, user: string): never => {
    timer.done({ user, outcome });
    notFound();
  };
  const queryClient = getQueryClient();
  const { param } = params;

  // Only process if it looks like a username (starts with @ or %40)
  if (!param.startsWith('@') && !param.startsWith('%40')) {
    bail('not-an-account', param);
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
    bail('banned', username);
  }

  // Layer 1: Format validation (cheap, WASM-based, no API call)
  const validFormat = await isValidAccountNameFormat(username);
  timer.mark('valid');
  if (!validFormat) {
    bail('invalid-name', username);
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
    // Backoff before the retry, trimmed from 600ms (2026-08-12). The retry
    // itself is load-bearing and stays — it fixes a real reported bug where a
    // tab errored once and worked on a second visit. But this sits directly in
    // TTFB whenever the first call fails, and the original 600ms was a round
    // number rather than a measured one. A retry that bypasses the request
    // cache opens a fresh connection, which is what actually recovers a
    // transient failure; the pause only needs to be long enough not to arrive
    // inside the same blip.
    await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
    // ★ WRITE THROUGH ON SUCCESS (2026-09-05, perf batch C-A). This retry used
    // to hand its answer straight to THIS page and nowhere else -- every other
    // reader who landed in the same 30s window (the exact scenario that put
    // them here: a burst hitting a rate-limited node) paid the identical
    // failed-then-retried round trip again, one at a time, for as long as the
    // burst lasted. `primeAccountFullCache` deposits a successful retry into
    // the same 30s store `getAccountFullCached` reads from, under its own
    // `ttlFor`/`staleWhileRevalidateMs` rules (see that function's and
    // `server-ttl-cache.ts`'s `.set` doc comments) -- only on success, so a
    // retry that fails too still writes nothing and this page still 404s via
    // the lite-account fallback below exactly as before.
    return getAccountFull(username)
      .then((result) => {
        primeAccountFullCache(username, result);
        return result;
      })
      .catch(() => null);
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
    // The slow one: this is reached only after the failed read, the backoff and
    // the retry, so its timing line is the one worth having.
    timer.mark('account');
    bail('no-account', username);
  }
  // Covers the cached read, its one retry (RETRY_BACKOFF_MS included) and the
  // lite-account fallback -- i.e. everything it took to have an account.
  timer.mark('account');

  try {
    const prefetchPromises = [
      // Seed React Query cache with already-fetched account data (no extra API call)
      queryClient.prefetchQuery({
        queryKey: ['profileData', username],
        queryFn: () => account
      })
    ];

    // ★ accountReputationData / dynamicGlobalData REMOVED FROM THIS PREFETCH
    // (2026-09-05, TTFB perf pass). Both used to be awaited in the race below,
    // each adding a real ~360ms network call (`get_account_reputations` /
    // `get_dynamic_global_properties` against api.hive.blog) to TTFB, to seed
    // caches that turned out not to need seeding:
    //   - `accountReputationData` had NO reader anywhere in the app (grepped
    //     the whole frontend for the query key and for `getAccountReputationsCached`
    //     — this prefetch call was its only reference). Reputation already
    //     renders from `account.reputation`: `getAccountFull`/`getProfileInfo`
    //     attach it from the same `bridge.get_profile` call this layout already
    //     awaits above (`@transaction/lib/hive-api.ts`), and `ProfileMain`
    //     already hands it down as `reputation={profileData.reputation}` (see
    //     `features/account-profile/redesign/profile-main.tsx`). This was a
    //     second `bridge.get_profile`-shaped round trip for a value the layout
    //     already had.
    //   - `dynamicGlobalData` DOES have readers (`ProfileMain`'s optional HP
    //     figure, `popover-card-data`'s post hover cards) but neither needs it
    //     for first paint: both read it via a plain `useQuery` with no
    //     `initialData` and no dependency gating the profile header's render,
    //     and `ProfileMain`'s own 2026-09-03 comment already establishes that
    //     this query "must NOT gate the page" (it only fills in the HP line a
    //     beat later, same as `hpFigures` below it). The client now fetches it
    //     post-hydration through the identical `['dynamicGlobalData']` key
    //     instead of the layout prefetching and dehydrating it.

    // Only prefetch Twitter data if third-party APIs are enabled
    if (isThirdPartyApiEnabled()) {
      prefetchPromises.push(
        queryClient.prefetchQuery({
          queryKey: ['twitterData', username],
          queryFn: () => getTwitterInfo(username)
        })
      );
    }

    // ★★★ PREFETCHING MUST NOT HOLD THE PAGE HOSTAGE (2026-08-12).
    //
    // This was a bare `await Promise.all(...)`, so the profile page could not
    // send its first byte until every prefetch had answered. Measured against
    // the real chain API: `get_account_reputations` ~362ms and
    // `get_dynamic_global_properties` ~364ms, neither cached, both on every
    // profile view. They ran in parallel, so together they added roughly
    // 360ms to a ~560ms TTFB — the majority of it, on the slowest server
    // route we have. (Both calls were removed from this race outright on
    // 2026-09-05 — see the comment above `prefetchPromises` — so today this
    // budget guards only the optional Twitter-info fetch below; the
    // race/budget mechanism itself stays, since a slow or misbehaving third
    // party must never hold TTFB hostage either.)
    //
    // The prefetch is an OPTIMISATION, not a requirement: its only job is to
    // seed the React Query cache so the browser does not refetch. Every one of
    // these queries already has a client-side path that fetches if the
    // dehydrated state lacks it. So the correct shape is "take the benefit if
    // it is cheap, never pay more than a budget for it".
    //
    // Whatever has resolved when the budget expires still gets dehydrated —
    // `dehydrate()` reads whatever is in the cache at that moment — so a fast
    // prefetch keeps its full benefit and a slow one simply stops being the
    // reader's problem. This can therefore never be slower than the old
    // behaviour, and never leaves the client with less than it fetches anyway.
    //
    // ★ Deliberately NOT cancelling the in-flight prefetches on timeout: they
    // are already in the request's memoized cache, and letting them finish
    // costs nothing the reader waits for.
    await Promise.race([
      Promise.allSettled(prefetchPromises),
      new Promise((resolve) => setTimeout(resolve, PREFETCH_BUDGET_MS))
    ]);
  } catch (error) {
    logger.error(error, 'Error in Layout:');
  }
  timer.mark('prefetch');
  const dehydratedState = dehydrate(queryClient);
  queryClient.clear();

  // ★★★ NO CHROME HERE, AND THAT IS THE FIX (2026-08-10, fuckery list L-3).
  //
  // This layout used to wrap every child in `ProfileChromeSwitch`, which read
  // `usePathname()` and rendered the legacy `ProfileLayout` — dark-navy cover,
  // translucent card, slate "Blog / Social" tab bar, four moderation links next
  // to the follower stats — on every path EXCEPT the exact string `/@username`.
  // The result was two complete profile implementations living in one URL space:
  // the redesigned Lumen profile at `/@username`, the old product one route
  // sideways at `/@username/settings` (or /followers, /communities, any list),
  // still calling itself the profile and still carrying a "Blog" tab that took
  // you back to the other one.
  //
  // The chrome now belongs to the ROUTE, not to a client-side string comparison:
  // `/@username` renders the redesigned profile (page.tsx -> ProfileGrid, which
  // brings its own shell) and each sub-route mounts
  // `features/layouts/user-profile/profile-subpage-shell` from its own
  // layout.tsx. A route can no longer render a chrome that is not its own, and
  // there is no second profile left to reach.
  // ★ SEED ProfileMain's account through context, not just Hydrate (2026-09-03).
  // Hydrate does not populate a client component's useQuery during App Router
  // SSR (see observer-provider.tsx), so ProfileMain gated the whole profile
  // behind "Loading profile" on every server render. Passing the account we
  // already resolved above lets its ['profileData'] query have initialData on
  // the server, so identity and the Posts tab actually server-render.
  timer.done({ user: username, outcome: 'ok' });
  return (
    <Hydrate state={dehydratedState}>
      <InitialProfileProvider value={account}>{children}</InitialProfileProvider>
    </Hydrate>
  );
};

export default Layout;
