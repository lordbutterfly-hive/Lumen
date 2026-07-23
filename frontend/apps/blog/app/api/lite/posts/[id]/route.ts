import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLitePost } from '@/blog/lib/lite/content/post-service';
import { dbPostToEntry } from '@/blog/lib/lite/render/db-post-to-entry';

const logger = getLogger('app');

/** GET /api/lite/posts/:id — single post detail, DB-sourced (§E.1). */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  try {
    const post = await getLitePost(params.id);
    if (!post || post.deletedLocally || post.feedVisibility === 'hidden') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ entry: dbPostToEntry(post), post });
  } catch (error) {
    logger.error(error, 'Lite post fetch failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
