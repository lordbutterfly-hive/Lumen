import type { Entry } from '@hive/common-hiveio-packages/wax';
import { siteConfig } from '@ui/config/site';
import { getAccountPostsPage, getPost } from '@transaction/lib/bridge-api';
import { mergeProfilePage, type BlogEntry, type ProfileCursor } from './profile-merge';

const BLOG_READ_TIMEOUT_MS = 8000;
/** The deepest the blog stream is read (hivemind's cap on one `get_blog_entries`). */
const BLOG_WINDOW_MAX = 500;

/**
 * Entries `offset .. offset+limit` of the owner's blog stream, newest first, and
 * whether more may follow. Always read from the newest (start 0) and sliced: a start
 * other than 0 is not a reliable cursor on hivemind (see BlogEntry.offset).
 */
async function readBlogEntries(account: string, offset: number, limit: number): Promise<{ entries: BlogEntry[]; full: boolean }> {
  const window = Math.min(offset + limit, BLOG_WINDOW_MAX);
  if (offset >= window) return { entries: [], full: false };
  const res = await fetch(siteConfig.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'condenser_api.get_blog_entries', params: [account, 0, window], id: 1 }),
    signal: AbortSignal.timeout(BLOG_READ_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`get_blog_entries failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    result?: { author: string; permlink: string; entry_id: number; reblogged_on: string }[];
    error?: unknown;
  };
  if (data.error) throw new Error(`get_blog_entries error: ${JSON.stringify(data.error).slice(0, 200)}`);
  const all = data.result ?? [];
  const entries = all.slice(offset, window).map((e, i) => ({ author: e.author, permlink: e.permlink, offset: offset + i, rebloggedOn: e.reblogged_on }));
  return { entries, full: all.length >= window && window < BLOG_WINDOW_MAX };
}

export interface ProfilePage {
  entries: Entry[];
  next: ProfileCursor;
  hasMore: boolean;
}

/**
 * The profile Posts tab page: own posts and reblogs merged newest first
 * (profile-merge.ts). Each reblog entry is marked `reblogged_by: [account]` (so cards
 * draw the "reblogged" line and the comment attaches) and carries `_blogOffset`.
 */
export async function fetchProfilePage(
  account: string,
  observer: string,
  cursor: ProfileCursor,
  limit: number
): Promise<ProfilePage | null> {
  const [postsPage, blog] = await Promise.all([
    getAccountPostsPage('posts', account, observer, cursor.post?.author ?? '', cursor.post?.permlink ?? '', limit),
    cursor.blog === -1 ? Promise.resolve({ entries: [] as BlogEntry[], full: false }) : readBlogEntries(account, cursor.blog ?? 0, limit)
  ]);
  if (!postsPage.entries) return null;
  const own = new Map(postsPage.entries.map((e) => [`${e.author}/${e.permlink}`, e]));
  const merged = mergeProfilePage({
    account,
    cursor,
    posts: postsPage.entries.map((e) => ({ author: e.author, permlink: e.permlink, created: e.created })),
    postsFull: postsPage.rawCount >= limit,
    blog: blog.entries,
    blogFull: blog.full,
    limit
  });
  const entries = await Promise.all(
    merged.items.map(async (item): Promise<Entry | null> => {
      if (item.kind === 'post') return own.get(`${item.author}/${item.permlink}`) ?? null;
      // A reblogged post that is gone or banned is simply not shown.
      const post = await getPost(item.author, item.permlink, observer).catch(() => null);
      return post ? { ...post, reblogged_by: [account], _blogOffset: item.offset } : null;
    })
  );
  return { entries: entries.filter((e): e is Entry => e !== null), next: merged.next, hasMore: merged.hasMore };
}
