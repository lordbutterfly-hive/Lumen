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

/** Hard ceiling on one batched request's parent list — mirrors the pattern and the
 *  cap `/api/lite/block/state-bulk` already uses for the same shape of problem
 *  (ask about N things in one round trip); a real thread's comment count is
 *  comfortably under this in practice. */
const MAX_PARENTS = 200;

interface ParentRequest {
  author: string;
  permlink: string;
  /** The parent's OWN depth in the caller's tree (Hive convention: a root post is
   *  depth 0). Used only to stamp the correct `depth` on whatever lite reply
   *  matches this parent -- see the doc below on why the route cannot derive this
   *  itself. Defaults to 0 (root) when omitted or malformed, which is exactly
   *  today's single-parent assumption. */
  depth: number;
}

/**
 * Parses the `parents` query param: a JSON array of `[author, permlink, depth]`
 * triples, the same terse-tuple convention `/api/lite/block/state-bulk` uses for
 * its own `targets` param. Malformed individual entries are skipped rather than
 * failing the whole batch -- same posture as that route: one bad pair should not
 * cost every other parent in a real thread its lite replies.
 *
 * ★ REPORTS ITS OWN CUT (2026-08-13, adversarial review S3). `MAX_PARENTS` used to
 * be applied with a bare `parsed.slice(0, MAX_PARENTS)` and no signal, which is the
 * third of three stacked silent truncations on this path (the other two lived in the
 * SQL -- see `listRepliesToChainPosts`). A caller that asks about 260 nodes and is
 * quietly answered for 200 has no way to know the last 60 were never even looked at.
 */
function parseParents(raw: string): { parents: ParentRequest[]; truncated: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const out: ParentRequest[] = [];
  for (const entry of parsed.slice(0, MAX_PARENTS)) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [rawAuthor, rawPermlink, rawDepth] = entry;
    if (typeof rawAuthor !== 'string' || typeof rawPermlink !== 'string') continue;
    const author = rawAuthor.trim().replace(/^@/, '');
    const permlink = rawPermlink.trim();
    if (!author || !permlink) continue;
    const depth = typeof rawDepth === 'number' && Number.isFinite(rawDepth) && rawDepth >= 0 ? rawDepth : 0;
    out.push({ author, permlink, depth });
  }
  return { parents: out, truncated: parsed.length > MAX_PARENTS };
}

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
 *
 * ★★★ NOW ACCEPTS A SET OF PARENTS, NOT JUST THE ROOT (2026-08-13,
 * O4-stuck-states.md item 7). This route originally asked about exactly one
 * parent — the thread ROOT — which only ever finds a lite reply to the root
 * post. A lite reply to a COMMENT has its `publish_parent_*` pointing at that
 * comment, not the root, so it was never even queried for, let alone hidden by
 * a filter: nested lite replies simply never appeared, at any depth, ever. See
 * `listRepliesToChainPosts`'s own doc (post-repository.ts) for the query-level
 * half of the fix.
 *
 * `author`/`permlink` stay REQUIRED and mean what they always meant — the
 * THREAD's identity, used below to resolve the post OWNER for effect (B). An
 * OPTIONAL `parents` param carries the full SET of nodes (root post + every
 * comment the caller believes could have a lite child) to fetch replies for, in
 * one call: a JSON array of `[author, permlink, depth]` triples, `depth` being
 * that node's own depth in the caller's tree (root = 0, mirroring Hive's own
 * convention) so this route can stamp the correct `depth` on whichever lite
 * reply matches it. When `parents` is absent, behaviour is ADDITIVE and
 * non-breaking: exactly one parent, the root, at depth 0 — the same row set as
 * before, with two extra fields (`parent_author`/`parent_permlink`) on each
 * entry — so every existing caller keeps working unchanged. (This paragraph
 * used to claim "BYTE-IDENTICAL", which was wrong about those two fields.)
 *
 * ★★★ AND IT NOW ADMITS WHEN IT CLIPPED THE ANSWER (2026-08-13, adversarial
 * review S3). Three separate caps sat on this path — the caller's own parent
 * slice, `MAX_PARENTS` here, and a `LIMIT` in the SQL that batching had turned
 * from per-thread into per-BATCH, oldest-first — and not one of them said a
 * word when it bound. A clipped list is read by the thread as "that is all the
 * replies there are", which is the same confident-false-empty class of lie this
 * whole change set exists to remove, just at a smaller scale. The response now
 * carries `truncated: true` whenever any cap bound, and the post page renders a
 * line saying so rather than presenting the remainder as the whole thread.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const author = (req.nextUrl.searchParams.get('author') ?? '').trim().replace(/^@/, '');
  const permlink = (req.nextUrl.searchParams.get('permlink') ?? '').trim();
  if (!author || !permlink) {
    return NextResponse.json({ error: 'author_and_permlink_required' }, { status: 400 });
  }

  const parentsRaw = req.nextUrl.searchParams.get('parents');
  let parents: ParentRequest[];
  let parentsTruncated = false;
  if (parentsRaw != null) {
    const parsed = parseParents(parentsRaw);
    if (!parsed) return NextResponse.json({ error: 'invalid_parents' }, { status: 400 });
    parents = parsed.parents;
    parentsTruncated = parsed.truncated;
  } else {
    // ★ THE SINGLE-PARENT FORM. Exactly what this route did before batching
    // existed — every caller that has not moved to `parents` yet keeps working.
    // The row SET is the same 200-row cap on one parent it always was; what
    // changed (2026-08-13) is that the cut now keeps the NEWEST 200 rather than
    // the oldest, and says so. See the header.
    parents = [{ author, permlink, depth: 0 }];
  }
  if (parents.length === 0) {
    // Reachable only when every triple in an over-long `parents` list was
    // malformed. Still a clipped answer, so still say so.
    return parentsTruncated
      ? NextResponse.json({ entries: [], truncated: true })
      : NextResponse.json({ entries: [] });
  }

  try {
    // `perParentLimit` is the cap this route ALWAYS meant: 200 replies to any one
    // node, exactly what the single-parent form gave the thread root. `totalLimit`
    // is a separate ceiling on the batch so a 200-parent request cannot pull an
    // unbounded row set through one connection — it is deliberately far above what
    // a real thread produces, so in practice only `perParentLimit` can ever bind.
    const { matches, truncated } = await posts.listRepliesToChainPosts(
      parents.map((p) => ({ author: p.author, permlink: p.permlink })),
      { perParentLimit: 200, totalLimit: 2000 }
    );
    const clipped = truncated || parentsTruncated;
    if (clipped) {
      logger.warn(
        'lite replies clipped for %s/%s (parents=%d, rows=%d, parentsTruncated=%s)',
        author,
        permlink,
        parents.length,
        matches.length,
        parentsTruncated
      );
    }
    if (matches.length === 0) {
      return clipped ? NextResponse.json({ entries: [], truncated: true }) : NextResponse.json({ entries: [] });
    }

    // Same name resolution the feed and profile use, so a writer who renamed
    // themselves is credited under the name they use NOW, in every surface.
    const names = await resolvePublicNames(matches.map((m) => m.post));
    const depthByParent = new Map(parents.map((p) => [`${p.author}/${p.permlink}`, p.depth]));

    // ★ STAMP EACH ROW'S OWN MATCHED PARENT — NOT THE THREAD ROOT.
    // `dbPostToEntry` sets `depth` but no `parent_author`/`parent_permlink` — it
    // was written for feed cards, which never ask. The comment thread selects a
    // parent's direct children with `x.parent_author === parent.author &&
    // x.parent_permlink === parent.permlink` (comment-list.tsx), so an entry
    // stamped with the WRONG parent is not merely undecorated — same as before,
    // it is silently attached to the wrong node in the tree, or to no node the
    // thread ever renders. With a single parent there was only one possible
    // answer to guess; with a batched request two different rows in the SAME
    // response can legitimately have replied to two different comments, so each
    // row is stamped with the ACTUAL parent `listRepliesToChainPosts` matched it
    // to (returned per-row from the query's own join), never the request's
    // `author`/`permlink`. `depth` is the matched parent's own depth + 1 —
    // supplied by the caller per parent (see the doc above), since only the
    // caller's own tree knows a comment's true nesting depth.
    const entries: Entry[] = matches.map(({ post, parentAuthor, parentPermlink }) => ({
      ...dbPostToEntry(post, names.get(post.postId)),
      parent_author: parentAuthor,
      parent_permlink: parentPermlink,
      depth: (depthByParent.get(`${parentAuthor}/${parentPermlink}`) ?? 0) + 1
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
    // The owner is resolved from the THREAD's own `author`/`permlink` (the
    // required params, unrelated to the `parents` batch) — a post owner's block
    // reaches every reply in THEIR thread regardless of nesting level, the same
    // rule `/api/discussion` applies over the whole flat discussion map. Resolved
    // from the PERMLINK first: a Lumen post's chain author is the shared
    // publishing account, so reading the author segment would make one system
    // account the blocker-of-record for everybody's posts.
    const owner = await resolvePostOwnerActor(author, permlink);
    const visible = await applyOwnerBlocksToReplies(entries, owner);
    return clipped
      ? NextResponse.json({ entries: visible, truncated: true })
      : NextResponse.json({ entries: visible });
  } catch (error) {
    // A failure here must not take the thread down with it — the chain replies
    // are the bulk of it and are already loaded. Answer empty and say so in the
    // log, rather than turning a degraded thread into no thread.
    logger.error(error, 'lite replies lookup failed for %s/%s', author, permlink);
    return NextResponse.json({ entries: [], degraded: true });
  }
}
