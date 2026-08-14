import { redirect } from 'next/navigation';

/**
 * ★ RETIRED SORT, SURVIVING SCOPE (owner ruling 2026-08-08; scope restored
 * 2026-08-13, audit §3.1).
 *
 * The owner ruling was about the SORT: "trending hot created muted payout we
 * don't need at all." Lumen has one feed — the ranked home feed — plus topic
 * pages, and these inherited chain-sort pages were a second, competing way to
 * browse that nothing in Lumen's own navigation ever linked to.
 *
 * But `/{sort}/my` carries a SECOND thing the ruling never retired: on Hive,
 * `/my` means "only the accounts I follow". Sending it to plain `/` threw that
 * away silently — the reader asked for their own circle and landed on the
 * global For You feed with nothing to say so, which is exactly what the audit
 * flagged. Lumen HAS that surface: the home feed's "Following" tab
 * (`features/discovery-feed/feed-tabs.tsx`, `?tab=feed`), which reads
 * `/api/lite/feed/following`. So the retired half of the URL is dropped and the
 * surviving half is honoured.
 *
 * A signed-out reader is not silently redirected into an empty list either:
 * that tab renders its own "Following shows the people you follow" prompt with
 * a Log in action, which is an honest empty state rather than a blank feed.
 *
 * `/muted/my` deliberately does NOT do this — see that file.

 * ★ NOTE: THIS FILE IS A BACKSTOP, NOT THE LIVE REDIRECT (2026-08-13). The
 * redirect that actually runs is in `apps/blog/next.config.js` `redirects()`,
 * added 2026-08-12 because `(main-and-community)/loading.tsx` makes this route
 * stream — the 200 is committed before the page component runs, so `redirect()`
 * here degrades to a one-second `<meta http-equiv="refresh">`. Editing only
 * this file changes nothing a visitor can see; the config entry has to change
 * with it. Verified: with `page.tsx` pointing at `/?tab=feed` and the config
 * still on `/`, `curl -I /trending/my` answered `location: /`.
 */
const Page = () => {
  redirect('/?tab=feed');
};

export default Page;
