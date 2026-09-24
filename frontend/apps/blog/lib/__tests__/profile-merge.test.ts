/**
 * The profile Posts tab merge (lib/profile/profile-merge.ts): own posts + reblogs,
 * newest first, two cursors. Plain assertions, no runner. Exits 0 when all pass.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/__tests__/profile-merge.test.ts
 */
import { mergeProfilePage, type BlogEntry, type OwnPost } from '../profile/profile-merge';

let checks = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures++;
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

const T = (h: number) => `2026-09-24T${String(h).padStart(2, '0')}:00:00`;
const post = (p: string, h: number): OwnPost => ({ author: 'me', permlink: p, created: T(h) });
const own = (p: string, id: number): BlogEntry => ({ author: 'me', permlink: p, entryId: id, rebloggedOn: '1970-01-01T00:00:00' });
const rb = (a: string, p: string, id: number, h: number): BlogEntry => ({ author: a, permlink: p, entryId: id, rebloggedOn: T(h) });
const keys = (r: ReturnType<typeof mergeProfilePage>) => r.items.map((i) => `${i.kind === 'post' ? 'P' : 'R'}:${i.permlink}`).join(' ');

// Page 1: posts at 10, 8, 6; reblogs at 9 and 7 with an own post between them in the blog.
const p1 = mergeProfilePage({
  account: 'me',
  cursor: { post: null, blog: null },
  posts: [post('p10', 10), post('p8', 8), post('p6', 6)],
  postsFull: false,
  blog: [rb('bob', 'r9', 9, 9), own('p8', 8), rb('amy', 'r7', 7, 7)],
  blogFull: false,
  limit: 3
});
check('page 1: newest first across both streams', keys(p1) === 'P:p10 R:r9 P:p8', keys(p1));
check('page 1: posts resume after the last post shown', p1.next.post?.permlink === 'p8');
check('page 1: the blog resumes at the first reblog NOT shown', p1.next.blog === 7, String(p1.next.blog));
check('page 1: more to come', p1.hasMore);

// Page 2 from those cursors (the bridge repeats the start post).
const p2 = mergeProfilePage({
  account: 'me',
  cursor: p1.next,
  posts: [post('p8', 8), post('p6', 6)],
  postsFull: false,
  blog: [rb('amy', 'r7', 7, 7), own('p5', 6)],
  blogFull: false,
  limit: 3
});
check('page 2: the start post is not shown twice', keys(p2) === 'R:r7 P:p6', keys(p2));
check('page 2: the end (neither stream full, nothing left)', !p2.hasMore && p2.next.blog === -1);

// A blog page of only own posts is skipped past, never re-read forever.
const p3 = mergeProfilePage({
  account: 'me',
  cursor: { post: null, blog: null },
  posts: [post('a', 5)],
  postsFull: false,
  blog: [own('x', 20), own('y', 19)],
  blogFull: true,
  limit: 5
});
check('a full blog page with no reblogs: move past it', p3.next.blog === 18 && p3.hasMore, JSON.stringify(p3.next));

// Reblogging your own post: shown once.
const p4 = mergeProfilePage({
  account: 'me',
  cursor: { post: null, blog: null },
  posts: [post('mine', 3)],
  postsFull: false,
  blog: [rb('me', 'mine', 4, 4)],
  blogFull: false,
  limit: 5
});
check('a self-reblog is shown once', p4.items.length === 1, keys(p4));

// The limit holds and nothing is lost past it.
const p5 = mergeProfilePage({
  account: 'me',
  cursor: { post: null, blog: null },
  posts: [post('p1', 1)],
  postsFull: false,
  blog: [rb('a', 'r5', 5, 5), rb('b', 'r4', 4, 4), rb('c', 'r3', 3, 3)],
  blogFull: false,
  limit: 2
});
check('limit 2: the two newest', keys(p5) === 'R:r5 R:r4', keys(p5));
check('...the rest is still reachable (blog resumes at r3, posts untouched)', p5.next.blog === 3 && p5.next.post === null && p5.hasMore);

// eslint-disable-next-line no-console
console.log(failures === 0 ? `PASS — ${checks} checks` : `FAIL — ${failures} of ${checks} checks failed`);
process.exit(failures === 0 ? 0 : 1);
