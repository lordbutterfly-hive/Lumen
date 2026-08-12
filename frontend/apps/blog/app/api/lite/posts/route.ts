import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite, guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { createLitePost, getLiteUserPosts, CreatePostRequest } from '@/blog/lib/lite/content/post-service';
import { findUserByDisplayName } from '@/blog/lib/lite/repositories/user-repository';
import { dbPostToEntry } from '@/blog/lib/lite/render/db-post-to-entry';
import { resolvePublicNames } from '@/blog/lib/lite/render/current-name';
import { applyOwnerBlocksToAuthoredEntries } from '@/blog/lib/lite/social/block-filter';
import { ParentRef } from '@/blog/lib/lite/types';
import type { Entry } from '@hive/common-hiveio-packages/wax';

const logger = getLogger('app');

/** Hive account charset. */
const HIVE_NAME = /^[a-z][a-z0-9.-]{2,15}$/;

/**
 * Stand-in for `parent_author` when the real parent is a LITE post rather than
 * a chain one. `resolvePostOwnerActor` (block-filter.ts) resolves ownership
 * from `parent_permlink` first -- it recognises the synthetic `lite-<id>`
 * shape and looks the id up directly, never touching this value at all as
 * long as that lookup succeeds. It is read only if the referenced lite post
 * has since been deleted, and even then it must never accidentally name a
 * real account: `'0'` cannot be a Hive account name (must start with a
 * letter) and cannot be a Lumen block key either, so it resolves to "no
 * owner found" rather than risking a false match against an unrelated real
 * account that happens to share this placeholder's spelling.
 */
const UNRESOLVED_LITE_PARENT_AUTHOR = '0';

/** `lite-<id>` -- the same synthetic permlink `dbPostToEntry` gives an
 *  unpublished lite post, which is exactly the shape `litePostIdOf` parses
 *  back into a post id. */
function liteParentPermlink(postId: string): string {
  return `lite-${postId.toLowerCase()}`;
}

/**
 * A permlink we are REFERENCING, not creating.
 *
 * Deliberately looser than `isValidPermlinkFormat`, which encodes this app's own
 * slugifier (`[a-z0-9-]`) rather than Hive's rule. Real permlinks on chain predate that
 * convention and contain dots, underscores and uppercase — so validating a parent
 * against it made replying to those posts impossible, permanently, with a 400. This
 * rejects only what cannot be a permlink at all: empty, over-long, or containing
 * whitespace or control characters.
 */
function isReferenceablePermlink(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function parseParentRef(v: unknown): ParentRef | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  // A lite parent is one of OUR post ids. Unvalidated, `{type:'lite', id:''}` produced
  // a parent permlink of `lumen-` under the publishing account and failed on chain until
  // the job exhausted its retries.
  if (o.type === 'lite' && typeof o.id === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(o.id)) {
    return { type: 'lite', id: o.id };
  }
  // ★ BOTH halves must be well-formed, and the author especially.
  //
  // A chain parent with an EMPTY author is not "a reply to nobody" — it is a ROOT
  // POST. The publisher branches on `parentAuthor` being truthy
  // (`hive-broadcaster.ts`), so `{author: '', permlink: 'hive-167922'}` made the shared
  // publishing account publish the caller's title and body as a root post in the
  // community named by `permlink`. That bypasses the container model entirely and
  // burns the account's 5-minute root-post interval, which every other lite user's
  // posting depends on.
  if (
    o.type === 'chain' &&
    typeof o.author === 'string' &&
    typeof o.permlink === 'string' &&
    HIVE_NAME.test(o.author.trim().toLowerCase()) &&
    isReferenceablePermlink(o.permlink.trim())
  ) {
    return { type: 'chain', author: o.author.trim().toLowerCase(), permlink: o.permlink.trim() };
  }
  return undefined;
}

/**
 * Map an intake error code onto HTTP.
 *
 * 403 for the account states (suspended, banned, upgraded, moderated) rather than
 * 401: the session is genuinely valid, so a 401 would send the client into a
 * re-login loop that can never resolve the problem.
 */
function httpStatusFor(code: string): number {
  if (code === 'unauthorized') return 401;
  if (code.startsWith('account_') || code === 'moderated') return 403;
  // ★ Same outcome, same status. `not_found` fell through to 400 here while the
  //   sibling DELETE /api/lite/posts/[id] returns 404 for the identical
  //   condition — editing someone else's post and deleting someone else's post
  //   are the same refusal and were answered two different ways.
  if (code === 'not_found') return 404;
  if (code.endsWith('rate_limited')) return 429;
  return 400;
}

/**
 * POST /api/lite/posts — intake for NORMAL and ADVANCED lite posts (spec §C).
 * Identity comes from the session, never the client body.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const session = await getLiteSession();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  // A parent that cannot be parsed is an ERROR, not "no parent". Treating it as absent
  // published a reply as a standalone post — under the rolling container, invisible in
  // the thread the user was replying to — and answered 201, so nothing looked wrong.
  const parsedParent = parseParentRef(body.parentRef);
  if (body.parentRef && !parsedParent) {
    return NextResponse.json(
      { status: 'error', code: 'invalid_parent', message: 'That post could not be identified.' },
      { status: 400 }
    );
  }

  const request: CreatePostRequest = {
    tier: body.tier === 'advanced' ? 'advanced' : 'normal',
    body: typeof body.body === 'string' ? body.body : '',
    title: typeof body.title === 'string' ? body.title : undefined,
    summary: typeof body.summary === 'string' ? body.summary : undefined,
    tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string') : undefined,
    community: typeof body.community === 'string' ? body.community : undefined,
    thumbnailUrl: typeof body.thumbnail === 'string' ? body.thumbnail : undefined,
    parentRef: parsedParent,
    editOfPostId: typeof body.editOfPostId === 'string' ? body.editOfPostId : undefined
  };

  try {
    const result = await createLitePost(session.user, request, session);
    if (result.status === 'error') {
      return NextResponse.json(result, { status: httpStatusFor(result.code) });
    }
    return NextResponse.json(
      { status: 'ok', post: result.post, entry: dbPostToEntry(result.post) },
      { status: 201 }
    );
  } catch (error) {
    logger.error(error, 'Lite post create failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

/**
 * GET /api/lite/posts?author=<name>&before=&limit=&kind= — ONE lite account's
 * own posts, as bridge Entries (§E.1). For their public profile.
 *
 * Without `author` this route used to fall through to `getLiteFeed`/
 * `listRecent` and hand back every `feed_visibility='visible'` row in
 * `lumen_post`, newest first, from every author on the platform — no session,
 * no scoping, reachable by a bare unauthenticated `curl`. That branch had
 * exactly one caller, `features/discovery-feed/lite-feed-strip.tsx`
 * ("Lumen-native posts shown ABOVE the Hive discovery feed"), which has since
 * been unwired from `feed-tabs.tsx` and — as of this fix — is imported
 * NOWHERE in the app (`grep -rln lite-feed-strip apps/blog` outside `.next`
 * build output returns nothing). There is therefore no product surface left
 * for a global dump to serve, and the honest fix for a leak with zero
 * remaining legitimate callers is to delete the branch, not to bolt a filter
 * onto a route nothing calls. `author` is now REQUIRED: this endpoint answers
 * "what has this one named account written", never "what has everyone
 * written".
 *
 * Deliberately still no session requirement on the `author=` path — it is
 * asked about every profile a reader opens (`features/account-profile/
 * redesign/hooks/use-account-entries.ts`, keyed on the route's `[param]`
 * segment, i.e. ANY username, not just the signed-in caller's own), the same
 * way `bridge.get_account_posts` answers for an ordinary Hive account with no
 * auth at all. A lite account's public profile is exactly that: public.
 * `getLiteUserPosts(..., visibleOnly: true)` is the scope — it can only ever
 * return that ONE account's own already-visible, non-deleted posts, never
 * another author's and never anything moderation has hidden.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const author = req.nextUrl.searchParams.get('author');
  if (!author) {
    return NextResponse.json(
      { error: 'author_required', message: 'GET /api/lite/posts requires ?author=<username>.' },
      { status: 400 }
    );
  }

  const before = req.nextUrl.searchParams.get('before') ?? undefined;
  const limitParam = req.nextUrl.searchParams.get('limit');
  const limit = limitParam && Number.isFinite(Number(limitParam)) ? Number(limitParam) : 20;
  const kindParam = req.nextUrl.searchParams.get('kind');
  const kind = kindParam === 'comments' ? 'comments' : kindParam === 'all' ? 'all' : 'posts';

  try {
    const user = await findUserByDisplayName(author.toLowerCase());
    // Not a Lumen account: an empty list, not a 404. This route is asked about
    // every profile the reader opens, most of which are ordinary Hive accounts.
    if (!user) return NextResponse.json({ entries: [] });
    const list = await getLiteUserPosts(user.userId, { limit, before, kind, visibleOnly: true });
    // ONE user query for the page, not one per post. Names are resolved live rather
    // than read off the row so an upgraded author's back catalogue shows their new
    // Hive name (see render/current-name.ts).
    const names = await resolvePublicNames(list);

    // ★★★ STAMP THE PARENT, THEN APPLY EFFECT (B) (2026-08-12).
    //
    // `dbPostToEntry` never sets `parent_author`/`parent_permlink` -- it was
    // written for feed cards, which only ever show a post's OWN identity, not
    // what it replies to (same gap `/api/lite/posts/replies` hit and fixed
    // for its one-fixed-parent case). This route is different: it is the
    // Comments tab, so `kind=comments` returns replies to MANY different
    // parents on one page, and the block check needs to know each one.
    //
    // A lite reply's parent is a `ParentRef`, resolved on chain PUBLISH but
    // known immediately either way:
    //   - `{type: 'chain', author, permlink}` -- already a real chain
    //     coordinate, used as-is.
    //   - `{type: 'lite', id}` -- another Lumen post, not yet known by a
    //     chain author/permlink. `resolvePostOwnerActor` resolves a `lite-<id>`
    //     permlink straight from the id without ever needing an author
    //     string, so the placeholder author here is a formality the normal
    //     path never reads (see `UNRESOLVED_LITE_PARENT_AUTHOR`).
    const withParents: Entry[] = list.map((post) => {
      const entry = dbPostToEntry(post, names.get(post.postId));
      if (post.parentRef?.type === 'chain') {
        return { ...entry, parent_author: post.parentRef.author, parent_permlink: post.parentRef.permlink };
      }
      if (post.parentRef?.type === 'lite') {
        return {
          ...entry,
          parent_author: UNRESOLVED_LITE_PARENT_AUTHOR,
          parent_permlink: liteParentPermlink(post.parentRef.id)
        };
      }
      return entry;
    });
    const entries = await applyOwnerBlocksToAuthoredEntries(withParents);

    return NextResponse.json({ entries });
  } catch (error) {
    logger.error(error, 'Lite author posts failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
