import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import type { Entry } from '@hive/common-hiveio-packages/wax';
import { getAccountPosts } from '@transaction/lib/bridge-api';
import { attachLiteIdentities } from '@/blog/lib/lite/render/attach-lite';
import { applyOwnerBlocksToAuthoredEntries } from '@/blog/lib/lite/social/block-filter';

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
 * Response shape is deliberately identical to what `getAccountPosts` itself
 * returned -- `{ entries: Entry[] | null }` -- so `posts-content.tsx` and the
 * redesigned profile's `useAccountEntries` hook change only WHERE they fetch
 * from, not how they read the answer.
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
    let entries: Entry[] | null = await getAccountPosts(
      sort,
      account,
      observer,
      startAuthor,
      startPermlink,
      limit
    ).catch(() => null);
    if (!entries) return NextResponse.json({ entries: null });

    // Identities first (they carry the `_lite.userId` the filter keys on),
    // blocks second -- same order `/api/discussion` uses and for the same
    // reason.
    entries = await attachLiteIdentities(entries);
    entries = await applyOwnerBlocksToAuthoredEntries(entries);

    return NextResponse.json({ entries });
  } catch (error) {
    logger.error(error, 'account posts fetch failed for %s (sort=%s)', account, sort);
    // ★ FAIL EMPTY, NEVER FAIL OPEN -- same posture as `/api/discussion`. The
    // old client path fell back to an unfiltered read straight off a Hive
    // node; if this route breaks, the honest answer is no entries rather than
    // every entry the account owner asked us not to serve.
    return NextResponse.json({ entries: [], degraded: true }, { status: 200 });
  }
}
