/**
 * UNIT TESTS for `lib/root-post-link.ts` — the post a comment was made on.
 *
 * Run by `pnpm --filter @hive/blog test:unit`, which executes every
 * `lib/**\/*.test.ts` directly under ts-node. There is no jest or vitest in
 * this repo, so this file carries its own check/report harness and exits
 * non-zero on failure, matching `profile-info-concurrent-fetch.test.ts`.
 *
 * The fixtures are VERBATIM from mainnet, read on 2026-09-14 via
 * `bridge.get_account_posts{sort:"comments", account:"lumenpublisher"}`.
 * They are the real shapes the helper has to survive, not invented ones.
 */
import { rootPostHref, rootPostTitle } from '../root-post-link';

let checks = 0;
let failures = 0;

function ok(label: string, actual: unknown, expected: unknown) {
  checks++;
  if (actual === expected) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function group(name: string) {
  console.log(`\n${name}`);
}

/** depth 2: a nested reply, whose parent_permlink names another COMMENT. */
const NESTED_REPLY_ON_HIVE_POST = {
  url: '/dog/@acidyo/dogfooding#@lumenpublisher/lumen-01m2gqpbjsf4pmvjkb9j4jrdqz',
  title: 'RE: dogfooding',
  category: 'dog',
  depth: 2,
  parent_author: 'wiseagent',
  parent_permlink: 're-acidyo-2026914t162145907z'
};

const DIRECT_REPLY_ON_HIVE_POST = {
  url: '/dog/@acidyo/dogfooding#@lumenpublisher/lumen-01m2gnsrqkvbbbys8t8ah1drwz',
  title: 'RE: dogfooding',
  category: 'dog',
  depth: 1,
  parent_author: 'acidyo',
  parent_permlink: 'dogfooding'
};

/** A lite comment on ANOTHER lite post: the root author is the publisher. */
const REPLY_ON_A_LITE_POST = {
  url: '/lumen/@lumenpublisher/lumen-c-01m14t5hxvdews58rf7c5rq5eb#@lumenpublisher/lumen-01m26dxwzbscehncp852jdx0zq',
  title: 'RE: Lumen posts — 2026-08-28',
  category: 'lumen',
  depth: 1,
  parent_author: 'lumenpublisher',
  parent_permlink: 'lumen-c-01m14t5hxvdews58rf7c5rq5eb'
};

group('rootPostHref: resolves to the POST, not the comment');
ok(
  'nested reply still yields the root post',
  rootPostHref(NESTED_REPLY_ON_HIVE_POST),
  '/dog/@acidyo/dogfooding'
);
ok('direct reply yields the root post', rootPostHref(DIRECT_REPLY_ON_HIVE_POST), '/dog/@acidyo/dogfooding');

group('rootPostHref: a lite parent is addressed by permlink, never by name');
const liteHref = rootPostHref(REPLY_ON_A_LITE_POST);
ok('lite root resolves', liteHref, '/lumen/@lumenpublisher/lumen-c-01m14t5hxvdews58rf7c5rq5eb');
// The squatting guarantee, asserted rather than assumed: the destination is the
// chain author plus a permlink. No lite handle appears anywhere in the path, so
// there is no name for a stranger to register on Hive and intercept.
ok('path carries the chain author', liteHref?.includes('/@lumenpublisher/'), true);
ok('path is permlink-addressed', /\/lumen-c-[0-9a-z]{26}$/.test(liteHref ?? ''), true);

group('rootPostHref: parent fallback only where the parent IS the post');
ok(
  'depth 1 falls back to the parent when url is unusable',
  rootPostHref({ ...DIRECT_REPLY_ON_HIVE_POST, url: undefined }),
  '/dog/@acidyo/dogfooding'
);
ok(
  'depth 2 returns null rather than link to the wrong place',
  rootPostHref({ ...NESTED_REPLY_ON_HIVE_POST, url: undefined }),
  null
);

group('rootPostHref: refuses anything that would leave Lumen');
const hostile: [string, string][] = [
  ['protocol-relative', '//evil.example/@a/b'],
  ['absolute http', 'https://evil.example/@a/b'],
  ['javascript scheme', 'javascript:alert(1)'],
  ['no author segment', '/dog/acidyo/dogfooding'],
  ['smuggled query', '/dog/@acidyo/dog?next=//evil.example'],
  ['empty', '']
];
for (const [label, url] of hostile) {
  // depth 2 so the parent fallback cannot mask a rejection
  ok(label, rootPostHref({ ...NESTED_REPLY_ON_HIVE_POST, url }), null);
}

group('rootPostTitle');
ok('strips the Bridge RE: prefix', rootPostTitle(DIRECT_REPLY_ON_HIVE_POST), 'dogfooding');
// ★ THE REGRESSION THAT REACHED PRODUCTION (2026-09-15). `/api/account-posts`
// applies the lite identity overlay, which REPLACES `entry.title` with the lite
// post's own title. Without the prefix check, the comment's title was printed as
// though it named the post replied to: two different labels on the same root.
ok('a title with NO prefix is refused, not passed through', rootPostTitle({ title: 'dogfooding' }), null);
ok('the real overlaid lite title is refused', rootPostTitle({ title: 'test' }), null);
ok('another overlaid lite title is refused', rootPostTitle({ title: 'Just trying out lumen' }), null);
// The link itself must survive that refusal, or the post becomes unreachable again.
ok(
  'the href still resolves when the title is refused',
  rootPostHref({ ...REPLY_ON_A_LITE_POST, title: 'test' }),
  '/lumen/@lumenpublisher/lumen-c-01m14t5hxvdews58rf7c5rq5eb'
);
ok('keeps punctuation in a lite title', rootPostTitle(REPLY_ON_A_LITE_POST), 'Lumen posts — 2026-08-28');
ok('empty title yields null', rootPostTitle({ title: '' }), null);
ok('missing title yields null', rootPostTitle({}), null);
ok('a bare RE: yields null, not an empty link', rootPostTitle({ title: 'RE: ' }), null);

if (failures === 0) {
  console.log(`\nroot-post-link: ALL ${checks} CHECKS PASSED`);
  process.exit(0);
} else {
  console.error(`\nroot-post-link: ${failures}/${checks} CHECK(S) FAILED`);
  process.exit(1);
}
