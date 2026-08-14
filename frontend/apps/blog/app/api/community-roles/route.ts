import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getListCommunityRoles } from '@transaction/lib/bridge-api';
import { cachedRead } from '@/blog/lib/server-read-cache';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `getListCommunityRoles` was called directly
 * in the browser from `app/[param]/[p2]/[permlink]/content.tsx` (the post-
 * permalink page — the single highest-traffic route in the app, both
 * `enabled` unconditionally for any post inside a community, no SSR
 * `initialData`) and again from `app/(main-and-community)/roles/[tag]/
 * content.tsx` under a DIFFERENT query key than its own page.tsx's SSR
 * prefetch (`rolesList` vs `community`), so that SSR fetch was always
 * discarded and the client always re-fetched from scratch. Both reach
 * `getChain()` and download `wax.common.wasm`. (That dead SSR prefetch is
 * gone as of 2026-08-13 — see `roles/[tag]/page.tsx`.)
 *
 * ★★★ 2026-08-13, three changes, all measured.
 *
 * 1. **MEMOISED SERVER-SIDE.** It was `private, no-store` with no memo, so it
 *    cost a flat 131-482ms on EVERY community post page and every visit to
 *    `/roles/[tag]`. Community roles are PUBLIC chain state keyed by community
 *    alone — identical bytes whoever asks — so one process-wide read serves
 *    every reader. Same `cachedRead` the account/manabar routes use.
 *
 * 2. **THE 50-ROW CAP IS GONE.** `bridge.list_community_roles` defaults to 50
 *    rows and this never passed a `limit`. Measured against api.hive.blog:
 *    `hive-141359` has **593** role rows, of which 50 were reaching the app.
 *    The rows come back sorted by role rank first (owner, then admin/mod, then
 *    member, then muted), so the moderator check below happened to survive the
 *    truncation for that community — but only by luck of ordering, and any
 *    community with more than 50 privileged accounts would have silently
 *    stopped showing its own moderators their tools. Asking for the whole list
 *    removes the luck. Upstream caps itself (the same call with `limit: 1000`
 *    returned 72 rows for `hive-139531` — all of them), so this is a ceiling,
 *    not a page size. The `limit` parameter itself had to be added to
 *    `getListCommunityRoles` — see that function for why the wax type does not
 *    declare it.
 *
 * 3. **`?account=` ANSWERS THE ONE QUESTION THE POST PAGE ACTUALLY ASKS.** The
 *    post page does not render this list; it reduces it to a single boolean
 *    ("may this viewer moderate here"). Shipping 593 rows to a browser to
 *    compute one boolean is the wasteful half of this route. With `account`
 *    set, the reduction happens here and the response is one small object.
 *    `/roles/[tag]`, which really does render the table, still gets the list.
 *
 * ★ NOT the badge. An earlier reading of the 2026-08-13 browser audit had this
 * route feeding the community-title badge next to an author's name. It does
 * not, and never has: every badge on a post page reads `author_title` off the
 * post/comment object from `/api/discussion` (see `content.tsx` and
 * `features/post-rendering/comment-list-item.tsx`). This route's only consumers
 * are the moderator check and the `/roles/[tag]` table.
 */

/** Public chain state, and roles change on a human timescale, not per block. */
const ROLES_CACHE_MS = 60_000;

/** Ceiling, not a page size — see note 2 above. */
const ROLES_LIMIT = 1000;

const HIVE_ACCOUNT_NAME = /^[a-z][a-z0-9.-]{2,15}$/;

function readRoles(community: string): Promise<string[][] | null> {
  return cachedRead(`communityRoles:${community}`, ROLES_CACHE_MS, () =>
    getListCommunityRoles(community, ROLES_LIMIT)
  );
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const community = (req.nextUrl.searchParams.get('community') ?? '').trim();
  if (!community) {
    return NextResponse.json({ error: 'community_required' }, { status: 400 });
  }
  const account = (req.nextUrl.searchParams.get('account') ?? '').trim().toLowerCase();
  if (account && !HIVE_ACCOUNT_NAME.test(account)) {
    return NextResponse.json({ error: 'account_invalid' }, { status: 400 });
  }
  try {
    const roles = await readRoles(community);
    if (account) {
      const row = roles?.find((e) => e[0] === account) ?? null;
      // Named fields, not the raw `[account, role, title]` tuple: the tuple's
      // shape is an upstream detail and this variant exists precisely so no
      // caller has to know it.
      return NextResponse.json(
        { account, role: row?.[1] ?? null, title: row?.[2] ?? null },
        // Depends on WHO is asking, so it never enters a shared cache — the
        // server memo above is where the sharing happens, keyed by community.
        { headers: { 'cache-control': 'private, no-store' } }
      );
    }
    return NextResponse.json(roles, {
      // The full list is the same bytes for every reader (the request carries no
      // identity), so unlike the `account` variant it is safe to cache in the
      // browser and in any shared proxy.
      //
      // ★ IT IS NOT ACTUALLY CACHED TODAY, AND THAT IS DELIBERATE. `middleware.ts`
      // runs before this handler, attaches `Set-Cookie`, and sets its own
      // `private, no-store`; both directives end up on the response and `no-store`
      // wins. That file's standing rule is that a `public` route must be excluded
      // from its `matcher` — a decision that belongs to `middleware.ts`, so it is
      // not taken from here. The measured win (**131ms -> 4ms**, verified on
      // :3600 vs :3000) comes entirely from the server memo above; this header is
      // the route's statement of what it would permit, not a claim about today.
      headers: { 'cache-control': 'public, max-age=60, stale-while-revalidate=300' }
    });
  } catch (error) {
    logger.error(error, 'community roles lookup failed for %s', community);
    return NextResponse.json({ error: 'community_roles_unavailable' }, { status: 502 });
  }
}
