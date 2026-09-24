/**
 * The profile Posts tab as a person's own posts PLUS their reblogs, newest first
 * (quote reblog spec v2 7.8, owner decision: "allow plain reblogs on your profile").
 *
 * Hive has no single stream for it. `bridge.get_account_posts({sort:'posts'})` is
 * every own post (community ones included) by creation time; the blog stream
 * (`condenser_api.get_blog_entries`) is own non-community posts plus reblogs, each
 * reblog with its `reblogged_on` time (own posts there read 1970). So a page is merged
 * from both, and each keeps its own cursor. Pure: no I/O, so the paging rules are
 * testable (lib/__tests__/profile-merge.test.ts).
 */

export interface OwnPost {
  author: string;
  permlink: string;
  /** ISO time the post was created. */
  created: string;
}

export interface BlogEntry {
  author: string;
  permlink: string;
  entryId: number;
  /** ISO time it was reblogged (own posts in the blog stream read 1970). */
  rebloggedOn: string;
}

export interface ProfileCursor {
  /** Own posts: continue after this post (null = from the newest). */
  post: { author: string; permlink: string } | null;
  /** Blog stream: the next entry id to read, inclusive (null = from the newest; -1 = done). */
  blog: number | null;
}

export type ProfileItem =
  | { kind: 'post'; author: string; permlink: string; time: string }
  | { kind: 'reblog'; author: string; permlink: string; time: string; entryId: number };

export interface MergedPage {
  items: ProfileItem[];
  next: ProfileCursor;
  hasMore: boolean;
}

/**
 * Merge one fetched page of each stream. `postsFull` / `blogFull` say whether that
 * stream returned a full page (so more may exist past it). `account` is the profile's
 * owner: blog entries by anyone else are their reblogs.
 */
export function mergeProfilePage(input: {
  account: string;
  cursor: ProfileCursor;
  posts: OwnPost[];
  postsFull: boolean;
  blog: BlogEntry[];
  blogFull: boolean;
  limit: number;
}): MergedPage {
  const account = input.account.toLowerCase();
  const after = input.cursor.post;
  // The bridge may or may not repeat the post a page starts after; never show it twice.
  const posts = input.posts.filter((p) => !(after && p.author === after.author && p.permlink === after.permlink));
  const reblogs = input.blog.filter((b) => b.author.toLowerCase() !== account);

  const candidates: ProfileItem[] = [
    ...posts.map((p) => ({ kind: 'post' as const, author: p.author, permlink: p.permlink, time: p.created })),
    ...reblogs.map((b) => ({ kind: 'reblog' as const, author: b.author, permlink: b.permlink, time: b.rebloggedOn, entryId: b.entryId }))
  ];
  // Newest first; a post and a reblog of the same moment keep a stable order.
  candidates.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : a.kind === b.kind ? 0 : a.kind === 'post' ? -1 : 1));

  // One post may appear as both (a person reblogging their own post): show it once.
  const seen = new Set<string>();
  const items: ProfileItem[] = [];
  for (const c of candidates) {
    if (items.length >= input.limit) break;
    const key = `${c.author}/${c.permlink}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(c);
  }

  // Own posts: continue after the last one shown; untouched if none was shown.
  const lastPost = [...items].reverse().find((i) => i.kind === 'post');
  const postsLeft = posts.some((p) => !items.some((i) => i.kind === 'post' && i.author === p.author && i.permlink === p.permlink));
  const nextPost = lastPost ? { author: lastPost.author, permlink: lastPost.permlink } : input.cursor.post;

  // Blog: resume at the first reblog NOT shown (entries are newest first); own posts in
  // the blog stream are always skippable (the posts stream carries them).
  const firstUnshownReblog = reblogs.find((b) => !items.some((i) => i.kind === 'reblog' && i.entryId === b.entryId));
  let nextBlog: number | null;
  if (firstUnshownReblog) nextBlog = firstUnshownReblog.entryId;
  else if (input.blog.length > 0) nextBlog = input.blogFull ? Math.min(...input.blog.map((b) => b.entryId)) - 1 : -1;
  else nextBlog = input.blogFull ? input.cursor.blog : -1;
  if (nextBlog !== null && nextBlog < 0) nextBlog = -1;

  const hasMore = postsLeft || input.postsFull || !!firstUnshownReblog || nextBlog !== -1;
  return { items, next: { post: nextPost, blog: nextBlog }, hasMore };
}
