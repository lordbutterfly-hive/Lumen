import { redirect } from 'next/navigation';

/**
 * ★ RETIRED (owner ruling, 2026-08-08): "trending hot created muted payout we
 * don't need at all."
 *
 * ★ AND, UNLIKE ITS FOUR SIBLINGS, STILL `/` (2026-08-13, audit §3.1). The
 * other four `/{sort}/my` routes now redirect to `/?tab=feed`, because `/my`
 * names a scope Lumen still has (the accounts you follow) even though the sort
 * is gone. This one does not, and the difference is deliberate: on Hive
 * `/muted` is a list of MUTED posts — content a moderator has hidden — and
 * Lumen has no surface that browses hidden content at all (it collapses muted
 * comments in place, with a reveal, and never lists them). Honouring only the
 * `/my` half would hand the reader a feed of ordinary posts under a URL that
 * asked for muted ones, which is a worse lie than the redirect. There is
 * nowhere honest to send this, so it lands on the home feed like the other
 * retired sorts.

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
  redirect('/');
};

export default Page;
