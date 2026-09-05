/**
 * Search logic invariants — plain assertions, no test runner (this repo has
 * none; same shape as `lib/__tests__/server-ttl-cache.test.ts`).
 *
 * RUN IT (from apps/blog, in the tree with node_modules):
 *   pnpm exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/search/__tests__/search-logic.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHAT IS PROVEN HERE
 *  1. query shapes: what text may become an account prefix, a tag, a people intent
 *  2. suggestion ranking: exact first, shortest next, lite/hive de-dup, caps
 *  3. the per-page re-rank: a fresh discussed post climbs, the tail cannot leap the head,
 *     the input is untouched, dates without a zone are read as UTC
 *  4. the suggest token bucket: burst, refill, isolation, fail-closed reset
 *  5. recent searches: de-dup, front-move, cap, hostile storage contents
 *  6. typeahead rows: order, hrefs, `@name` swaps the actions, arrow-key wrap
 *  7. browsable topics: community ids and tribe tags excluded
 */
import assert from 'node:assert/strict';
import {
  MAX_QUERY_LENGTH,
  accountPrefixOf,
  intendsPeople,
  isSuggestable,
  normalizeSearchText,
  tagPrefixOf
} from '../query';
import { MAX_ACCOUNT_SUGGESTIONS, MAX_TAG_SUGGESTIONS, rankSuggestions } from '../suggest-rank';
import { ageDaysOf, rerankScore, rerankSearchPage } from '../rerank';
import { SUGGEST_BURST, resetSuggestLimiter, takeSuggestToken } from '../suggest-limiter';
import { isBrowsableTopic } from '../topics';
import {
  MAX_RECENT_SEARCHES,
  addRecentSearch,
  parseRecentSearches
} from '../../../features/search/lib/recent-searches';
import {
  buildSuggestionRows,
  defaultRow,
  stepActiveIndex
} from '../../../features/search/lib/suggestion-rows';
import { mapBounded } from '../bounded';

let checks = 0;
let failures = 0;
const pending: Promise<void>[] = [];
function check(name: string, fn: () => void | Promise<void>): void {
  checks += 1;
  const run = async () => {
    try {
      await fn();
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  pending.push(run());
}

// 1. query shapes
check('normalizeSearchText trims, collapses whitespace, strips zero-width, caps length', () => {
  assert.equal(normalizeSearchText('  hive ​ engine\t\n now '), 'hive engine now');
  assert.equal(normalizeSearchText(null), '');
  assert.equal(normalizeSearchText('x'.repeat(200)).length, MAX_QUERY_LENGTH);
  assert.equal(normalizeSearchText('MiXed Case'), 'MiXed Case');
});
check('accountPrefixOf accepts only what a Hive name can start with', () => {
  assert.equal(accountPrefixOf('Photo'), 'photo');
  assert.equal(accountPrefixOf('@gtg'), 'gtg');
  assert.equal(accountPrefixOf('ab.c-d9'), 'ab.c-d9');
  assert.equal(accountPrefixOf('hello world'), null);
  assert.equal(accountPrefixOf('a'), null);
  assert.equal(accountPrefixOf('1abc'), null);
  assert.equal(accountPrefixOf('a'.repeat(17)), null);
  assert.equal(accountPrefixOf("o'brien"), null);
  assert.equal(accountPrefixOf('%'), null);
  assert.equal(accountPrefixOf('ab_'), null);
});
check('tagPrefixOf strips #, lowercases, hyphenates spaces, rejects punctuation', () => {
  assert.equal(tagPrefixOf('#Street Photo'), 'street-photo');
  assert.equal(tagPrefixOf('has space'), 'has-space');
  assert.equal(tagPrefixOf('x'), null);
  assert.equal(tagPrefixOf("don't"), null);
  assert.equal(tagPrefixOf('hive-engine'), 'hive-engine');
});
check('intendsPeople and isSuggestable', () => {
  assert.equal(intendsPeople('@gtg'), true);
  assert.equal(intendsPeople('  @gtg'), true);
  assert.equal(intendsPeople('gtg'), false);
  assert.equal(isSuggestable('a'), false);
  assert.equal(isSuggestable('ab'), true);
  assert.equal(isSuggestable('   '), false);
});

// 2. suggestion ranking
check('rankSuggestions: exact first, then shortest, then alphabetical', () => {
  const out = rankSuggestions({
    prefix: 'photo',
    tagPrefix: 'photo',
    hiveNames: ['photo-curator', 'photo-axel', 'photo', 'photo-808'],
    liteUsers: [],
    trendingTags: ['photography', 'photo', 'photofeed', 'cats']
  });
  assert.deepEqual(
    out.accounts.map((a) => a.name),
    ['photo', 'photo-808', 'photo-axel', 'photo-curator']
  );
  assert.deepEqual(out.tags, ['photo', 'photofeed', 'photography']);
});
check('rankSuggestions: lite handle colliding with a Hive name yields the Hive row; display name only when it differs', () => {
  const out = rankSuggestions({
    prefix: 'qa',
    tagPrefix: null,
    hiveNames: ['qa-bob'],
    liteUsers: [
      { displayName: 'QA-Bob', profileName: 'Bob' },
      { displayName: 'qa-alice', profileName: 'Alice Q' },
      { displayName: 'qa-same', profileName: 'QA-SAME' }
    ],
    trendingTags: ['qa-tag']
  });
  assert.deepEqual(out.accounts, [
    { name: 'qa-bob', kind: 'hive' },
    { name: 'qa-same', kind: 'lite' },
    { name: 'qa-alice', kind: 'lite', displayName: 'Alice Q' }
  ]);
  assert.deepEqual(out.tags, [], 'no tag prefix means no tag rows');
});
check('rankSuggestions: caps and null prefix', () => {
  const many = Array.from({ length: 20 }, (_, i) => `ab${String(i).padStart(2, '0')}`);
  const out = rankSuggestions({ prefix: 'ab', tagPrefix: 'ab', hiveNames: many, liteUsers: [], trendingTags: many });
  assert.equal(out.accounts.length, MAX_ACCOUNT_SUGGESTIONS);
  assert.equal(out.tags.length, MAX_TAG_SUGGESTIONS);
  const none = rankSuggestions({ prefix: null, tagPrefix: null, hiveNames: many, liteUsers: [{ displayName: 'ab01' }], trendingTags: many });
  assert.deepEqual(none, { accounts: [], tags: [] });
  const drift = rankSuggestions({ prefix: 'ab', tagPrefix: null, hiveNames: ['ab01', 'zz-not-a-prefix-match'], liteUsers: [], trendingTags: [] });
  assert.deepEqual(drift.accounts.map((a) => a.name), ['ab01'], 'a name outside the prefix window is dropped');
});

// 3. per-page re-rank
const NOW = Date.parse('2026-09-05T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString().slice(0, 19);
check('ageDaysOf reads zone-less hivemind timestamps as UTC and treats junk as very old', () => {
  const plain = ageDaysOf('2026-09-04T12:00:00', NOW);
  const zoned = ageDaysOf('2026-09-04T12:00:00Z', NOW);
  assert.equal(plain, zoned);
  assert.equal(Math.round(plain), 1);
  assert.ok(ageDaysOf('not a date', NOW) > 365 * 10);
  assert.ok(ageDaysOf(undefined, NOW) > 365 * 10);
  assert.equal(ageDaysOf(daysAgo(-5), NOW), 0, 'a future date does not go negative');
});
check('rerankSearchPage: a fresh, discussed post climbs over old keyword spam; the tail cannot leap the head', () => {
  const page = Array.from({ length: 20 }, (_, i) => ({
    id: i,
    created: daysAgo(365 * 8),
    children: 0,
    stats: { total_votes: 0 }
  }));
  page[10] = { id: 10, created: daysAgo(3), children: 5, stats: { total_votes: 40 } };
  page[19] = { id: 19, created: daysAgo(3), children: 5, stats: { total_votes: 40 } };
  const snapshot = JSON.stringify(page);
  const ranked = rerankSearchPage(page, NOW);
  assert.equal(JSON.stringify(page), snapshot, 'input untouched');
  assert.equal(ranked[0].id, 10, 'position 10 (fresh, discussed) ranks first');
  const idxHead = ranked.findIndex((e) => e.id === 0);
  const idxTail = ranked.findIndex((e) => e.id === 19);
  assert.ok(idxHead < idxTail, `upstream #1 (idx ${idxHead}) stays above upstream #20 (idx ${idxTail})`);
  assert.equal(ranked.length, 20);
});
check('rerankSearchPage: equal scores keep upstream order (stable), and net_votes is the fallback signal', () => {
  const same = Array.from({ length: 5 }, (_, i) => ({ id: i, created: daysAgo(10), children: 1, stats: { total_votes: 3 } }));
  assert.deepEqual(rerankSearchPage(same, NOW).map((e) => e.id), [0, 1, 2, 3, 4]);
  const a = rerankScore({ created: daysAgo(1), net_votes: 100 }, 0, 1, NOW);
  const b = rerankScore({ created: daysAgo(1), net_votes: 0 }, 0, 1, NOW);
  assert.ok(a > b);
  assert.deepEqual(rerankSearchPage([], NOW), []);
});

// 4. token bucket
check('takeSuggestToken: burst, then refuse, then refill; keys isolated', () => {
  resetSuggestLimiter();
  const t0 = 1_000_000;
  for (let i = 0; i < SUGGEST_BURST; i++) assert.equal(takeSuggestToken('ip:a', t0), true, `token ${i}`);
  assert.equal(takeSuggestToken('ip:a', t0), false, 'burst exhausted');
  assert.equal(takeSuggestToken('ip:b', t0), true, 'another key is unaffected');
  assert.equal(takeSuggestToken('ip:a', t0 + 500), true, 'half a second refills one token at 120/min');
  assert.equal(takeSuggestToken('ip:a', t0 + 500), false);
  for (let i = 0; i < SUGGEST_BURST; i++) assert.equal(takeSuggestToken('ip:a', t0 + 120_000), true, 'refilled to the cap after two minutes');
  assert.equal(takeSuggestToken('ip:a', t0 + 120_000), false, 'never above the cap');
  resetSuggestLimiter();
  assert.equal(takeSuggestToken('ip:a', t0), true, 'reset restores the burst');
});

// 5. recent searches
check('addRecentSearch de-dups case-insensitively, moves to the front, keeps the scope, caps', () => {
  let list: ReturnType<typeof addRecentSearch> = [];
  list = addRecentSearch(list, 'hive engine');
  list = addRecentSearch(list, 'photography', 'people');
  list = addRecentSearch(list, 'Hive Engine');
  assert.deepEqual(list, [{ q: 'Hive Engine' }, { q: 'photography', t: 'people' }]);
  list = addRecentSearch(list, 'photography', 'posts');
  assert.deepEqual(list[0], { q: 'photography' }, 'searching the same text in another scope replaces the entry');
  assert.deepEqual(addRecentSearch(list, '   '), list, 'blank is ignored');
  for (let i = 0; i < 20; i++) list = addRecentSearch(list, `q${i}`);
  assert.equal(list.length, MAX_RECENT_SEARCHES);
  assert.equal(list[0].q, 'q19');
  assert.equal(addRecentSearch([], 'x'.repeat(100))[0].q.length, 60);
});
check('parseRecentSearches trusts only well-formed entries and still reads the pre-scope string shape', () => {
  assert.deepEqual(parseRecentSearches(null), []);
  assert.deepEqual(parseRecentSearches('not json'), []);
  assert.deepEqual(parseRecentSearches('{"a":1}'), []);
  assert.deepEqual(parseRecentSearches('["a", 1, "", null, " b ", {"q":"c","t":"people"}, {"q":"d","t":"junk"}, {"q":""}, {"x":1}]'), [
    { q: 'a' },
    { q: ' b ' },
    { q: 'c', t: 'people' },
    { q: 'd' }
  ]);
  assert.equal(parseRecentSearches(JSON.stringify(Array(30).fill('x'))).length, MAX_RECENT_SEARCHES);
});

// 6. typeahead rows
check('buildSuggestionRows: empty text lists recent searches only, each with its own scope', () => {
  const rows = buildSuggestionRows({
    text: '  ',
    suggestions: { accounts: [{ name: 'gtg', kind: 'hive' }], tags: ['x'] },
    recent: [{ q: 'hive engine' }, { q: 'cats', t: 'people' }]
  });
  assert.deepEqual(rows.map((r) => r.kind), ['recent', 'recent']);
  assert.equal(rows[0].href, '/search?q=hive%20engine&s=relevance');
  assert.equal(rows[1].href, '/search?q=cats&s=relevance&t=people');
  assert.equal(rows[1].kind === 'recent' && rows[1].scope, 'people');
  assert.equal(defaultRow(rows), null);
});
check('buildSuggestionRows: actions first, then accounts, then tags, with the right hrefs', () => {
  const rows = buildSuggestionRows({
    text: 'photo',
    suggestions: { accounts: [{ name: 'photo', kind: 'hive' }, { name: 'photo-lite', kind: 'lite', displayName: 'Photo Lite' }], tags: ['photography'] },
    recent: [{ q: 'ignored while typing' }]
  });
  assert.deepEqual(rows.map((r) => r.kind), ['posts', 'people', 'account', 'account', 'tag']);
  assert.equal(rows[0].href, '/search?q=photo&s=relevance');
  assert.equal(rows[1].href, '/search?q=photo&s=relevance&t=people');
  assert.equal(rows[2].href, '/@photo');
  assert.equal(rows[4].href, '/topics/photography');
  assert.equal(defaultRow(rows)?.kind, 'posts');
  const ids = new Set(rows.map((r) => r.id));
  assert.equal(ids.size, rows.length, 'row ids are unique');
});
check('buildSuggestionRows: @name puts people first and strips the @ from the query', () => {
  const rows = buildSuggestionRows({ text: '@gtg', suggestions: null, recent: [] });
  assert.deepEqual(rows.map((r) => r.kind), ['people', 'posts']);
  assert.equal(rows[0].kind === 'people' && rows[0].query, 'gtg');
  assert.equal(rows[0].href, '/search?q=gtg&s=relevance&t=people');
  assert.equal(defaultRow(rows)?.kind, 'people');
});
check('buildSuggestionRows: a stale answer for another prefix contributes no rows; a superset answer keeps matching rows', () => {
  const stale = { accounts: [{ name: 'photo', kind: 'hive' as const }, { name: 'photo-808', kind: 'hive' as const }], tags: ['photography'] };
  const rows = buildSuggestionRows({ text: 'httpsqa', suggestions: stale, recent: [] });
  assert.deepEqual(rows.map((r) => r.kind), ['posts', 'people']);
  const forward = buildSuggestionRows({ text: 'photo-8', suggestions: stale, recent: [] });
  assert.deepEqual(forward.map((r) => (r.kind === 'account' ? r.name : r.kind)), ['posts', 'people', 'photo-808']);
  const phrase = buildSuggestionRows({ text: 'photo graphy', suggestions: stale, recent: [] });
  assert.deepEqual(phrase.map((r) => r.kind), ['posts', 'people'], '"photo graphy" is the tag prefix "photo-graphy", which "photography" does not start with');
  const hyphen = buildSuggestionRows({ text: 'hive eng', suggestions: { accounts: [], tags: ['hive-engine'] }, recent: [] });
  assert.deepEqual(hyphen.map((r) => r.kind), ['posts', 'people', 'tag'], 'a phrase cannot be an account but does hyphenate into a tag prefix');
});
check('stepActiveIndex wraps in both directions and handles an empty list', () => {
  assert.equal(stepActiveIndex(-1, 1, 3), 0);
  assert.equal(stepActiveIndex(-1, -1, 3), 2);
  assert.equal(stepActiveIndex(2, 1, 3), 0);
  assert.equal(stepActiveIndex(0, -1, 3), 2);
  assert.equal(stepActiveIndex(1, 1, 3), 2);
  assert.equal(stepActiveIndex(5, 1, 0), -1);
});

// 7. bounded fan-out
check('mapBounded never exceeds the limit, preserves order, and settles rejections', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 11 }, (_, i) => i);
  const settled = await mapBounded(items, 4, async (i) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5 + (i % 3) * 5));
    inFlight -= 1;
    if (i === 6) throw new Error('boom');
    return i * 10;
  });
  assert.equal(peak, 4, `peak concurrency ${peak}`);
  assert.equal(settled.length, 11);
  assert.deepEqual(settled.map((s) => (s.status === 'fulfilled' ? s.value : 'x')), [0, 10, 20, 30, 40, 50, 'x', 70, 80, 90, 100]);
  assert.deepEqual(await mapBounded([], 4, async () => 1), []);
});

// 8. topics
check('isBrowsableTopic excludes community ids, tribe tags and system tags', () => {
  assert.equal(isBrowsableTopic('photography'), true);
  assert.equal(isBrowsableTopic('hive-123456'), false);
  assert.equal(isBrowsableTopic('HIVE-1'), false);
  assert.equal(isBrowsableTopic('hbd'), false);
  assert.equal(isBrowsableTopic('nsfw'), false);
  assert.equal(isBrowsableTopic(''), false);
  assert.equal(isBrowsableTopic('splinterlands'), true);
});

void Promise.all(pending).then(() => {
  if (failures > 0) {
    console.error(`\nFAILED — ${failures} of ${checks} checks`);
    process.exit(1);
  }
  console.log(`PASS — ${checks} checks`);
});
