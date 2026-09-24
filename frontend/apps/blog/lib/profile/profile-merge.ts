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
  /**
   * Position in the blog stream counted from the newest (0 = newest). NOT hivemind's
   * entry id: `get_blog_entries` reads a start of 0 as "the newest", so paging by entry
   * id re-read the newest entries whenever a page ended at entry 0 (measured on the
   * testnet, 2026-09-24: the profile listed the same reblog twice).
   */
  offset: number;
  /** ISO time it was reblogged (own posts in the blog stream read 1970). */
  rebloggedOn: string;
}

export interface ProfileCursor {
  /** Own posts: continue after this post (null = from the newest). */
  post: { author: string; permlink: string } | null;
  /** Blog stream: how many entries from the newest are already done (null = 0; -1 = all done). */
  blog: number | null;
}

export type ProfileItem =
  | { kind: 'post'; author: string; permlink: string; time: string }
  | { kind: 'reblog'; author: string; permlink: string; time: string; offset: number };

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
    ...reblogs.map((b) => ({ kind: 'reblog' as const, author: b.author, permlink: b.permlink, time: b.rebloggedOn, offset: b.offset }))
  ];
  // Newest first; a post and a reblog of the same moment keep a stable order.
  candidates.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : a.kind === b.kind ? 0 : a.kind === 'post' ? -1 : 1));

  // One post may appear as both (a person reblogging their own post): show it once.
  const seen = new Set<string>();
  const items: ProfileItem[] = [];
  // Reblogs skipped as duplicates count as done, so the blog cursor never stalls on one.
  const doneOffsets = new Set<number>();
  for (const c of candidates) {
    if (items.length >= input.limit) break;
    const key = `${c.author}/${c.permlink}`;
    if (seen.has(key)) {
      if (c.kind === 'reblog') doneOffsets.add(c.offset);
      continue;
    }
    seen.add(key);
    items.push(c);
    if (c.kind === 'reblog') doneOffsets.add(c.offset);
  }

  // Own posts: continue after the last one shown; untouched if none was shown.
  const lastPost = [...items].reverse().find((i) => i.kind === 'post');
  const postsLeft = posts.some((p) => !items.some((i) => i.kind === 'post' && i.author === p.author && i.permlink === p.permlink));
  const nextPost = lastPost ? { author: lastPost.author, permlink: lastPost.permlink } : input.cursor.post;

  // Blog: resume at the first reblog NOT shown (entries are newest first); everything
  // before it was shown, or is an own post the posts stream already carries.
  const firstUnshownReblog = reblogs.find((b) => !doneOffsets.has(b.offset));
  const done = input.cursor.blog ?? 0;
  let nextBlog: number;
  if (firstUnshownReblog) nextBlog = firstUnshownReblog.offset;
  else if (input.blogFull) nextBlog = input.blog.length > 0 ? Math.max(...input.blog.map((b) => b.offset)) + 1 : done;
  else nextBlog = -1;

  const hasMore = postsLeft || input.postsFull || nextBlog !== -1;
  return { items, next: { post: nextPost, blog: nextBlog }, hasMore };
}
