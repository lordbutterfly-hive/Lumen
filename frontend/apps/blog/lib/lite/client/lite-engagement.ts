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

export async function fetchLiteEngagement(
  author: string,
  permlink: string
): Promise<LiteEngagementResponse> {
  try {
    const params = new URLSearchParams({ author, permlink });
    const res = await fetch(`/api/lite/engagement?${params.toString()}`, { cache: 'no-store' });
    if (!res.ok) return EMPTY;
    const body = (await res.json().catch(() => null)) as Partial<LiteEngagementResponse> | null;
    if (!body || !Array.isArray(body.votes)) return EMPTY;
    return {
      votes: body.votes,
      reblogged: Boolean(body.reblogged),
      voteCount: Number(body.voteCount ?? 0),
      reblogCount: Number(body.reblogCount ?? 0)
    };
  } catch {
    // A failed read must not blank out an existing button state; the caller keeps
    // whatever it already had.
    return EMPTY;
  }
}
