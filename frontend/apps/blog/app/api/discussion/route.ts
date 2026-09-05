import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import type { Entry } from '@hive/common-hiveio-packages/wax';
import { getDiscussionCached } from '@/blog/lib/cached-api';
import { attachLiteIdentitiesToDiscussion } from '@/blog/lib/lite/render/attach-lite';
import { liteChainCoordinates } from '@/blog/lib/lite/render/lite-entry';
import { applyOwnerBlocksToDiscussion } from '@/blog/lib/lite/social/block-filter';
import { mergeLumenEngagement } from '@/blog/lib/lite/repositories/engagement-repository';
import { isPermlinkValid } from '@/blog/utils/validate-links';

const logger = getLogger('app');

/**
 * Author shape check. Deliberately a regex rather than `isUsernameValid`, which
 * routes through WAX/WASM: this runs on every thread read, the value is only ever
 * handed to a JSON-RPC parameter (there is nothing to inject into), and the upstream
 * call already answers "no such post" for a name that is merely well-formed. It
 * accepts Lumen handles as well as Hive accounts, because a Lumen post's URL carries
 * the handle.
 */
const AUTHOR_SHAPE = /^[a-z0-9][a-z0-9.-]{1,31}$/;

/**
 * One upstream read, with a single retry.
 *
 * ★ WHY THE RETRY IS PART OF THE FEATURE, not padding. This route fails CLOSED — a
 * failure serves no comments rather than unfiltered ones — which is the right posture
 * when the alternative is publishing words a post owner blocked. But it means a
 * single flaky answer from a public Hive node empties a thread that was fine a second
 * ago, and public nodes do exactly that under load (measured while proving this
 * feature: the same thread answered 8 entries, then nothing, then 8 again). One cheap
 * retry removes most of that without weakening the posture at all.
 */
async function readDiscussion(
  author: string,
  permlink: string,
  observer: string
): Promise<Record<string, Entry> | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await getDiscussionCached(author, permlink, observer).catch(() => null);
    if (result && Object.keys(result).length > 0) return result;
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

/**
 * ★★★ GET /api/discussion?author=&permlink=&observer= — THE COMMENT THREAD, SERVED
 * BY US.
 *
 * WHY THIS ROUTE HAD TO EXIST. The post page fetched its thread twice: once on the
 * server (`page.tsx`) and again in the browser, where `useQuery` called
 * `getDiscussion` — a Hive node — DIRECTLY. That second call never touched a Lumen
 * server, so the first paint could honour a block and the very next render would put
 * every hidden comment straight back. A rule the server cannot see is not a rule.
 *
 * Effect (B) is the reason this cannot be fixed on the client instead. "Their
 * comments on my post are not seen by anyone" is a promise made to the POST OWNER
 * about OTHER readers; a filter running in those readers' browsers is enforced by
 * precisely the people it is meant to constrain. So the thread now comes from here,
 * already filtered, and the block list is never shipped to anyone.
 *
 * Everything else about the response is deliberately identical to what
 * `bridge.get_discussion` returned — the same `Record<'author/permlink', Entry>` map
 * — so `content.tsx` merges, sorts and paginates it unchanged.
 *
 * PUBLIC AND UNAUTHENTICATED, like the thread it serves. It reads no session and its
 * answer does not vary by reader: that is what makes it cacheable and what makes (B)
 * a property of the post rather than of who is looking. Effect (A) — the reader's own
 * block list — is applied separately, on top, in the client (`useLumenBlockList`);
 * the two are different promises to different people and are kept apart on purpose.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const author = (req.nextUrl.searchParams.get('author') ?? '').trim().replace(/^@/, '');
  const permlink = (req.nextUrl.searchParams.get('permlink') ?? '').trim();
  const observer = (req.nextUrl.searchParams.get('observer') ?? '').trim();

  if (!author || !permlink) {
    return NextResponse.json({ error: 'author_and_permlink_required' }, { status: 400 });
  }
  // Both values are pasted into an upstream API call, so they are shape-checked here
  // rather than trusted.
  if (!isPermlinkValid(permlink)) {
    return NextResponse.json({ error: 'invalid_permlink' }, { status: 400 });
  }
  if (!AUTHOR_SHAPE.test(author.toLowerCase()) || (observer && !AUTHOR_SHAPE.test(observer.toLowerCase()))) {
    return NextResponse.json({ error: 'invalid_author' }, { status: 400 });
  }

  try {
    let discussion = await readDiscussion(author, permlink, observer);

    // A lite post's author segment is a Lumen handle Hivemind has never heard of, so
    // the first lookup returns nothing and every reply under it would be invisible.
    // Same retry `page.tsx` does, for the same reason.
    if (!discussion) {
      const chain = await liteChainCoordinates(permlink).catch(() => null);
      if (chain) discussion = await readDiscussion(chain.author, chain.permlink, observer);
    }
    // ★ SAID OUT LOUD. An empty map here means the upstream node gave us nothing —
    // `bridge.get_discussion` always includes the root post for a post that exists —
    // and a caller must be able to tell that apart from "the filter removed
    // everything", which it never does to a root post. Unlabelled, an upstream
    // hiccup looks exactly like a working block, and a QA run cannot tell a real
    // pass from a coincidence.
    if (!discussion) return NextResponse.json({ discussion: {}, degraded: 'upstream_empty' });

    // Order matters: identities first (they carry the `_lite.userId` the filter keys
    // on), blocks second.
    discussion = await attachLiteIdentitiesToDiscussion(discussion);
    discussion = await applyOwnerBlocksToDiscussion(discussion);

    // ★ MERGE LUMEN ENGAGEMENT (2026-08-13, O2-votes.md item 2's comment half).
    // `getEngagementTotals` had exactly ONE caller in the whole app before this --
    // `/api/feed/for-you` -- so a Lumen (lite) vote on a COMMENT showed correctly
    // the instant it happened (the client's own optimistic cache patch) and then
    // reverted to the chain-only count on the very next reload, at any age,
    // forever: nothing on this route had ever read `lumen_vote`/`lumen_reblog`.
    // Applied last, after the block filter, so a Lumen lookup is never spent on
    // an entry that is about to be discarded anyway.
    const beforeMerge: Record<string, Entry> = discussion ?? {};
    const discussionKeys = Object.keys(beforeMerge);
    const mergedValues = await mergeLumenEngagement(discussionKeys.map((key) => beforeMerge[key]));
    discussion = Object.fromEntries(discussionKeys.map((key, i) => [key, mergedValues[i]]));

    return NextResponse.json({ discussion: discussion ?? {} });
  } catch (error) {
    logger.error(error, 'discussion fetch failed for %s/%s', author, permlink);
    // ★ FAIL EMPTY, NEVER FAIL OPEN. The old client path fell back to an unfiltered
    // thread straight off a Hive node; if this route breaks, the honest answer is no
    // comments rather than every comment the post owner asked us not to serve.
    return NextResponse.json({ discussion: {}, degraded: true }, { status: 200 });
  }
}
