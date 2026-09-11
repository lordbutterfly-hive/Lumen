import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { ensureSquatterList, isSquatterName } from '@/blog/lib/lite/moderation/squatter-list';
import { liteAccountAsProfile } from '@/blog/lib/lite/render/lite-account';
import { getAccountFull } from '@transaction/lib/hive-api';
import { cachedRead } from '@/blog/lib/server-read-cache';

const logger = getLogger('app');

/**
 * ★ SAME RULE AS `/api/notifications/unread`: `getAccountFull` reaches
 * `getChain()`, which INSTANTIATES `@hiveio/wax` and fetches `wax.common.wasm`
 * (2.34 MB) the moment it is called — regardless of what the caller does with
 * the result.
 *
 * This is the single most widely-shared chain read in the app: the global
 * `LoggedUserProvider` (features/votes/hooks/use-logged-user.tsx) called it
 * for every signed-in reader on every page to build the header's manabar
 * rings, and `components/hooks/use-account.ts` called it a second time from
 * every author hover-card, profile page and settings form. Both now fetch
 * this route instead.
 *
 * ★ NOT CACHED. `getAccountFull` folds in balances and `voting_manabar` /
 * `downvote_manabar`, which change with every vote and every block — a
 * shared cache serving one reader's fresher balance to another (or serving a
 * stale one) is a worse trade than one extra request per lookup. See
 * `/api/notifications/unread` for why `private, no-store` rather than
 * `public` is the safe default for a per-account read like this.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const username = (req.nextUrl.searchParams.get('username') ?? '').trim().toLowerCase();
  // Shape check only: handed to a JSON-RPC parameter, nothing here to inject into.
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(username)) {
    return NextResponse.json({ error: 'username_required' }, { status: 400 });
  }
  /**
   * ★★★ A SQUATTED NAME RESOLVES TO THE LUMEN ACCOUNT THAT HAD IT FIRST (2026-09-10).
   *
   * This route is why fixing the profile LAYOUT alone was not enough, and it was
   * caught in local verification before ship. `ProfileMain` seeds from the layout's
   * SSR account but immediately revalidates through here (`initialDataUpdatedAt: 0`),
   * so the chain account overwrote the lite one on hydration -- the page server-rendered
   * as the rightful Lumen owner and then visibly became the squatter's Hive account.
   * One choke point, every client.
   */
  await ensureSquatterList();
  if (isSquatterName(username)) {
    const lite = await liteAccountAsProfile(username).catch(() => null);
    if (lite) {
      return NextResponse.json(lite, { headers: { 'cache-control': 'private, no-store' } });
    }
    // Flagged, but no Lumen account to hand the name back to: refuse rather than
    // serve the account this list exists to hide.
    return NextResponse.json({ error: 'account_unavailable' }, { status: 404, headers: { 'cache-control': 'private, no-store' } });
  }

  try {
    // ★ 5s SERVER-SIDE MEMO (2026-08-13) — the wire contract above is unchanged.
    // Measured: 933ms on Home, 912ms on a topic page, 1,145ms on /@ecency, and a
    // profile view asks twice. `getAccountFull(username)` is public chain state for
    // that one account, identical whoever asks, so memoising it per username leaks
    // nothing between readers; see lib/server-read-cache.ts. 5s is under two Hive
    // blocks. RAISED 5s -> 15s after measuring: at 5s the memo expired between page
    // navigations, so every page still paid the cold ~700-900ms. 15s covers a reader
    // clicking through several pages; balances shown in the header can be five blocks
    // behind, which is invisible next to the second it was costing on every route.
    const account = await cachedRead(`account:${username}`, 15_000, () => getAccountFull(username));

    /**
     * ★★★ AN ORDINARY LITE ACCOUNT IS NOT A MISSING ACCOUNT (2026-09-11).
     *
     * The squatter branch above was the ONLY lite fallback this route had, so a lite
     * user whose name nobody has contested fell through to here — and
     * `getAccountFull` does not throw for a name the chain has never heard of. It
     * spreads `getAccounts([name])[0]`, which is `undefined`, so `{...undefined}`
     * serialises to `{}` and this route answered **HTTP 200 with an empty object**.
     *
     * `{}` is truthy, so nothing downstream rejected it. `ProfileMain` seeds the
     * layout's correct lite account and then revalidates through here with
     * `initialDataUpdatedAt: 0` (i.e. immediately), so the correct profile was
     * server-rendered and then overwritten by `{}` on hydration: name, join date,
     * follower and post counts all became `undefined`, and the Posts tab fell to the
     * chain error state. Measured on production 2026-09-11 for `@arsha` and
     * `@menosoft`, and reproduced locally against a seeded lite row.
     *
     * The profile LAYOUT has had this exact fallback since lite profiles existed
     * (`app/[param]/(user-profile)/layout.tsx`, `!account || !account.name`); this
     * route is the client half of the same question and simply never got it. Same
     * predicate, same resolver, deliberately word-for-word, so the two halves cannot
     * drift again.
     */
    if (!account || !account.name) {
      const lite = await liteAccountAsProfile(username).catch((error) => {
        logger.warn(error, 'account: lite fallback failed for %s', username);
        return null;
      });
      if (lite) {
        return NextResponse.json(lite, { headers: { 'cache-control': 'private, no-store' } });
      }
    }

    // Neither on chain nor in Lumen. Returned UNCHANGED (200, whatever
    // `getAccountFull` produced) rather than upgraded to a 404: `fetchJson` throws on
    // any non-2xx, so turning this into an error status would be a wire-contract
    // change for every existing caller, which is not what this fix is for.
    return NextResponse.json(account, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'account lookup failed for %s', username);
    // 503, not 502 (2026-09-05): Cloudflare replaces an origin 502/504 body with
    // its own error page, so the code below never reached a browser through the
    // edge. Readers of this route key on the failure (`fetchJson` throws on any
    // non-2xx), never on the status number.
    return NextResponse.json(
      { error: 'account_unavailable' },
      { status: 503, headers: { 'cache-control': 'private, no-store', 'retry-after': '10' } }
    );
  }
}
