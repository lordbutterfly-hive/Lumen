/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * Self-test for the Hive-user quote service (spec v2 7.2, 7.4): prepare, confirm on
 * chain, removed. Real Postgres; the Hive node is a stub (`fetch` answers
 * `condenser_api.get_content` from a fixture map), so nothing reaches a chain.
 *
 *   S1  prepare: off when switched off; a Hive post and a Lumen post can be quoted; a
 *       comment and a quote cannot; the owner's block refuses; no container, no quote
 *   S2  confirm: nothing on chain; a comment under someone else's post; a marker naming
 *       another post; then the real one goes live and counts toward its container
 *   S3  confirm twice: one row, counted once; an edit refreshes the card text
 *   S4  removed: refused while the text is still there; accepted once blanked
 *   S5  after a blank: confirm refuses it; prepare edits it under its OWN container even
 *       after a roll; a re-quote is not counted twice; a new quote goes to the newest
 *       container; a permlink already used outside a quote container is refused
 *   S6  removal plan: delete when Hive allows it, blank when it has replies, nothing
 *       when there is nothing (or only a blank) on chain
 *   S8  reconcile: a Hive user's comment that was never confirmed is indexed from the
 *       quote container's replies; a known one, one without a marker, or a lite one is
 *       left alone
 *   S7  feed decoration: a reblog entry gets its reblogger's LIVE comment; no comment,
 *       no reblog or a pending one get nothing; an upgraded account is found by its id
 *
 * SAFETY: refuses unless LITE_DATABASE_URL ends in `_selftest`; truncates the quote,
 * container, block, rate and user tables.
 *
 * Run (from apps/blog):
 *   LITE_QUOTE_REBLOGS_ENABLED=yes LITE_FRONTEND_ACCOUNT_MAINNET=pub LITE_FRONTEND_ACCOUNT_MIRRORNET=pub \
 *   LITE_FRONTEND_ACCOUNT_TESTNET=pub LITE_DATABASE_URL=postgresql://user:pw@127.0.0.1:5433/lite_selftest \
 *   pnpm exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/lite/content/quote-service.selftest.ts
 */
const DB_URL = process.env.LITE_DATABASE_URL || '';
if (!/_selftest(\?.*)?$/.test(DB_URL)) {
  console.error('REFUSING TO RUN: LITE_DATABASE_URL must name a scratch database ending in "_selftest".');
  process.exit(1);
}

type Fixture = Record<string, unknown>;
const chain = new Map<string, Fixture>();
/** Comments the node answers "was deleted" for (a real delete_comment landed). */
const deletedOnChain = new Set<string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string; params?: [string, string] };
  if (body.method === 'condenser_api.get_content_replies') {
    const [pa, pp] = body.params ?? ['', ''];
    const replies = [...chain.values()].filter((c) => c.parent_author === pa && c.parent_permlink === pp);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: replies }), { status: 200 });
  }
  if (body.method !== 'condenser_api.get_content') return realFetch(_url as string, init as RequestInit);
  const [a, p] = body.params ?? ['', ''];
  const hit = chain.get(`${a}/${p}`);
  // A missing comment is answered the way current nodes answer it (testnet hived 1.28.3,
  // seen 2026-09-24): an assertion error, not an empty shell.
  if (deletedOnChain.has(`${a}/${p}`)) {
    const error = { code: -31999, data: `Post ${a}/${p} was deleted 1 time(s)`, message: 'Invalid parameters' };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error }), { status: 200 });
  }
  if (!hit) {
    const error = { code: -32602, message: 'Assert Exception', data: { code: 10, extension: { assertion_expression: `Post ${a}/${p} does not exist` } } };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error }), { status: 200 });
  }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: hit }), { status: 200 });
}) as typeof fetch;

import { DELETED_BODY } from '@transaction/lib/deleted-body';
import { query } from '../db/pool';
import { runMigrations } from '../db/migrate';
import { liteConfig } from '../config';
import * as containers from '../repositories/container-repository';
import * as quotes from '../repositories/quote-repository';
import { block } from '../repositories/block-repository';
import { confirmHiveQuote, confirmHiveQuoteRemoved, planHiveQuoteRemoval, prepareHiveQuote, reconcileHiveQuotes } from './quote-service';
import { attachQuotes } from './quote-attach';
import * as users from '../repositories/user-repository';

const PUB = liteConfig.frontendAccount;
let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

function put(author: string, permlink: string, fields: Fixture): void {
  chain.set(`${author}/${permlink}`, { author, permlink, parent_author: '', parent_permlink: 'hive', depth: 0, body: 'x', json_metadata: '{}', children: 0, net_rshares: 0, cashout_time: '2026-10-01T00:00:00', ...fields });
}

async function main(): Promise<void> {
  if (!PUB || !liteConfig.quoteReblogsEnabled) {
    console.error('Set LITE_FRONTEND_ACCOUNT_* and LITE_QUOTE_REBLOGS_ENABLED=yes. Aborting.');
    process.exit(1);
  }
  await runMigrations();
  await query('TRUNCATE lumen_quote, lumen_container, lumen_block, rate_counter, lumen_user CASCADE');
  const alice = { hive: 'alice' };

  put('bob', 'how-rc-works', {});
  put(PUB, 'lumen-01m14tvm9fkp5kgnccpxgm8vy7', { parent_author: PUB, parent_permlink: 'lumen-c-01aaa', depth: 1 });
  put('carol', 're-bob-1', { parent_author: 'bob', parent_permlink: 'how-rc-works', depth: 1 });
  put('dave', 'lumen-rq-0000000000000000', { parent_author: PUB, parent_permlink: 'lumen-q-01bbb', depth: 1 });

  console.log('S1  prepare');
  (liteConfig as { quoteReblogsEnabled: boolean }).quoteReblogsEnabled = false;
  const off = await prepareHiveQuote(alice, 'alice', 'bob', 'how-rc-works');
  check("switched off: 'disabled'", !off.ok && off.reason === 'disabled');
  (liteConfig as { quoteReblogsEnabled: boolean }).quoteReblogsEnabled = true;
  const noC = await prepareHiveQuote(alice, 'alice', 'bob', 'how-rc-works');
  check("no published quote container yet: 'no_container'", !noC.ok && noC.reason === 'no_container');
  const c = await containers.ensureLiveContainer(PUB, 'quote', 1000, 900);
  await containers.markPublished(c.containerId);
  const ok1 = await prepareHiveQuote(alice, 'alice', 'bob', 'how-rc-works');
  check('a Hive post can be quoted, under the published quote container', ok1.ok && ok1.value.parentPermlink === c.hivePermlink && ok1.value.parentAuthor === PUB, JSON.stringify(ok1));
  check('the permlink is the deterministic one', ok1.ok && ok1.value.permlink === quotes.quotePermlinkFor('bob', 'how-rc-works'));
  const lite = await prepareHiveQuote(alice, 'alice', PUB, 'lumen-01m14tvm9fkp5kgnccpxgm8vy7');
  check('a Lumen post (child of lumen-c-) can be quoted', lite.ok, JSON.stringify(lite));
  const cmt = await prepareHiveQuote(alice, 'alice', 'carol', 're-bob-1');
  check("a comment cannot: 'not_a_post'", !cmt.ok && cmt.reason === 'not_a_post');
  const qq = await prepareHiveQuote(alice, 'alice', 'dave', 'lumen-rq-0000000000000000');
  check("a quote cannot: 'is_a_quote'", !qq.ok && qq.reason === 'is_a_quote');
  const gone = await prepareHiveQuote(alice, 'alice', 'bob', 'no-such-post');
  check("a missing post: 'not_found'", !gone.ok && gone.reason === 'not_found');
  await block({ hive: 'bob' }, { hive: 'mallory' });
  const blk = await prepareHiveQuote({ hive: 'mallory' }, 'mallory', 'bob', 'how-rc-works');
  check("the post's owner blocked them: 'blocked'", !blk.ok && blk.reason === 'blocked');

  console.log('S2  confirm on chain');
  const permlink = quotes.quotePermlinkFor('bob', 'how-rc-works');
  const none = await confirmHiveQuote(alice, 'alice', 'bob', 'how-rc-works');
  check("nothing broadcast yet: 'not_on_chain'", !none.ok && none.reason === 'not_on_chain');
  const marker = JSON.stringify({ type: 'lumen_quote', quote_of: { author: 'bob', permlink: 'how-rc-works' } });
  put('alice', permlink, { parent_author: 'somebody', parent_permlink: 'lumen-q-fake', depth: 1, json_metadata: marker });
  const wp = await confirmHiveQuote(alice, 'alice', 'bob', 'how-rc-works');
  check("under a container that is not ours: 'wrong_parent'", !wp.ok && wp.reason === 'wrong_parent');
  put('alice', permlink, { parent_author: PUB, parent_permlink: c.hivePermlink, depth: 1, json_metadata: JSON.stringify({ type: 'lumen_quote', quote_of: { author: 'bob', permlink: 'other' } }) });
  const wt = await confirmHiveQuote(alice, 'alice', 'bob', 'how-rc-works');
  check("a marker naming another post: 'wrong_target'", !wt.ok && wt.reason === 'wrong_target');
  put('alice', permlink, { parent_author: PUB, parent_permlink: c.hivePermlink, depth: 1, json_metadata: marker, body: 'Clearest RC explainer.\n\nReblogged from @bob: [How RC works](https://lumensocial.net/hive/@bob/how-rc-works)' });
  const live = await confirmHiveQuote(alice, 'alice', 'bob', 'how-rc-works');
  check('the real one goes live, caption without the link line', live.ok && live.value.state === 'live' && live.value.bodyCache === 'Clearest RC explainer.', JSON.stringify(live.ok && live.value.bodyCache));
  check('it counts toward its container', (await containers.findByPermlink(PUB, c.hivePermlink))?.childCount === 1);

  console.log('S3  idempotent, edits');
  const again = await confirmHiveQuote(alice, 'alice', 'bob', 'how-rc-works');
  check('confirming twice: same row', again.ok && live.ok && again.value.quoteId === live.value.quoteId);
  check('...counted once', (await containers.findByPermlink(PUB, c.hivePermlink))?.childCount === 1);
  put('alice', permlink, { parent_author: PUB, parent_permlink: c.hivePermlink, depth: 1, json_metadata: marker, body: 'Edited: still the clearest.\n\nReblogged from @bob: [How RC works](https://x)' });
  const edited = await confirmHiveQuote(alice, 'alice', 'bob', 'how-rc-works');
  check('an edit refreshes the card text', edited.ok && edited.value.bodyCache === 'Edited: still the clearest.', JSON.stringify(edited.ok && edited.value.bodyCache));

  console.log('S4  removed');
  const still = await confirmHiveQuoteRemoved(alice, 'bob', 'how-rc-works');
  check("text still on chain: 'still_on_chain'", !still.ok && still.reason === 'still_on_chain');
  // The real blank a Hive user signs (removeQuote, mode 'blank'): DELETED_BODY, marker kept.
  put('alice', permlink, { parent_author: PUB, parent_permlink: c.hivePermlink, depth: 1, json_metadata: marker, body: DELETED_BODY });
  const removed = await confirmHiveQuoteRemoved(alice, 'bob', 'how-rc-works');
  check('blanked: removed, and the person may quote again', removed.ok && removed.value.removed && (await quotes.findActive(alice, 'bob', 'how-rc-works')) === null);

  console.log('S5  after a blank');
  const rolledTo = await containers.ensureLiveContainer(PUB, 'quote', 2, 1);
  await containers.markPublished(rolledTo.containerId);
  check('(setup) a newer quote container is published', rolledTo.containerId !== c.containerId && (await containers.latestPublished(PUB, 'quote'))?.containerId === rolledTo.containerId);
  const blankConfirm = await confirmHiveQuote(alice, 'alice', 'bob', 'how-rc-works');
  check("confirming a blanked comment: 'not_on_chain', never live", !blankConfirm.ok && blankConfirm.reason === 'not_on_chain');
  const reprep = await prepareHiveQuote(alice, 'alice', 'bob', 'how-rc-works');
  check('prepare edits the blanked comment under its OWN container, not the newest', reprep.ok && reprep.value.edit && reprep.value.parentPermlink === c.hivePermlink, JSON.stringify(reprep));
  check('...and hands out the clean marker (no `deleted`)', reprep.ok && !('deleted' in reprep.value.jsonMetadata) && reprep.value.jsonMetadata.type === 'lumen_quote');
  check('remove plan for a blanked comment: nothing to remove', (await planHiveQuoteRemoval('alice', 'bob', 'how-rc-works')) === null);
  put('alice', permlink, { parent_author: PUB, parent_permlink: c.hivePermlink, depth: 1, json_metadata: marker, body: 'Back again.\n\nReblogged from @bob: [x](https://x)' });
  const requote = await confirmHiveQuote(alice, 'alice', 'bob', 'how-rc-works');
  check('the re-quote goes live as a new row', requote.ok && requote.value.state === 'live' && live.ok && requote.value.quoteId !== live.value.quoteId);
  check('...and the same comment is not counted twice', (await containers.findByPermlink(PUB, c.hivePermlink))?.childCount === 1);
  const carol = await prepareHiveQuote({ hive: 'carol' }, 'carol', 'bob', 'how-rc-works');
  check('a new quote goes to the newest published container, as a create', carol.ok && !carol.value.edit && carol.value.parentPermlink === rolledTo.hivePermlink, JSON.stringify(carol));
  put('erin', permlink, { parent_author: 'bob', parent_permlink: 'how-rc-works', depth: 1 });
  const taken = await prepareHiveQuote({ hive: 'erin' }, 'erin', 'bob', 'how-rc-works');
  check("their permlink is already a plain reply: 'wrong_parent'", !taken.ok && taken.reason === 'wrong_parent');

  console.log('S6  removal plan');
  const p1 = await planHiveQuoteRemoval('alice', 'bob', 'how-rc-works');
  check('no replies, no votes: delete', p1?.mode === 'delete' && p1.parentPermlink === c.hivePermlink && p1.permlink === permlink, JSON.stringify(p1));
  put('alice', permlink, { parent_author: PUB, parent_permlink: c.hivePermlink, depth: 1, json_metadata: marker, body: 'Back again.', children: 2 });
  check('it has replies: blank', (await planHiveQuoteRemoval('alice', 'bob', 'how-rc-works'))?.mode === 'blank');
  put('alice', permlink, { parent_author: PUB, parent_permlink: c.hivePermlink, depth: 1, json_metadata: marker, body: 'Back again.', net_rshares: '1200' });
  check('net-positive votes: blank', (await planHiveQuoteRemoval('alice', 'bob', 'how-rc-works'))?.mode === 'blank');
  check('nothing on chain: nothing to remove', (await planHiveQuoteRemoval('zed', 'bob', 'how-rc-works')) === null);
  // A real delete_comment landed: the node now answers "was deleted", not "does not exist".
  chain.delete(`alice/${permlink}`);
  deletedOnChain.add(`alice/${permlink}`);
  check('deleted on chain: nothing left to remove', (await planHiveQuoteRemoval('alice', 'bob', 'how-rc-works')) === null);
  const deletedNow = await confirmHiveQuoteRemoved(alice, 'bob', 'how-rc-works');
  check('deleted on chain: the quote is marked removed', deletedNow.ok && deletedNow.value.removed, JSON.stringify(deletedNow));
  deletedOnChain.delete(`alice/${permlink}`);
  // (Quote again, so S7 has alice's live comment to attach.)
  put('alice', permlink, { parent_author: PUB, parent_permlink: rolledTo.hivePermlink, depth: 1, json_metadata: marker, body: 'Back again.' });
  check('(setup) quoted again after the delete', (await confirmHiveQuote(alice, 'alice', 'bob', 'how-rc-works')).ok);

  console.log('S7  feed decoration');
  type E = Parameters<typeof attachQuotes>[0][number];
  const up = await users.createUser({ displayName: 'upgraded' });
  await users.markUpgraded(up.userId, 'ursula');
  await quotes.insertQuote({ quoter: { userId: up.userId }, targetAuthor: 'bob', targetPermlink: 'p2', quoteAuthor: 'ursula', quotePermlink: 'lumen-rq-u', containerAuthor: PUB, containerPermlink: c.hivePermlink, bodyCache: 'From an upgraded account.', state: 'live' });
  await quotes.insertQuote({ quoter: { hive: 'carl' }, targetAuthor: 'bob', targetPermlink: 'p3', quoteAuthor: 'carl', quotePermlink: 'lumen-rq-c', containerAuthor: PUB, containerPermlink: c.hivePermlink, bodyCache: 'still pending', state: 'pending' });
  const page = [
    { author: 'bob', permlink: 'how-rc-works', reblogged_by: ['alice'] },
    { author: 'bob', permlink: 'p2', reblogged_by: ['ursula'] },
    { author: 'bob', permlink: 'p3', reblogged_by: ['carl'] },
    { author: 'bob', permlink: 'p4', reblogged_by: ['dora'] },
    { author: 'bob', permlink: 'how-rc-works' }
  ] as unknown as E[];
  await attachQuotes(page);
  check("alice's live comment rides on her reblog", page[0]._quote?.body === 'Back again.' && page[0]._quote?.author === 'alice' && page[0]._quote?.quoter === 'alice', JSON.stringify(page[0]._quote));
  check("an upgraded account's comment is found by its Lumen id", page[1]._quote?.body === 'From an upgraded account.', JSON.stringify(page[1]._quote));
  check('a pending comment, no comment, or no reblog: nothing attached', !page[2]._quote && !page[3]._quote && !page[4]._quote);
  await block({ hive: 'bob' }, { hive: 'alice' });
  const page2 = (await attachQuotes([
    { author: 'bob', permlink: 'how-rc-works', reblogged_by: ['alice'] },
    { author: 'bob', permlink: 'p2', reblogged_by: ['ursula'] }
  ] as unknown as E[])) as E[];
  check("D7: bob blocked alice, so alice's quote of bob's post is withheld; ursula's stays", page2.length === 1 && page2[0].permlink === 'p2', JSON.stringify(page2.map((e) => e.permlink)));

  console.log('S8  reconcile');
  const zoePermlink = quotes.quotePermlinkFor('bob', 'p9');
  put('bob', 'p9', {});
  put('zoe', zoePermlink, { parent_author: PUB, parent_permlink: rolledTo.hivePermlink, depth: 1, body: 'Never confirmed.', json_metadata: JSON.stringify({ type: 'lumen_quote', quote_of: { author: 'bob', permlink: 'p9' } }) });
  put('yan', quotes.quotePermlinkFor('bob', 'p8'), { parent_author: PUB, parent_permlink: rolledTo.hivePermlink, depth: 1, body: 'No marker.', json_metadata: '{}' });
  const r1 = await reconcileHiveQuotes();
  check('the unconfirmed comment is indexed, live', r1.indexed === 1 && (await quotes.findActive({ hive: 'zoe' }, 'bob', 'p9'))?.state === 'live', JSON.stringify(r1));
  check('one without a marker is left alone', !(await quotes.findActive({ hive: 'yan' }, 'bob', 'p8')));
  const r2 = await reconcileHiveQuotes();
  check('a second run finds nothing new', r2.indexed === 0 && r2.checked === 0, JSON.stringify(r2));

  await query('TRUNCATE lumen_quote, lumen_container, lumen_block, rate_counter, lumen_user CASCADE');
  console.log(failures === 0 ? `PASS — ${checks} checks` : `FAIL — ${failures} of ${checks} checks failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('FAIL — the self-test threw:', error);
  process.exit(1);
});
