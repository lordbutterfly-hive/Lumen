/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * Self-test for quote reblogs step 3 (spec v2 7.1-7.3): the `lumen_quote` index
 * (migration 0050), the deterministic Hive-user permlink, and the publisher's quote
 * container supply. Real Postgres, fake broadcaster (records the ops, never reaches a
 * node).
 *
 *   Q1  the Hive-user permlink: deterministic, `lumen-rq-` + 16, never a lite permlink
 *   Q2  one quote per person per post while it exists; a removed one frees the slot
 *   Q3  the feed lookup returns only LIVE quotes, keyed by (quoter, post)
 *   Q4  container supply: a fresh quote container with nothing reserved; it rolls at
 *       the threshold only once published; the newest PUBLISHED one is handed out
 *   Q5  maintainQuoteContainer: off unless switched on; publishes ONE root with the
 *       quote family's title, metadata and declined payout
 *
 * SAFETY: refuses to run unless LITE_DATABASE_URL names a database ending in
 * `_selftest`; truncates lumen_container, lumen_quote and lumen_user.
 *
 * Run (from apps/blog):
 *   LITE_FRONTEND_ACCOUNT_MAINNET=test-publisher LITE_FRONTEND_ACCOUNT_MIRRORNET=test-publisher \
 *   LITE_FRONTEND_ACCOUNT_TESTNET=test-publisher \
 *   LITE_DATABASE_URL=postgresql://user:pw@127.0.0.1:5433/lite_selftest \
 *   pnpm exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/lite/publisher/quote-supply.selftest.ts
 */
const DB_URL = process.env.LITE_DATABASE_URL || '';
if (!/_selftest(\?.*)?$/.test(DB_URL)) {
  console.error('REFUSING TO RUN: LITE_DATABASE_URL must name a scratch database ending in "_selftest".');
  process.exit(1);
}

import { query } from '../db/pool';
import { runMigrations } from '../db/migrate';
import { liteConfig } from '../config';
import * as containers from '../repositories/container-repository';
import * as quotes from '../repositories/quote-repository';
import { isLumenPermlink, litePostIdOf } from '../render/lite-post-id';
import { CommentOp, PostBroadcaster } from './broadcaster';
import { maintainQuoteContainer } from './container';

const PUB = liteConfig.frontendAccount;
let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

const broadcasts: CommentOp[] = [];
const fake = {
  async broadcastComment(op: CommentOp) {
    broadcasts.push(op);
    return { id: 'tx' };
  },
  async postExists() {
    return false;
  }
} as unknown as PostBroadcaster;

async function main(): Promise<void> {
  if (!PUB) {
    console.error('LITE_FRONTEND_ACCOUNT_* is not set. Aborting.');
    process.exit(1);
  }
  await runMigrations();
  await query('TRUNCATE lumen_container, lumen_quote, lumen_user CASCADE');

  console.log('Q1  the Hive-user permlink');
  const p1 = quotes.quotePermlinkFor('bob', 'how-rc-works');
  check('deterministic', p1 === quotes.quotePermlinkFor('bob', 'how-rc-works'));
  check('different post, different permlink', p1 !== quotes.quotePermlinkFor('bob', 'how-rc-works-2'));
  check('`lumen-rq-` + 16 base36 characters', /^lumen-rq-[0-9a-z]{16}$/.test(p1), p1);
  check('never read as a lite post (no id recovered from it)', litePostIdOf({ permlink: p1 }) === undefined);
  check("never treated as Lumen's own namespace (the post page reads the chain for it)", !isLumenPermlink(p1));

  console.log('Q2  one quote per person per post');
  const base = {
    targetAuthor: 'bob',
    targetPermlink: 'how-rc-works',
    quoteAuthor: 'alice',
    quotePermlink: p1,
    containerAuthor: PUB,
    containerPermlink: 'lumen-q-01abc',
    bodyCache: 'clearest RC explainer',
    state: 'live' as const
  };
  const a1 = await quotes.insertQuote({ ...base, quoter: { hive: 'Alice' } });
  check('first quote is created', a1.created && a1.quote.quoterKey === 'h:alice', JSON.stringify(a1.quote.quoterKey));
  const a2 = await quotes.insertQuote({ ...base, quoter: { hive: 'alice' }, bodyCache: 'second try' });
  check('a second one returns the existing row, writes nothing', !a2.created && a2.quote.quoteId === a1.quote.quoteId && a2.quote.bodyCache === 'clearest RC explainer');
  await quotes.setState(a1.quote.quoteId, 'removed');
  const a3 = await quotes.insertQuote({ ...base, quoter: { hive: 'alice' }, bodyCache: 'again' });
  check('after removal the person can quote again', a3.created && a3.quote.quoteId !== a1.quote.quoteId);

  console.log('Q3  the feed lookup');
  await quotes.insertQuote({ ...base, quoter: { hive: 'carol' }, quoteAuthor: 'carol', state: 'pending' });
  const found = await quotes.liveQuotesForPairs([
    { quoterKey: 'h:alice', targetAuthor: 'bob', targetPermlink: 'how-rc-works' },
    { quoterKey: 'h:carol', targetAuthor: 'bob', targetPermlink: 'how-rc-works' },
    { quoterKey: 'h:dave', targetAuthor: 'bob', targetPermlink: 'how-rc-works' }
  ]);
  check('only the live quote comes back (alice), not pending (carol) or absent (dave)', found.size === 1 && found.has('h:alice|bob/how-rc-works'), JSON.stringify([...found.keys()]));

  console.log('Q4  quote container supply');
  const first = await containers.ensureLiveContainer(PUB, 'quote', 10, 9);
  check('a fresh quote container, nothing reserved', first.family === 'quote' && first.childCount === 0 && first.status === 'opening', JSON.stringify(first));
  check('asked again: the same one', (await containers.ensureLiveContainer(PUB, 'quote', 10, 9)).containerId === first.containerId);
  check('nothing handed out before a root is on chain', (await containers.latestPublished(PUB, 'quote')) === null);
  for (let i = 0; i < 9; i++) await containers.incrementChildCount(PUB, first.hivePermlink);
  const unpublishedFull = await containers.ensureLiveContainer(PUB, 'quote', 10, 9);
  check('an UNPUBLISHED container is never rolled (its root must go first)', unpublishedFull.containerId === first.containerId);
  await containers.markPublished(first.containerId);
  check('once published it is handed out', (await containers.latestPublished(PUB, 'quote'))?.containerId === first.containerId);
  const rolled = await containers.ensureLiveContainer(PUB, 'quote', 10, 9);
  check('at the threshold it rolls to a new quote container', rolled.containerId !== first.containerId && rolled.family === 'quote');
  const handed = await containers.latestPublished(PUB, 'quote');
  check('until the new root is published, the CLOSED one is still handed out', handed?.containerId === first.containerId && handed?.status === 'closed', JSON.stringify(handed?.status));
  check('the lite family is untouched', (await containers.findLive(PUB, 'lite')) === null);

  console.log('Q5  maintainQuoteContainer');
  await query('TRUNCATE lumen_container CASCADE');
  (liteConfig as { quoteReblogsEnabled: boolean }).quoteReblogsEnabled = false;
  check("'off' while quote reblogs are switched off, and nothing is broadcast", (await maintainQuoteContainer(fake)) === 'off' && broadcasts.length === 0);
  (liteConfig as { quoteReblogsEnabled: boolean }).quoteReblogsEnabled = true;
  const r1 = await maintainQuoteContainer(fake);
  const r2 = await maintainQuoteContainer(fake);
  check('switched on: ready, and ONE root broadcast across two ticks', r1 === 'ready' && r2 === 'ready' && broadcasts.length === 1, `${r1} ${r2} ${broadcasts.length}`);
  const op = broadcasts[0];
  const meta = op ? JSON.parse(op.jsonMetadata) : {};
  check('the root is a quote container post', !!op && op.parentAuthor === '' && op.permlink.startsWith('lumen-q-') && op.title.startsWith('Lumen reblog comments'), JSON.stringify(op && { p: op.permlink, t: op.title }));
  check('its metadata names the family and it declines payout', meta.lumen_container_family === 'quote' && op?.declinePayout === true);
  check('and it is now handed out', (await containers.latestPublished(PUB, 'quote'))?.hivePermlink === op?.permlink);

  await query('TRUNCATE lumen_container, lumen_quote, lumen_user CASCADE');
  console.log(failures === 0 ? `PASS — ${checks} checks` : `FAIL — ${failures} of ${checks} checks failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('FAIL — the self-test threw:', error);
  process.exit(1);
});
