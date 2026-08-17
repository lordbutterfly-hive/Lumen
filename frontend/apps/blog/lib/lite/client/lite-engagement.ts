'use client';

/**
 * Client-side READ of Lumen-local engagement.
 *
 * The write helpers live in lite-write.ts; this is the other half, and it exists
 * because the two were never symmetric. A lite user's vote and reblog were written to
 * Postgres and then read back from Hivemind, which has never heard of them — so the
 * button lit up, and the next refetch or page load turned it off again with no error.
 *
 * The vote payload is deliberately shaped like `getListVotesByCommentVoter`'s so the
 * vote component can swap the source without changing how it renders.
 */

/**
 * The chain type, so the vote component can take this source or Hivemind's without
 * a cast or a second render path. `_temporary` is the wax field for "this row is not
 * from the backend", which is exactly true of a Lumen-local vote.
 */
import type { IVoteListItem } from '@hive/common-hiveio-packages/wax';

export interface LiteEngagementResponse {
  votes: IVoteListItem[];
  reblogged: boolean;
  voteCount: number;
  reblogCount: number;
}

const EMPTY: LiteEngagementResponse = { votes: [], reblogged: false, voteCount: 0, reblogCount: 0 };

/**
 * ★★★ COALESCED INTO ONE REQUEST PER PAGE (2026-08-17). MEASURED N+1.
 *
 * Every consumer below still calls this per post, exactly as before — the batching
 * is entirely inside this function, so no call site changed. What changed is the
 * wire: ~30 requests on every home load became one.
 *
 * The storm, measured on a real home load: this is `cache: 'no-store'` by
 * necessity (a vote must never render stale), so nothing absorbed it — one request
 * per feed card, 3.3-13.7s aggregate, 0.8-3.0s of tail on EVERY load, forever. The
 * product's rule is that a first load may be slow once and later loads never may;
 * this sat squarely in "later loads".
 *
 * Identical in shape to `use-lumen-block.ts`, which fixed the same storm for block
 * state, and it inherits that file's two hard-won details:
 *
 *  · A short `setTimeout` window, NOT a bare microtask. Every card on an
 *    SSR-hydrated page mounts in the same commit, but React can flush passive
 *    effects across more than one task, and a microtask queued by the FIRST caller
 *    would fire before the rest had asked — splitting the batch for no reason.
 *
 *  · Answers are delivered in CHUNKS with a real macrotask between them. Settling
 *    30 promises in one synchronous loop reproducibly crashed the page from
 *    `use-lumen-block.ts`'s own A/B: every `MediumPostCard`'s Radix dropdown
 *    updating in a single React commit trips "Maximum update depth exceeded". The
 *    network win is kept; the answers are just spread back over several commits the
 *    way independent completions used to be.
 *
 * Failure posture is unchanged and deliberate: a failed read resolves EMPTY rather
 * than throwing, because a blank answer must never wipe a button state the caller
 * already has.
 */
const BATCH_WINDOW_MS = 10;
const DELIVERY_CHUNK_SIZE = 6;

interface PendingEngagementGroup {
  author: string;
  permlink: string;
  resolvers: ((value: LiteEngagementResponse) => void)[];
}

// Module scope so every card on the page joins the SAME outbound request.
let pendingBatch: Map<string, PendingEngagementGroup> | null = null;
let batchTimer: ReturnType<typeof setTimeout> | null = null;

function normalise(body: Partial<LiteEngagementResponse> | null | undefined): LiteEngagementResponse {
  if (!body || !Array.isArray(body.votes)) return EMPTY;
  return {
    votes: body.votes,
    reblogged: Boolean(body.reblogged),
    voteCount: Number(body.voteCount ?? 0),
    reblogCount: Number(body.reblogCount ?? 0)
  };
}

async function deliverInChunks(
  groups: PendingEngagementGroup[],
  answerOf: (group: PendingEngagementGroup) => LiteEngagementResponse
): Promise<void> {
  for (let i = 0; i < groups.length; i += DELIVERY_CHUNK_SIZE) {
    for (const group of groups.slice(i, i + DELIVERY_CHUNK_SIZE)) {
      const answer = answerOf(group);
      for (const resolve of group.resolvers) resolve(answer);
    }
    if (i + DELIVERY_CHUNK_SIZE < groups.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}

async function flushBatch(batch: Map<string, PendingEngagementGroup>): Promise<void> {
  const groups = [...batch.values()];
  let byKey: Record<string, Partial<LiteEngagementResponse>> = {};
  try {
    const targets = groups.map((g) => [g.author, g.permlink]);
    const params = new URLSearchParams({ targets: JSON.stringify(targets) });
    const res = await fetch(`/api/lite/engagement/bulk?${params.toString()}`, { cache: 'no-store' });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as {
        engagement?: Record<string, Partial<LiteEngagementResponse>>;
      } | null;
      byKey = body?.engagement ?? {};
    }
  } catch {
    // Fall through: every group resolves EMPTY, same as the per-item route's own
    // catch did. A whole batch failing must not throw into 30 callers.
  }
  await deliverInChunks(groups, (g) => normalise(byKey[`${g.author}/${g.permlink}`]));
}

function scheduleFlush(): void {
  if (batchTimer) return;
  batchTimer = setTimeout(() => {
    const batch = pendingBatch;
    pendingBatch = null;
    batchTimer = null;
    if (batch) void flushBatch(batch);
  }, BATCH_WINDOW_MS);
}

export async function fetchLiteEngagement(
  author: string,
  permlink: string
): Promise<LiteEngagementResponse> {
  if (!author || !permlink) return EMPTY;
  const key = `${author}/${permlink}`;
  if (!pendingBatch) pendingBatch = new Map();
  let group = pendingBatch.get(key);
  if (!group) {
    group = { author, permlink, resolvers: [] };
    pendingBatch.set(key, group);
  }
  const answer = new Promise<LiteEngagementResponse>((resolve) => {
    group!.resolvers.push(resolve);
  });
  scheduleFlush();
  return answer;
}
