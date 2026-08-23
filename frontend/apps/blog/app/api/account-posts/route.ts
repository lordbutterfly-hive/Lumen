import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import type { Entry } from '@hive/common-hiveio-packages/wax';
import { getAccountPostsPage, DATA_LIMIT } from '@transaction/lib/bridge-api';
import { withRetry } from '@transaction/lib/retry';
import { attachLiteIdentities } from '@/blog/lib/lite/render/attach-lite';
import {
  applyOwnerBlocksToAuthoredEntries,
  filterBlockedForViewer,
  viewerBlockedKeySet
} from '@/blog/lib/lite/social/block-filter';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { mergeLumenEngagement } from '@/blog/lib/lite/repositories/engagement-repository';

const logger = getLogger('app');

/** Same reasoning as `/api/discussion`'s `AUTHOR_SHAPE`: a Hive account/handle
 *  shape check, not a WASM round trip through `isUsernameValid`, because this
 *  value is only ever handed to a JSON-RPC parameter -- there is nothing here
 *  to inject into. */
const AUTHOR_SHAPE = /^[a-z0-9][a-z0-9.-]{1,31}$/;

/** What `getAccountPosts` accepts. An allow-list rather than passthrough,
 *  because unlike the hardcoded call sites elsewhere in the app, this value
 *  now arrives as a browser-controlled query parameter. */
const ALLOWED_SORTS = new Set(['blog', 'posts', 'feed', 'replies', 'comments', 'payout']);

/** Loose on purpose -- this is a PAGINATION CURSOR (a prior page's own
 *  `author`/`permlink`), not a permlink being created, and real Hive
 *  permlinks contain dots, underscores and uppercase that a slug-style regex
 *  would reject. Only rejects what truly cannot be a permlink: empty,
 *  over-long, or carrying whitespace (which no real permlink does and which
 *  would mean the value was never a genuine cursor to begin with). */
function isReferenceablePermlink(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/\s/.test(value);
}

/**
 * ★★★ GET /api/account-posts?sort=&account=&observer=&start_author=&
 * start_permlink=&limit= -- ONE HIVE ACCOUNT'S OWN POSTS/COMMENTS, SERVED BY US.
 *
 * WHY THIS ROUTE HAD TO EXIST. The profile Posts/Comments tabs called
 * `getAccountPosts` from `@transaction/lib/bridge-api` DIRECTLY IN THE
 * BROWSER -- a straight read from a Hive node with nothing Lumen-specific
 * applied beyond the global ban list. For the Posts tab that is harmless: a
 * root post carries no `parent_author`, so there is nothing to hide. For the
 * COMMENTS tab it defeats effect (B) outright: block a spammer and their
 * replies vanish from the THREAD (both `/api/discussion` and
 * `/api/lite/posts/replies` already filter those), and yet the exact same
 * text stays live and public on the spammer's own profile Comments tab,
 * forever, for any third party who follows a link there. The account that was
 * blocked loses nothing by the block -- they can still point people at their
 * profile to read what the blocker asked never to be served again.
 *
 * A rule enforced only in the reader's browser is enforced by exactly the
 * people it is meant to constrain (same reasoning as `/api/discussion`), so
 * this now runs here, where the block list lives and never leaves.
 *
 * `applyOwnerBlocksToAuthoredEntries` is the ONE-HOP version of effect (B) --
 * see its doc comment in `block-filter.ts` for why a profile tab cannot afford
 * the full-ancestry walk `applyOwnerBlocksToThread` does, and what that
 * trades away. It is cheap to run unconditionally: a root post (`sort:
 * 'posts'`/`'blog'`/`'feed'`) carries no `parent_author`, so the filter is a
 * no-op for every query type except `'comments'`/`'replies'` and costs
 * nothing beyond one array scan to find that out.
 *
 * Response shape is deliberately close to what `getAccountPosts` itself
 * returned -- `{ entries: Entry[] }`, now always an array, never `null` -- so
 * `posts-content.tsx` and the redesigned profile's `useAccountEntries` hook
 * change only WHERE they fetch from, not how they read the answer.
 *
 * ★★★ `entries: null` USED TO MEAN TWO DIFFERENT THINGS (2026-08-13 fix,
 * O4-stuck-states.md item 4). `getAccountPosts(...).catch(() => null)` below
 * flattened EVERY rejection -- account does not exist, node timeout, transport
 * failure -- into the exact same `{ entries: null }` a genuinely-empty upstream
 * response produced, with no flag to tell them apart. The caller
 * (`account-posts-fetch.ts`) read that as "no posts" and rendered "@user hasn't
 * posted yet" -- a confident false claim on a read that never actually
 * happened. Now a failed read answers `{ entries: [], degraded:
 * 'upstream_empty' }` (the same shape the outer catch below already used, and
 * the same convention `/api/discussion` uses for its own early-return branch),
 * and `account-posts-fetch.ts` throws on that flag so the honest `<NoDataError
 * />` branch every consumer already has (`posts-content.tsx:98`,
 * `feed-tabs.tsx`'s `EntryFeed`, `profile-posts-list.tsx`,
 * `profile-comments-list.tsx` -- all confirmed wired) is actually reached. A
 * genuinely empty account still answers bare `{ entries: [] }`, no `degraded`
 * key, so "no posts yet" stays reachable too.
 *
 * ★ THERE IS A SECOND WAY TO GET A FALSE EMPTY, AND IT IS CLOSED TOO
 * (2026-08-13, adversarial review S2): `degraded: 'block_filter_unresolved'`.
 * The upstream read can succeed perfectly and the LUMEN read fail, in which case
 * the owner-block filter withholds every entry it could not vouch for and
 * returns an empty list without raising anything. See the call site below.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const sort = (req.nextUrl.searchParams.get('sort') ?? '').trim();
  const account = (req.nextUrl.searchParams.get('account') ?? '').trim().replace(/^@/, '');
  const observer = (req.nextUrl.searchParams.get('observer') ?? '').trim().replace(/^@/, '');
  const startAuthor = (req.nextUrl.searchParams.get('start_author') ?? '').trim().replace(/^@/, '');
  const startPermlink = (req.nextUrl.searchParams.get('start_permlink') ?? '').trim();
  const limitParam = Number(req.nextUrl.searchParams.get('limit'));

  if (!sort || !account) {
    return NextResponse.json({ error: 'sort_and_account_required' }, { status: 400 });
  }
  if (!ALLOWED_SORTS.has(sort)) {
    return NextResponse.json({ error: 'invalid_sort' }, { status: 400 });
  }
  if (!AUTHOR_SHAPE.test(account.toLowerCase())) {
    return NextResponse.json({ error: 'invalid_account' }, { status: 400 });
  }
  if (observer && !AUTHOR_SHAPE.test(observer.toLowerCase())) {
    return NextResponse.json({ error: 'invalid_observer' }, { status: 400 });
  }
  if (startAuthor && !AUTHOR_SHAPE.test(startAuthor.toLowerCase())) {
    return NextResponse.json({ error: 'invalid_start_author' }, { status: 400 });
  }
  if (startPermlink && !isReferenceablePermlink(startPermlink)) {
    return NextResponse.json({ error: 'invalid_start_permlink' }, { status: 400 });
  }
  // No cursor without its author, and vice versa -- `getAccountPosts` pages on
  // the pair together.
  if (Boolean(startAuthor) !== Boolean(startPermlink)) {
    return NextResponse.json({ error: 'invalid_cursor' }, { status: 400 });
  }
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : undefined;

  try {
    // ★ A6 retry rollout (2026-08-18): wired here, not inside `getAccountPosts`
    // itself — that function's other caller (`streak/[user]/route.ts`) already
    // wraps it in its own wall-clock budget; see `getAccountPosts`'s own comment.
    // ★ `getAccountPostsPage`, NOT `getAccountPosts` (2026-08-23). The plain function
    // returns only the FILTERED array, and `dropBannedEntries` has already run inside it
    // — so the page size and the cursor computed from that array are both post-filter,
    // which is exactly what breaks paging (see the long note further down). This variant
    // reports the node's own count and last entry alongside the filtered entries.
    const page = await withRetry(
      () => getAccountPostsPage(sort, account, observer, startAuthor, startPermlink, limit),
      { label: `getAccountPosts(${sort},${account})` }
    ).catch(() => null);
    let entries: Entry[] | null = page?.entries ?? null;
    // ★ THE READ FAILED -- SAY SO. See the doc comment above: this used to be
    // indistinguishable from "this account genuinely has nothing posted".
    if (!entries) return NextResponse.json({ entries: [], degraded: 'upstream_empty' });

    // Identities first (they carry the `_lite.userId` the filter keys on),
    // blocks second -- same order `/api/discussion` uses and for the same
    // reason.
    entries = await attachLiteIdentities(entries);
    // ★★★ "COULD NOT CHECK" IS NOT "HAS NOTHING TO SHOW" (2026-08-13, adversarial
    // review S2). `applyOwnerBlocksToAuthoredEntries` fails CLOSED per parent —
    // right, and it stays — but it does so by returning FEWER entries and throwing
    // nothing, so with the Lumen database unreachable every parent became
    // unresolvable, this route answered a bare `{ entries: [] }`, the outer catch
    // below never ran, no `degraded` flag was ever set, and the Comments tab told
    // the reader "@user hasn't posted yet" about an account with twenty comments.
    // A database outage was being reported as an editorial fact.
    //
    // The split is deliberate:
    //   * SOME entries survived — serve them. Killing a page that is 90% correct
    //     over one unlookupable parent is the same mistake as wiping an
    //     already-rendered list on a failed page-2 fetch; the honest answer here
    //     is the entries we CAN vouch for.
    //   * NOTHING survived, and the only reason is that we could not check — that
    //     is not an empty account, and it must never be rendered as one. Flagged
    //     `degraded`, which `account-posts-fetch.ts` turns into a throw and every
    //     consumer already renders as an honest error.
    const filtered = await applyOwnerBlocksToAuthoredEntries(entries);
    entries = filtered.entries;
    if (entries.length === 0 && filtered.withheldUnresolvable > 0) {
      logger.warn(
        'account posts fully withheld for %s (sort=%s): %d entries unresolvable',
        account,
        sort,
        filtered.withheldUnresolvable
      );
      return NextResponse.json({ entries: [], degraded: 'block_filter_unresolved' });
    }
    // ★ EFFECT A — THE VIEWER'S OWN BLOCK LIST (2026-08-23).
  //
  // Everything above is effect (B): the PROFILE OWNER's blocks, which hide a blocked
  // stranger's replies from everyone. Effect (A) is the opposite direction — what the
  // READER chose not to see — and this route never applied it. `/@user/feed` and
  // `/@user/comments` both fetch here, so a reader met an account they had blocked on the
  // one surface where they had gone looking for that person's posts.
  //
  // ★ IT MUST RUN AFTER THE `withheldUnresolvable` CHECK ABOVE, not before. That check
  // distinguishes "we could not resolve the parents" from "this account has nothing".
  // A page that is empty because the READER blocked everyone on it is a real empty page,
  // not a database outage, and must never be reported as `block_filter_unresolved`.
  //
  // ★ DEGRADE OPEN, matching `feed/for-you`. Effect (A) is the reader's own preference,
  // not a safety control — the operator ban list is enforced separately and upstream. A
  // Lumen DB hiccup must not blank somebody's profile feed.
  //
  // Cache-safe: this route sets no `Cache-Control` and is covered by the middleware
  // matcher, which gives it `private, no-store`. DO NOT add a shared cache here — the
  // response is now viewer-dependent.
  // ★ THE CURSOR IS TAKEN FROM THE RAW PAGE, BEFORE FILTERING (2026-08-23).
  //
  // The client pages with `start_author`/`start_permlink` taken from the last entry it
  // received, and stops when a page comes back shorter than the limit. Filtering here
  // breaks BOTH halves of that: a page of 20 with one blocked author arrives as 19 and
  // looks like the end, and if every entry on the page is blocked there is no last entry
  // to build a cursor from at all. Either way paging dead-ends with more content behind it.
  //
  // So the page's own truth travels with it: `nextCursor` is derived from the RAW last
  // entry and is null only when the upstream page was genuinely short. The client keys on
  // that instead of on the filtered length.
  // `rawCount` travels too, because `limit` here is often undefined (the client omits it
  // and the bridge applies its own page size), so the ROUTE cannot decide "was this page
  // full". The client already knows its own PER_PAGE and keeps exactly the rule it had —
  // it just applies it to the raw count instead of the filtered length.
  // ★ BOTH COME FROM THE NODE'S PAGE, NOT FROM `entries` (2026-08-23).
  // `entries` has been through THREE filters by now — `dropBannedEntries` inside the
  // bridge call, the profile owner's blocks just above, and the viewer's own list just
  // below. Measuring the page here counted none of them: a page of 20 with one banned
  // author read as 19, `hasMore` went false, and the rest of the account was unreachable.
  const rawCount = page?.rawCount ?? 0;
  const nextCursor = page?.rawCursor ?? null;
  // ★ THE SERVER DECIDES "WAS THE PAGE FULL", NOT THE CLIENT (2026-08-23).
  //
  // The first version of this returned `rawCount` and let the client compare it to its own
  // `PER_PAGE` (20). That happened to work only because `PER_PAGE` and this route's
  // effective page size (`DATA_LIMIT`, also 20) are equal today — two independent
  // constants with nothing tying them together and no test asserting the relationship.
  // Change `DATA_LIMIT` to 30 and the comparison silently never matches again, so
  // pagination stops after page one with no error anywhere. Exactly the silent-zero this
  // codebase keeps producing.
  //
  // Only this route knows the limit it actually used, so only this route can answer the
  // question. The client follows the answer.
  const hasMore = rawCount >= (limit ?? DATA_LIMIT);

  const viewerSession = await getLiteSession();
  const blockedKeys = await viewerBlockedKeySet(viewerSession.user).catch(() => new Set<string>());
  if (blockedKeys.size > 0) {
    entries = await filterBlockedForViewer(entries, blockedKeys);
  }

  // Lumen-local vote/reblog counts -- see `mergeLumenEngagement`'s own doc for
    // why this route had never applied them before 2026-08-13 (O2-votes.md item
    // 1's server half): a vote cast through Lumen on a post shown here reverted
    // to the chain-only count on every reload of this exact tab.
    entries = await mergeLumenEngagement(entries);

    return NextResponse.json({ entries, nextCursor, hasMore });
  } catch (error) {
    logger.error(error, 'account posts fetch failed for %s (sort=%s)', account, sort);
    // ★ FAIL EMPTY, NEVER FAIL OPEN -- same posture as `/api/discussion`. The
    // old client path fell back to an unfiltered read straight off a Hive
    // node; if this route breaks, the honest answer is no entries rather than
    // every entry the account owner asked us not to serve.
    return NextResponse.json({ entries: [], degraded: true }, { status: 200 });
  }
}
