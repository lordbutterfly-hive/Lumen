import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getUnreadNotifications } from '@transaction/lib/bridge-api';

const logger = getLogger('app');

/**
 * ★★★ WHY THIS ROUTE EXISTS, AND THE RULE IT IS AN INSTANCE OF.
 *
 * `features/layouts/app-header.tsx` (the header bell, mounted on EVERY page)
 * called `getUnreadNotifications` in the browser. That reaches `getChain()`,
 * and **`getChain()` instantiates `@hiveio/wax` at runtime — which fetches
 * `wax.common.wasm`, 2.34 MB.**
 *
 * ★ THE LESSON, because it invalidated a whole day of reasoning: this is NOT an
 * import-hygiene problem. A prior pass converted wax imports to `type`-only and
 * dynamic `await import()`, which shrinks the JS chunk but does nothing about
 * the WASM — the binary is fetched when the chain client is CONSTRUCTED, not
 * when the module is imported. So the real rule is simply:
 *
 *     ANY chain call from the browser downloads 2.34 MB of WASM.
 *
 * The bell's query is `enabled: isChainAccount`, so an anonymous visitor never
 * ran it — which is exactly why an anonymous-only measurement showed the home
 * page "fixed" while every signed-in Hive reader still paid the full 2.34 MB on
 * every page. Found by an adversarial review that measured signed IN.
 *
 * Keeping the call on the server is the same fix already applied to
 * `/api/discussion`, `/api/account-posts` and `/api/trending-tags`.
 *
 * ★ NOT CACHED, deliberately, and NOT `public`. This is per-reader data. It is
 * also why this route must never grow a `public` cache-control header: a shared
 * cache would hand one reader's unread state to another. (The sibling
 * `/api/trending-tags` IS publicly cached precisely because it is global — and
 * it had to be excluded from `middleware.ts`'s matcher so its cached response
 * could not carry a `Set-Cookie`. This route needs no such exclusion because it
 * is not shared-cacheable at all.)
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const account = (req.nextUrl.searchParams.get('account') ?? '').trim().toLowerCase();
  // Shape check only: this value is handed to a JSON-RPC parameter, there is
  // nothing here to inject into. Same reasoning as `/api/account-posts`.
  if (!/^[a-z0-9][a-z0-9.-]{1,31}$/.test(account)) {
    return NextResponse.json({ error: 'account_required' }, { status: 400 });
  }
  try {
    const unread = await getUnreadNotifications(account);
    return NextResponse.json(unread, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    // ★ THERE IS A THIRD ANSWER, AND IT IS NOT A FAILURE (2026-08-15).
    //
    // The note below is right that "no notifications" and "we could not ask"
    // must not be collapsed. But a LITE account is neither: it has no Hive
    // account at all, so `bridge.unread_notifications` asserts
    // `Account <name> does not exist`. That is a definite, correct zero — the
    // question does not apply — and answering 502 turned it into a red failed
    // request on every signed-in page for the entire lite cohort.
    //
    // Matched on the assertion text rather than on the session, because this
    // route is given an account name and never sees who is asking. Anything
    // else still 502s, so a genuinely broken chain is still loud.
    const message = error instanceof Error ? error.message : String(error);
    if (/Account .* does not exist/i.test(message)) {
      logger.info('unread notifications: %s has no chain account (lite) — answering zero', account);
      return NextResponse.json(
        { unread: 0, lastread: null },
        { headers: { 'cache-control': 'private, no-store' } }
      );
    }
    logger.error(error, 'unread notifications lookup failed for %s', account);
    // A real status rather than an empty 200: "no notifications" and "we could
    // not ask" are different answers, and this codebase has repeatedly been
    // bitten by collapsing the second into the first.
    return NextResponse.json({ error: 'unread_unavailable' }, { status: 502 });
  }
}
