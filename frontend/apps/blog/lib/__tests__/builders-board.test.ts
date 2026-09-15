/**
 * UNIT TESTS for the pure half of the builders board
 * (`lib/builders-board-shape.ts`): which posts count as development, and how
 * one builder's Bridge page becomes (or refuses to become) a row.
 *
 * Run by `pnpm --filter @hive/blog test:unit` under ts-node; own harness.
 * ★ Imports the PURE module only — `../builders-board` imports the chain
 * client, which ts-node cannot resolve, and one such import aborts the whole
 * runner at this file.
 */
import type { Entry } from '@hive/common-hiveio-packages/wax';
import { shapeBuilderRow, isDevelopmentPost, tagsOf, postAgeMs, POSTS_PER_BUILDER, MAX_POST_AGE_MS } from '../builders-board-shape';
import type { Builder } from '../builders-board-shape';

let checks = 0;
let failures = 0;
function ok(label: string, pass: boolean, detail = '') {
  checks++;
  if (pass) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A root post as the Bridge returns it. Tags may arrive as an object or a JSON string. */
const post = (
  author: string,
  permlink: string,
  opts: { title?: string; category?: string; tags?: string[]; created?: string; metaAsString?: boolean } = {}
): Entry => {
  const meta = { tags: opts.tags ?? [] };
  return {
    author,
    permlink,
    title: opts.title ?? 'A title',
    category: opts.category ?? 'hive',
    created: opts.created ?? '2026-09-14T10:00:00',
    json_metadata: opts.metaAsString ? JSON.stringify(meta) : meta
  } as unknown as Entry;
};

// ★ Fixtures are the REAL tag shapes measured on mainnet, 2026-09-15.
const LORDBUTTERFLY: Builder = { account: 'lordbutterfly', mode: 'dev', tags: ['lumen', 'magi', 'hivewatch', 'freechain'] };
const ACIDYO: Builder = { account: 'acidyo', mode: 'dev', tags: ['scrobble', 'holozing'] };
const SNAPIE: Builder = { account: 'snapie', mode: 'all' };
const NEOXIAN_LIKE: Builder = { account: 'neoxian', mode: 'dev' }; // a tribe account, no product tags

console.log('\ntagsOf');
ok('object metadata', tagsOf(post('a', 'p', { tags: ['Lumen', 'hive'] })).join() === 'lumen,hive');
ok('string metadata', tagsOf(post('a', 'p', { tags: ['devlog'], metaAsString: true })).join() === 'devlog');
ok('corrupt string metadata -> no tags, no throw', tagsOf({ json_metadata: '{nope' } as unknown as Entry).length === 0);

console.log('\nisDevelopmentPost: the owner\'s own feed, measured');
ok('"What Are Meritum Tokens?" tagged lumen,hive,magi -> development', isDevelopmentPost(LORDBUTTERFLY, post('lordbutterfly', 'p', { category: 'lumen', tags: ['lumen', 'hive', 'magi'] })));
ok('"Seedance // Hive Watch ads" tagged hive,lumen,frontend -> development', isDevelopmentPost(LORDBUTTERFLY, post('lordbutterfly', 'p', { category: 'hive', tags: ['hive', 'lumen', 'frontend'] })));
ok('"Product photography attempt" tagged photography,images,diy -> NOT', !isDevelopmentPost(LORDBUTTERFLY, post('lordbutterfly', 'p', { category: 'photography', tags: ['photography', 'images', 'diy'] })));
ok('a Vibes music contest post -> NOT', !isDevelopmentPost(LORDBUTTERFLY, post('lordbutterfly', 'p', { category: 'hive-140169', tags: ['hive', 'music', 'contest', 'vibes'] })));
ok('a rant tagged hive,rant,do,it -> NOT (hive alone is not building)', !isDevelopmentPost(LORDBUTTERFLY, post('lordbutterfly', 'p', { category: 'hive', tags: ['hive', 'rant', 'do', 'it'] })));
ok('"Killing Hive\'s Social Potential" tagged hive,rant,frontend -> NOT (frontend is not a product tag)', !isDevelopmentPost(LORDBUTTERFLY, post('lordbutterfly', 'p', { category: 'hive', tags: ['hive', 'rant', 'frontend'] })));

console.log('\nisDevelopmentPost: Scrobble lives on @acidyo');
ok('"Scrobble.life Updates" (category scrobble) -> development', isDevelopmentPost(ACIDYO, post('acidyo', 'p', { category: 'scrobble', tags: ['scrobble', 'life', 'updates'] })));
ok('"A new little update on Holozing MMO" tagged holozing -> development', isDevelopmentPost(ACIDYO, post('acidyo', 'p', { category: 'hive-131131', tags: ['holozing', 'mmo', 'update'] })));
ok('"WoW TBC lvl 10-X" -> NOT', !isDevelopmentPost(ACIDYO, post('acidyo', 'p', { category: 'hive-140217', tags: ['wow', 'tbc', 'hc'] })));
ok('"Is Hive oversold?" -> NOT', !isDevelopmentPost(ACIDYO, post('acidyo', 'p', { category: 'thoughts', tags: ['thoughts'] })));

console.log('\nisDevelopmentPost: a product account counts wholesale');
ok('any Snapie post -> development, whatever the tags', isDevelopmentPost(SNAPIE, post('snapie', 'p', { category: 'hive-178315', tags: ['cross-post'] })));

console.log('\nisDevelopmentPost: the loose matches the first draft got wrong are gone');
ok('"witness" alone (an earnings report) -> NOT', !isDevelopmentPost(NEOXIAN_LIKE, post('neoxian', 'p', { tags: ['witness', 'report'] })));
ok('"update" alone -> NOT', !isDevelopmentPost(NEOXIAN_LIKE, post('neoxian', 'p', { tags: ['update', 'news'] })));
ok('the account\'s own name as a tag -> NOT, unless it is a declared product tag', !isDevelopmentPost(NEOXIAN_LIKE, post('neoxian', 'p', { tags: ['neoxian', 'pob'] })));
ok('but witness-update (the ops post) -> development', isDevelopmentPost(NEOXIAN_LIKE, post('neoxian', 'p', { tags: ['witness-update'] })));
ok('and the HiveDevs community -> development', isDevelopmentPost(NEOXIAN_LIKE, post('neoxian', 'p', { category: 'hive-139531', tags: [] })));
ok('and howo\'s "core" category -> development', isDevelopmentPost({ account: 'howo', mode: 'dev' }, post('howo', 'p', { category: 'core', tags: ['dev', 'meeting'] })));

console.log('\nshapeBuilderRow: refuses to invent a row');
ok('null page -> no row', shapeBuilderRow(LORDBUTTERFLY, null) === null);
ok('empty page -> no row', shapeBuilderRow(LORDBUTTERFLY, []) === null);
ok('a page of only reblogs -> no row', shapeBuilderRow(SNAPIE, [post('someone-else', 'x'), post('another', 'y')]) === null);
ok('a person whose last 20 are all photography -> no row', shapeBuilderRow(LORDBUTTERFLY, [post('lordbutterfly', 'a', { category: 'photography', tags: ['photography'] })]) === null);

console.log('\nshapeBuilderRow: the last THREE development posts, newest first, nothing else');
const mixed = [
  post('lordbutterfly', 'meritum', { title: 'What Are Meritum Tokens?', category: 'lumen', tags: ['lumen'], created: '2026-09-11T00:00:00' }),
  post('lordbutterfly', 'launch', { title: 'Lumen: Bringing Meritum Tokens', category: 'lumen', tags: ['lumen', 'launch'], created: '2026-09-09T00:00:00' }),
  post('lordbutterfly', 'photo', { title: 'Product photography attempt', category: 'photography', tags: ['photography'], created: '2026-08-25T00:00:00' }),
  post('reblogged-author', 'their-post', { title: 'Not mine', tags: ['lumen'] }),
  post('LORDBUTTERFLY', 'seedance', { title: 'Seedance // Hive Watch ads', category: 'hive', tags: ['hive', 'lumen', 'frontend'], created: '2026-08-25T00:00:00' }),
  post('lordbutterfly', 'testing', { title: 'Testing.', category: 'lumen', tags: ['lumen'], created: '2026-08-08T00:00:00' }),
  post('lordbutterfly', 'rant', { title: 'Killing Hive\'s Social Potential', category: 'hive', tags: ['hive', 'rant', 'frontend'], created: '2026-07-08T00:00:00' }),
  post('lordbutterfly', 'untitled', { title: '   ', category: 'lumen', tags: ['lumen'] })
];
const row = shapeBuilderRow(LORDBUTTERFLY, mixed);
ok('a row is produced', row !== null);
ok(`exactly ${POSTS_PER_BUILDER} posts`, row?.posts.length === POSTS_PER_BUILDER);
ok('newest development post first', row?.posts[0]?.permlink === 'meritum');
ok('the photography post is skipped, the next development post takes its slot', row?.posts.map((p) => p.permlink).join() === 'meritum,launch,seedance');
ok('the reblog is dropped', !row?.posts.some((p) => p.permlink === 'their-post'));
ok('author match is case-insensitive', row?.posts.some((p) => p.permlink === 'seedance') === true);
ok('created passes through untouched', row?.posts[0]?.created === '2026-09-11T00:00:00');

console.log('\nshapeBuilderRow: nothing older than a year (the @imwatsi replay)');
const NOW = Date.parse('2026-09-15T12:00:00Z');
const IMWATSI: Builder = { account: 'imwatsi', mode: 'dev', tags: ['freebeings-dao'] };
const replay = [
  post('imwatsi', 'dao-live', { title: 'Back on Hive — and FreeBeings DAO is live', category: 'hive-139531', tags: ['freebeings-dao'], created: '2026-06-30T00:00:00' }),
  post('imwatsi', 'proposal-2023', { title: 'Proposal: FreeBeings.io LLC - HAF Development', category: 'hive-139531', tags: ['development'], created: '2023-04-15T00:00:00' }),
  post('imwatsi', 'report-2022', { title: '3rd HAF Projects Development Report for 2022', category: 'hive-139531', tags: ['haf'], created: '2022-07-21T00:00:00' })
];
const aged = shapeBuilderRow(IMWATSI, replay, NOW);
ok('the 2026 post is kept', aged?.posts.some((p) => p.permlink === 'dao-live') === true);
ok('the 2023 and 2022 posts are dropped', aged?.posts.length === 1);
ok('a row with one post is still a row (it just never flips)', aged !== null);
ok('a builder whose only development posts are older than a year -> no row', shapeBuilderRow(IMWATSI, replay.slice(1), NOW) === null);
ok('exactly a year old is kept, a day past it is not',
  postAgeMs('2025-09-15T12:00:00', NOW) <= MAX_POST_AGE_MS && postAgeMs('2025-09-14T11:59:59', NOW) > MAX_POST_AGE_MS);
ok('an unparseable created is treated as infinitely old', postAgeMs('not a date', NOW) === Number.POSITIVE_INFINITY);

if (failures === 0) {
  console.log(`\nbuilders-board: ALL ${checks} CHECKS PASSED`);
  process.exit(0);
} else {
  console.error(`\nbuilders-board: ${failures}/${checks} CHECK(S) FAILED`);
  process.exit(1);
}
