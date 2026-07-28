import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite, guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { createLitePost, getLiteFeed, CreatePostRequest } from '@/blog/lib/lite/content/post-service';
import { dbPostToEntry } from '@/blog/lib/lite/render/db-post-to-entry';
import { ParentRef } from '@/blog/lib/lite/types';

const logger = getLogger('app');

function parseParentRef(v: unknown): ParentRef | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (o.type === 'lite' && typeof o.id === 'string') return { type: 'lite', id: o.id };
  if (o.type === 'chain' && typeof o.author === 'string' && typeof o.permlink === 'string') {
    return { type: 'chain', author: o.author, permlink: o.permlink };
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

  const request: CreatePostRequest = {
    tier: body.tier === 'advanced' ? 'advanced' : 'normal',
    body: typeof body.body === 'string' ? body.body : '',
    title: typeof body.title === 'string' ? body.title : undefined,
    summary: typeof body.summary === 'string' ? body.summary : undefined,
    tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string') : undefined,
    community: typeof body.community === 'string' ? body.community : undefined,
    thumbnailUrl: typeof body.thumbnail === 'string' ? body.thumbnail : undefined,
    parentRef: parseParentRef(body.parentRef),
    editOfPostId: typeof body.editOfPostId === 'string' ? body.editOfPostId : undefined
  };

  try {
    const result = await createLitePost(session.user, request);
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
    return NextResponse.json({ entries: list.map(dbPostToEntry) });
  } catch (error) {
    logger.error(error, 'Lite feed failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
