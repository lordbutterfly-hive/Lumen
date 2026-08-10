import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import * as posts from '@/blog/lib/lite/repositories/post-repository';
import { dbPostToEntry } from '@/blog/lib/lite/render/db-post-to-entry';
import { resolvePublicNames } from '@/blog/lib/lite/render/current-name';
import {
  applyOwnerBlocksToReplies,
  resolvePostOwnerActor
} from '@/blog/lib/lite/social/block-filter';
import type { Entry } from '@hive/common-hiveio-packages/wax';

const logger = getLogger('app');

/**
 * ★★★ LITE REPLIES FOR ONE POST'S COMMENT THREAD.
 *
 * WHY THIS ROUTE HAD TO EXIST (2026-08-09, tester NEWCOMER-06). A lite reader
 * replied to a post, was told "Reply sent — it will appear in this thread once
 * it reaches Hive, usually within a minute", reloaded, and their reply was not
 * there. It WAS on their own profile's Comments tab, immediately and in full.
 *
 * The thread is built from `bridge.get_discussion` — the CHAIN — and a lite
 * reply lives in `lumen_post` until the publisher broadcasts it. So the reply
 * existed, Lumen could see it, and the one place its author would naturally look
 * was the one place that could not show it. Top-level lite posts never had this
 * problem: they render locally on the feed and at their own permalink.
 *
 * And "usually within a minute" is only true while the publisher is draining.
 * It is stalled right now on resource credits, with the oldest job hours old —
 * so today that copy promises something that will not happen, and the thread
 * stays wrong indefinitely. Reading the local row removes the dependency
 * entirely: the reply shows the moment it is saved, and the chain copy simply
 * replaces it later.
 *
 * DELIBERATELY PUBLIC (`guardRead` only, no session). A lite reply is public
 * content the moment it is posted — it is already served to anonymous readers on
 * the feed and on the author's profile. Requiring a session here would mean a
 * thread that changes depending on who is looking, for no privacy gain.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const author = (req.nextUrl.searchParams.get('author') ?? '').trim().replace(/^@/, '');
  const permlink = (req.nextUrl.searchParams.get('permlink') ?? '').trim();
  if (!author || !permlink) {
    return NextResponse.json({ error: 'author_and_permlink_required' }, { status: 400 });
  }

  try {
    const rows = await posts.listRepliesToChainPost(author, permlink, { limit: 200 });
    if (rows.length === 0) return NextResponse.json({ entries: [] });

    // Same name resolution the feed and profile use, so a writer who renamed
    // themselves is credited under the name they use NOW, in every surface.
    const names = await resolvePublicNames(rows);
    // ★ STAMP THE PARENT IDENTITY. `dbPostToEntry` sets `depth` but no
    // `parent_author`/`parent_permlink` — it was written for feed cards, which
    // never ask. The comment thread selects its top-level replies with
    // `depth === post.depth + 1 && parent_author === post.author &&
    // parent_permlink === post.permlink`, so an entry missing those two fields
    // is silently filtered out and the merge renders nothing. Measured exactly
    // that: this route returned the reply and the thread still did not show it.
    //
    // This route is the right place to add them: the parent is its own two
    // query arguments, so the values cannot disagree with what was asked for.
    const entries: Entry[] = rows.map((row) => ({
      ...dbPostToEntry(row, names.get(row.postId)),
      parent_author: author,
      parent_permlink: permlink,
      depth: 1
    }));

    // ★★★ EFFECT (B) — SERVER-SIDE, AND THIS ROUTE IS PUBLIC.
    //
    // This is the second of the two sources the comment thread is assembled from
    // (the other is `/api/discussion`), and it is deliberately session-less: a lite
    // reply is public content. That is exactly why the block has to be applied HERE
    // rather than in the browser. The post owner has said these replies are not to
    // be served, and "not to be served" cannot be a preference the recipient
    // enforces on themselves.
    //
    // The owner is resolved from the PERMLINK first: a Lumen post's chain author is
    // the shared publishing account, so reading the author segment would make one
    // system account the blocker-of-record for everybody's posts.
    const owner = await resolvePostOwnerActor(author, permlink);
    const visible = await applyOwnerBlocksToReplies(entries, owner);
    return NextResponse.json({ entries: visible });
  } catch (error) {
    // A failure here must not take the thread down with it — the chain replies
    // are the bulk of it and are already loaded. Answer empty and say so in the
    // log, rather than turning a degraded thread into no thread.
    logger.error(error, 'lite replies lookup failed for %s/%s', author, permlink);
    return NextResponse.json({ entries: [], degraded: true });
  }
}
