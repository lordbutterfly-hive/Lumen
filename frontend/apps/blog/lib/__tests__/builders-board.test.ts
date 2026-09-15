/**
 * UNIT TESTS for the pure half of `lib/builders-board.ts` — how one builder's
 * Bridge page becomes (or refuses to become) a row on the card.
 *
 * Run by `pnpm --filter @hive/blog test:unit` under ts-node; own harness.
 */
import type { Entry } from '@hive/common-hiveio-packages/wax';
// ★ THE PURE MODULE, NEVER THE LOADER. `../builders-board` imports the chain
// client, which ts-node cannot resolve (`ERR_PACKAGE_PATH_NOT_EXPORTED` on
// `@hiveio/wax`'s ESM exports) — and one such import aborts the entire
// `test:unit` run at this file, so every suite after it never runs. See
// `builders-board-shape.ts`.
import { shapeBuilderRow, POSTS_PER_BUILDER } from '../builders-board-shape';

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

const entry = (author: string, permlink: string, title = 'A title', category = 'dev', created = '2026-09-14T10:00:00'): Entry =>
  ({ author, permlink, title, category, created } as unknown as Entry);

console.log('\nrefuses to invent a row');
ok('null page -> no row', shapeBuilderRow('howo', null) === null);
ok('empty page -> no row', shapeBuilderRow('howo', []) === null);
ok(
  'a page of only reblogs -> no row',
  shapeBuilderRow('howo', [entry('someone-else', 'x'), entry('another', 'y')]) === null
);

console.log('\nroot posts by the builder only');
const mixed = [
  entry('howo', 'core-dev-meeting-84', 'Core dev meeting #84'),
  entry('reblogged-author', 'their-post', 'Not howo'), // a reblog in the page
  entry('HOWO', 'case-insensitive', 'Case'), // the chain is lower-case, the list may not be
  entry('howo', 'untitled', '   '), // no title to show
  entry('howo', 'no-category', 'T', '')
];
const row = shapeBuilderRow('howo', mixed);
ok('a row is produced', row !== null);
ok('the reblog is dropped', !row?.posts.some((p) => p.permlink === 'their-post'));
ok('author match is case-insensitive', row?.posts.some((p) => p.permlink === 'case-insensitive') === true);
ok('a blank title is dropped', !row?.posts.some((p) => p.permlink === 'untitled'));
ok('a missing category is dropped', !row?.posts.some((p) => p.permlink === 'no-category'));
ok('the title is trimmed and kept', row?.posts[0]?.title === 'Core dev meeting #84');
ok('created passes through untouched', row?.posts[0]?.created === '2026-09-14T10:00:00');

console.log('\ncapped at POSTS_PER_BUILDER');
const many = Array.from({ length: POSTS_PER_BUILDER + 5 }, (_, i) => entry('howo', `p${i}`, `Post ${i}`));
ok(`${POSTS_PER_BUILDER + 5} posts -> ${POSTS_PER_BUILDER} kept`, shapeBuilderRow('howo', many)?.posts.length === POSTS_PER_BUILDER);
ok('and it keeps the FIRST ones (newest first from the Bridge)', shapeBuilderRow('howo', many)?.posts[0]?.permlink === 'p0');

if (failures === 0) {
  console.log(`\nbuilders-board: ALL ${checks} CHECKS PASSED`);
  process.exit(0);
} else {
  console.error(`\nbuilders-board: ${failures}/${checks} CHECK(S) FAILED`);
  process.exit(1);
}
