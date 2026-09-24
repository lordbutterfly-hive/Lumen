import type { Entry } from '@hive/common-hiveio-packages/wax';
import { getPost } from '@transaction/lib/bridge-api';
import { listReblogsOf, listReblogsOfUsers } from '@/blog/lib/lite/repositories/engagement-repository';
import { findUsersByIds } from '@/blog/lib/lite/repositories/user-repository';
import { quotesForQuoterTargets } from '@/blog/lib/lite/repositories/quote-repository';
import { visibleQuotesOfQuoter } from '@/blog/lib/lite/repositories/quote-repository';
import type { TimedEntry } from './lite-profile-merge';

/** Their reblogs older than `time`, as feed entries marked reblogged by them. */
export async function liteReblogItems(userId: string, handle: string, time: Date | null, limit: number): Promise<{ items: TimedEntry[]; full: boolean }> {
  const rows = await listReblogsOf(userId, time, limit);
  const quotes = await visibleQuotesOfQuoter(
    `u:${userId}`,
    rows.map((r) => ({ author: r.targetAuthor, permlink: r.targetPermlink }))
  );
  const items = await Promise.all(
    rows.map(async (r): Promise<TimedEntry | null> => {
      // A reblogged post that is gone or banned is simply not shown.
      const post = await getPost(r.targetAuthor, r.targetPermlink, '').catch(() => null);
      if (!post) return null;
      const q = quotes.get(`${r.targetAuthor}/${r.targetPermlink}`);
      const entry: Entry = {
        ...post,
        reblogged_by: [handle],
        ...(q
          ? { _quote: { quoter: handle, author: q.quoteAuthor, permlink: q.quotePermlink, body: q.bodyCache, ...(q.state === 'pending' ? { pending: true } : {}) } }
          : {})
      };
      return { entry, ms: r.createdAt.getTime() };
    })
  );
  return { items: items.filter((i): i is TimedEntry => i !== null), full: rows.length >= limit };
}


/**
 * Lumen followees' newest reblogs for a lite viewer's Following feed (decision D9), each
 * marked reblogged by its handle and carrying the comment when there is one (a lite
 * quote still publishing included). One query for the reblogs, one for the comments.
 */
export async function followeeReblogEntries(userIds: string[], limit: number): Promise<TimedEntry[]> {
  const rows = await listReblogsOfUsers(userIds, limit);
  if (rows.length === 0) return [];
  const users = await findUsersByIds([...new Set(rows.map((r) => r.userId))]);
  const handleOf = new Map(users.map((u) => [u.userId, u.displayName]));
  const quotes = await quotesForQuoterTargets(rows.map((r) => ({ quoterKey: `u:${r.userId}`, author: r.targetAuthor, permlink: r.targetPermlink })));
  const entries = await Promise.all(
    rows.map(async (r): Promise<TimedEntry | null> => {
      const handle = handleOf.get(r.userId);
      if (!handle) return null;
      const post = await getPost(r.targetAuthor, r.targetPermlink, '').catch(() => null);
      if (!post) return null;
      const q = quotes.get(`u:${r.userId}|${r.targetAuthor}/${r.targetPermlink}`);
      const entry: Entry = {
        ...post,
        reblogged_by: [handle],
        ...(q ? { _quote: { quoter: handle, author: q.quoteAuthor, permlink: q.quotePermlink, body: q.bodyCache, ...(q.state === 'pending' ? { pending: true } : {}) } } : {})
      };
      // Placed in the feed by WHEN IT WAS REBLOGGED; the card still dates the post itself.
      return { entry, ms: r.createdAt.getTime() };
    })
  );
  return entries.filter((e): e is TimedEntry => e !== null);
}

export { mergeLiteProfile, parseLiteCursor } from './lite-profile-merge';

