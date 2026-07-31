import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite, guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { createLitePost, getLiteFeed, CreatePostRequest } from '@/blog/lib/lite/content/post-service';
import { dbPostToEntry } from '@/blog/lib/lite/render/db-post-to-entry';
import { resolvePublicNames } from '@/blog/lib/lite/render/current-name';
import { ParentRef } from '@/blog/lib/lite/types';

const logger = getLogger('app');

/** Hive account charset. */
const HIVE_NAME = /^[a-z][a-z0-9.-]{2,15}$/;

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
    const result = await createLitePost(session.user, request, session.sessionEpoch);
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

/** GET /api/lite/posts?before=&limit= — DB-sourced feed as bridge Entries (§E.1). */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const before = req.nextUrl.searchParams.get('before') ?? undefined;
  const limitParam = req.nextUrl.searchParams.get('limit');
  const limit = limitParam && Number.isFinite(Number(limitParam)) ? Number(limitParam) : 20;

  try {
    const list = await getLiteFeed({ limit, before });
    // ONE user query for the page, not one per post. Names are resolved live rather
    // than read off the row so an upgraded author's back catalogue shows their new
    // Hive name (see render/current-name.ts).
    const names = await resolvePublicNames(list);
    return NextResponse.json({ entries: list.map((post) => dbPostToEntry(post, names.get(post.postId))) });
  } catch (error) {
    logger.error(error, 'Lite feed failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
