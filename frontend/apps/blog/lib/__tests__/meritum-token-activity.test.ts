/**
 * UNIT TESTS for Meritum token activity (owner, 2026-10-06):
 *   - `features/creator-tokens/lib/vsc/token-activity.ts`: the indexer query,
 *     the row parsing, the per-table cursor paging, the wording, the amounts;
 *   - `features/wallet/lib/magi-history.ts`: a Meritum transfer on the wallet's
 *     Magi tab now shows its token amount (it printed "No funds moved").
 *
 * Run by `pnpm --filter @hive/blog test:unit` under ts-node; own harness.
 * ★ THE FIXTURES ARE REAL RESPONSES, captured 2026-10-06 from the mainnet
 * indexer (api.okinoko.io/hasura) and the mainnet Magi node
 * (vsc.techcoderx.com), not hand-written shapes.
 */
import {
  ALL_SOURCES,
  GROUP_SOURCES,
  buildTokenActivityQuery,
  compareActivityEvents,
  describeTokenActivity,
  displayTokenAccount,
  eventFromRow,
  formatHbdBaseUnits,
  formatTokenAmount,
  meritumTransferPayload,
  mergeTokenActivityPage,
  namedTokenAmount,
  parseTokenActivityGroup,
  parseTokenActivityResponse,
  tokenAccountHref,
  type TokenActivityCursor,
  type TokenActivityEvent,
  type TokenActivitySource
} from '../../features/creator-tokens/lib/vsc/token-activity';
import { describeMagiTransaction } from '../../features/wallet/lib/magi-history';
import { parseMagiTransactions } from '../lite/wallet/magi-transactions';

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

const MERITUM = 'vsc1BisggC1NtviuYN1mSR372HGSU6hUfdZARt';

// ───────────────────────────── amounts ─────────────────────────────
console.log('\namounts');

ok('a v6 two-place amount is kept', formatTokenAmount('8.58') === '8.58');
ok('a pre-v6 whole amount gets its two places', formatTokenAmount('2') === '2.00');
ok('one place is padded', formatTokenAmount('1.1') === '1.10');
ok('thousands are grouped like the rest of the wallet', formatTokenAmount('1234.5') === '1,234.50');
ok('★ a third place is CUT, never rounded up', formatTokenAmount('0.999') === '0.99');
ok('leading zeros do not survive', formatTokenAmount('007.5') === '7.50' && formatTokenAmount('0.88') === '0.88');
ok('junk, negatives and empties are null, never "0"', [formatTokenAmount('abc'), formatTokenAmount('-1'), formatTokenAmount(''), formatTokenAmount(null)].every((v) => v === null));
ok('a JSON number still formats', formatTokenAmount(8) === '8.00');
ok('HBD base units, 3 places', formatHbdBaseUnits('9991') === '9.991 HBD' && formatHbdBaseUnits('2000') === '2.000 HBD');
ok('sub-1 HBD keeps its leading zero', formatHbdBaseUnits('5') === '0.005 HBD' && formatHbdBaseUnits('718') === '0.718 HBD');
ok('large HBD is grouped', formatHbdBaseUnits('1234567') === '1,234.567 HBD');
ok('HBD that is not an integer string is null', formatHbdBaseUnits('9.991') === null && formatHbdBaseUnits('x') === null);
ok('a Hive account reads @name', displayTokenAccount('hive:lordbutterfly') === '@lordbutterfly');
ok(
  'a wallet DID is shortened like the holders list',
  displayTokenAccount('did:pkh:eip155:1:0xF434fb109Fb6467e4FC37345c48A8b23F11d329B') === '0xF434…329B'
);
ok('only a Hive name links to a profile', tokenAccountHref('hive:maestroask') === '/@maestroask' && tokenAccountHref('did:pkh:eip155:1:0xabc') === null);
ok('the amount names its token', namedTokenAmount('8', 'hive:lordbutterfly') === '8.00 @lordbutterfly tokens');
ok('an unreadable amount names nothing', namedTokenAmount('lots', 'hive:x') === null);

// ───────────────────────────── the query ─────────────────────────────
console.log('\nquery');

ok('four tabs, the unknown one rejected', parseTokenActivityGroup('orders') === 'orders' && parseTokenActivityGroup('nope') === null);
ok('All reads every table', GROUP_SOURCES.all.length === 10 && new Set(GROUP_SOURCES.all).size === 10);
ok(
  'the three narrower tabs cover every table exactly once',
  [...GROUP_SOURCES.transfers, ...GROUP_SOURCES.trades, ...GROUP_SOURCES.orders].sort().join() === [...ALL_SOURCES].sort().join()
);

const tokenQ = buildTokenActivityQuery({ kind: 'token', creator: 'hive:lordbutterfly' }, 'all', null, 12, MERITUM);
const declared = [...tokenQ.query.matchAll(/\$(w_[a-z]+):/g)].map((m) => m[1]).sort();
const passed = Object.keys(tokenQ.variables).filter((k) => k !== 'limit').sort();
ok('★ every declared variable is passed and vice versa (Hasura rejects strays)', declared.join() === passed.join() && declared.length === 10);
ok('each table is ordered newest first with the id as tie-break', (tokenQ.query.match(/order_by: \[\{indexer_block_height: desc\}, \{indexer_id: desc\}\]/g) ?? []).length === 10);
ok('★ the query selects no commission column (absent on the mainnet tables)', !/commission|retained_to/.test(tokenQ.query));
const wBought = JSON.stringify(tokenQ.variables.w_bought);
ok('a token page filters by creator and by OUR contract', wBought.includes('"creator":{"_eq":"hive:lordbutterfly"}') && wBought.includes(`"indexer_contract_id":{"_eq":"${MERITUM}"}`));
ok(
  'marketplace moves exclude graduations and burns',
  JSON.stringify(tokenQ.variables.w_matured).includes('"sender":{"_neq":""}') && JSON.stringify(tokenQ.variables.w_matured).includes('"recipient":{"_neq":""}')
);

const acctQ = buildTokenActivityQuery({ kind: 'account', account: 'hive:maestroask' }, 'all', null, 12, MERITUM);
ok('a received transfer is found by its recipient', JSON.stringify(acctQ.variables.w_transferred).includes('{"_or":[{"actor":{"_eq":"hive:maestroask"}},{"recipient":{"_eq":"hive:maestroask"}}]}'));
ok('★ a refund of an order goes to the ASKER, never the actor', JSON.stringify(acctQ.variables.w_declined).includes('"asker":{"_eq":"hive:maestroask"}') && JSON.stringify(acctQ.variables.w_reclaimed).includes('"asker"'));
ok('a delivered order pays the creator', JSON.stringify(acctQ.variables.w_answered).includes('"creator":{"_eq":"hive:maestroask"}'));
ok('a pushed wind-down payout is keyed on its holder', JSON.stringify(acctQ.variables.w_pushed).includes('"holder":{"_eq":"hive:maestroask"}'));

const cursor: TokenActivityCursor = { bought: { block: 100, id: 7 }, sold: 'done' };
const pagedQ = buildTokenActivityQuery({ kind: 'token', creator: 'hive:x' }, 'trades', cursor, 12, MERITUM);
ok('a finished table is not asked again', pagedQ.sources.join() === 'bought,refunded,pushed' && !pagedQ.query.includes('lumen_ct_sold_events'));
ok(
  'the cursor is "older block, or same block and lower id"',
  JSON.stringify(pagedQ.variables.w_bought).includes('{"_or":[{"indexer_block_height":{"_lt":100}},{"indexer_block_height":{"_eq":100},"indexer_id":{"_lt":7}}]}')
);
ok('a table with no cursor starts at the newest row', !JSON.stringify(pagedQ.variables.w_refunded).includes('indexer_block_height'));

// ───────────────────────────── parsing ─────────────────────────────
console.log('\nparsing');

/** Captured from api.okinoko.io/hasura, 2026-10-06 (lordbutterfly's token and account). */
const LIVE_INDEXER = {
  data: {
    transferred: [
      { creator: 'hive:lordbutterfly', actor: 'hive:lordbutterfly', recipient: 'hive:maestroask', amount: '8.00', indexer_id: 3, indexer_block_height: 110513651, indexer_ts: '2026-10-05T17:06:54', indexer_tx_hash: 'c0f11306e88986ace061f88f939e489f8ab26125' },
      { creator: 'hive:hbd-temp', actor: 'hive:hbd-temp', recipient: 'hive:lordbutterfly', amount: '1.10', indexer_id: 2, indexer_block_height: 110223021, indexer_ts: '2026-09-25T14:09:15', indexer_tx_hash: '02a6e4004ceb793fadec3ad2a4c77c47e85cb944' }
    ],
    bought: [
      { creator: 'hive:neoxian', actor: 'hive:lordbutterfly', minted: '8.58', total_due: '9991', indexer_id: 24, indexer_block_height: 110426514, indexer_ts: '2026-10-02T16:16:33', indexer_tx_hash: 'c33799a49671fd89f71630806e1fbc7f70086619' }
    ],
    sold: [
      { creator: 'hive:lordbutterfly', actor: 'hive:southgamer', sold: '2.00', net: '1971', indexer_id: 4, indexer_block_height: 110531328, indexer_ts: '2026-10-06T07:06:42', indexer_tx_hash: '2c0df294d4ff36c616ad88495bcb600e70baf145' }
    ],
    asked: [
      { creator: 'hive:neoxian', actor: 'hive:lordbutterfly', credits_spent: '0.88', indexer_id: 5, indexer_block_height: 110428503, indexer_ts: '2026-10-02T18:15:12', indexer_tx_hash: '5a95a142dfba9edee834ed709bb21164ae464d06' }
    ],
    declined: [
      { creator: 'hive:hbd-temp', asker: 'hive:lordbutterfly', credits: '0.99', indexer_id: 1, indexer_block_height: 110223532, indexer_ts: '2026-09-25T14:36:48', indexer_tx_hash: 'df4f854c42bc240e75fd561b1436f52ea94fe7c6' }
    ],
    answered: [
      { creator: 'hive:neoxian', credits_to_creator: '0.78', indexer_id: 4, indexer_block_height: 110435000, indexer_ts: '2026-10-02T23:41:33', indexer_tx_hash: 'aa' }
    ]
  }
};
const parsed = parseTokenActivityResponse(LIVE_INDEXER, ['transferred', 'bought', 'sold', 'asked', 'declined', 'answered']);
const sent = parsed.transferred![0];
ok('a transfer row parses with both sides', sent.from === 'hive:lordbutterfly' && sent.to === 'hive:maestroask' && sent.tokens === '8.00' && sent.hbd === null);
ok('★ the indexer time (UTC, no zone) gains its Z', sent.timestamp === '2026-10-05T17:06:54Z');
ok('the tx hash is the Magi transaction id', sent.txId === 'c0f11306e88986ace061f88f939e489f8ab26125');
const bought = parsed.bought![0];
ok('a buy comes from the market to the buyer and carries what was paid', bought.from === '' && bought.to === 'hive:lordbutterfly' && bought.tokens === '8.58' && bought.hbd === '9991');
ok('a sale goes from the seller to the market and carries what was received', parsed.sold![0].from === 'hive:southgamer' && parsed.sold![0].to === '' && parsed.sold![0].hbd === '1971');
ok('a declined order returns to its asker', parsed.declined![0].to === 'hive:lordbutterfly' && parsed.declined![0].from === 'hive:hbd-temp');
ok('a GraphQL error is thrown, never an empty history', (() => { try { parseTokenActivityResponse({ errors: [{ message: 'boom' }] }, ['bought']); return false; } catch { return true; } })());
ok('★ a table missing from the reply throws instead of ending its history', (() => { try { parseTokenActivityResponse({ data: {} }, ['bought']); return false; } catch { return true; } })());
ok('a row without its id or block is dropped, not guessed', eventFromRow('bought', { minted: '1' }) === null);
ok('numeric strings for ids are accepted', eventFromRow('sold', { indexer_id: '4', indexer_block_height: '110531328', sold: '2', net: '1' })?.block === 110531328);

// ───────────────────────────── paging ─────────────────────────────
console.log('\npaging');

/** A tiny deterministic PRNG so a failure is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** What Hasura does for one table: rows after the cursor, (block desc, id desc), at most `limit`. */
function fakeFetch(table: TokenActivityEvent[], cursor: TokenActivityCursor[TokenActivitySource], limit: number): TokenActivityEvent[] {
  const after = table.filter((e) => !cursor || cursor === 'done' || e.block < cursor.block || (e.block === cursor.block && e.id < cursor.id));
  return after.sort((a, b) => b.block - a.block || b.id - a.id).slice(0, limit);
}

let pagingRuns = 0;
let pagingBad = '';
for (let seed = 1; seed <= 60 && !pagingBad; seed++) {
  const r = rng(seed);
  const tables: Partial<Record<TokenActivitySource, TokenActivityEvent[]>> = {};
  for (const source of ALL_SOURCES) {
    const n = Math.floor(r() * (seed % 3 === 0 ? 40 : 9));
    const rows: TokenActivityEvent[] = [];
    for (let i = 1; i <= n; i++) {
      // Few distinct blocks, so many rows share a block across AND within tables.
      const block = 1000 + Math.floor(r() * 6);
      rows.push({ source, id: i, block, timestamp: '', txId: '', creator: 'hive:x', from: 'hive:a', to: 'hive:b', tokens: '1', hbd: null });
    }
    tables[source] = rows;
  }
  const truth = ALL_SOURCES.flatMap((s) => tables[s]!).sort(compareActivityEvents).map((e) => `${e.source}-${e.id}`);
  for (const limit of [1, 2, 3, 5, 12]) {
    pagingRuns++;
    const seen: string[] = [];
    let cur: TokenActivityCursor | null = null;
    let guard = 0;
    for (;;) {
      const sources = ALL_SOURCES.filter((s) => cur?.[s] !== 'done');
      const fetched: Partial<Record<TokenActivitySource, TokenActivityEvent[]>> = {};
      for (const s of sources) fetched[s] = fakeFetch(tables[s]!, cur?.[s], limit);
      const page = mergeTokenActivityPage(fetched, sources, cur, limit);
      if (page.events.length > limit) pagingBad = `seed ${seed} limit ${limit}: page over the limit`;
      seen.push(...page.events.map((e) => `${e.source}-${e.id}`));
      if (!page.next) break;
      cur = page.next;
      if (++guard > 2000) {
        pagingBad = `seed ${seed} limit ${limit}: never ended`;
        break;
      }
    }
    if (!pagingBad && seen.join() !== truth.join()) pagingBad = `seed ${seed} limit ${limit}: ${seen.length} paged vs ${truth.length} true`;
    if (pagingBad) break;
  }
}
ok(`★ paging every page of ${pagingRuns} random histories returns each row exactly once, in order`, pagingBad === '', pagingBad);
ok('an empty history is one empty, final page', (() => { const p = mergeTokenActivityPage({ bought: [] }, ['bought'], null, 12); return p.events.length === 0 && p.next === null; })());

// ───────────────────────────── rows ─────────────────────────────
console.log('\nrows: the token page');

/** A label as plain text, accounts in brackets: what the renderer turns into links. */
const words = (entry: ReturnType<typeof describeTokenActivity>) => entry.label.map((p) => ('text' in p ? p.text : `[${p.account}]`)).join('');

const pageSend = describeTokenActivity(sent, { kind: 'token' });
ok('who sent what to whom', words(pageSend) === '[hive:lordbutterfly] sent to [hive:maestroask]' && pageSend.amountText === '8.00 tokens');
ok('★ the public ledger has no + or -: nobody on it is "you"', pageSend.tone === 'neutral');
const pageBuy = describeTokenActivity(bought, { kind: 'token' });
ok('a buy names the buyer and what they paid', words(pageBuy) === '[hive:lordbutterfly] bought' && pageBuy.detail === 'Paid 9.991 HBD' && pageBuy.category === 'in');
const pageSell = describeTokenActivity(parsed.sold![0], { kind: 'token' });
ok('a sale names the seller and what they got', words(pageSell) === '[hive:southgamer] sold' && pageSell.detail === 'Got 1.971 HBD' && pageSell.amountText === '2.00 tokens');
ok('a declined order names who got the tokens back and who declined', words(describeTokenActivity(parsed.declined![0], { kind: 'token' })) === '[hive:lordbutterfly] got tokens back' && describeTokenActivity(parsed.declined![0], { kind: 'token' }).detail === '@hbd-temp declined the order');
ok('row keys are unique per table row', pageSend.key === 'transferred-3' && pageBuy.key === 'bought-24');

console.log('\nrows: my wallet');

const me = { kind: 'account' as const, account: 'hive:lordbutterfly' };
const mySend = describeTokenActivity(sent, me);
ok('★ what I sent: out, minus, to whom, which token', mySend.category === 'out' && mySend.tone === 'debit' && words(mySend) === 'Sent to [hive:maestroask]' && mySend.amountText === '8.00 @lordbutterfly tokens');
const theirReceive = describeTokenActivity(sent, { kind: 'account', account: 'hive:maestroask' });
ok('★ the same transfer for the recipient: in, plus, from whom', theirReceive.category === 'in' && theirReceive.tone === 'credit' && words(theirReceive) === 'Received from [hive:lordbutterfly]');
const myReceive = describeTokenActivity(parsed.transferred![1], me);
ok('what I received names the token it was', myReceive.tone === 'credit' && myReceive.amountText === '1.10 @hbd-temp tokens');
const myBuy = describeTokenActivity(bought, me);
ok('a buy is tokens in, with the HBD it cost', myBuy.tone === 'credit' && myBuy.amountText === '8.58 @neoxian tokens' && myBuy.detail === 'Paid 9.991 HBD');
const myOrder = describeTokenActivity(parsed.asked![0], me);
ok('an order is tokens out, to the creator', myOrder.tone === 'debit' && words(myOrder) === 'Ordered from [hive:neoxian]' && myOrder.amountText === '0.88 @neoxian tokens');
ok('a declined order is tokens back', describeTokenActivity(parsed.declined![0], me).tone === 'credit');
const paid = describeTokenActivity(parsed.answered![0], { kind: 'account', account: 'hive:neoxian' });
ok("a creator's delivered order is earnings", paid.category === 'reward' && paid.tone === 'credit' && paid.amountText === '0.78 @neoxian tokens');
const self = describeTokenActivity({ ...sent, to: 'hive:lordbutterfly' }, me);
ok('a send to yourself moves nothing: no sign', self.tone === 'neutral');

// ───────────────────────────── the Magi tab ─────────────────────────────
console.log('\nMagi tab: Meritum transfers');

ok('a Meritum transfer payload is read from its JSON string', JSON.stringify(meritumTransferPayload('{"creator":"hive:lordbutterfly","to":"hive:maestroask","amount":"8"}')) === '{"creator":"hive:lordbutterfly","to":"hive:maestroask","amount":"8"}');
ok('an object payload is read too', meritumTransferPayload({ creator: 'hive:a', to: 'hive:b', amount: 1.5 })?.amount === '1.5');
ok('a payload that is not a transfer is null', [meritumTransferPayload('{"creator":"hive:a","tokens":"2"}'), meritumTransferPayload('not json'), meritumTransferPayload('{"creator":"hive:a","to":"hive:b","amount":"-1"}')].every((v) => v === null));

/** Captured from vsc.techcoderx.com, 2026-10-06, with `required_auths` selected. */
const LIVE_MAGI = {
  data: {
    findTransaction: [
      {
        id: 'c0f11306e88986ace061f88f939e489f8ab26125', anchr_height: 110513651, anchr_ts: '2026-10-05T17:06:54', first_seen: '2026-10-05T17:06:55Z', status: 'CONFIRMED', type: 'hive',
        required_auths: ['hive:lordbutterfly'], ledger: [],
        ops: [{ data: { action: 'transfer', contract_id: MERITUM, intents: [], payload: '{"creator":"hive:lordbutterfly","to":"hive:maestroask","amount":"8"}', rc_limit: 4692 }, index: 0, type: 'call' }]
      },
      {
        id: 'e9f86902d87881b8433e3fdea2c8b7cc3bdea291', anchr_height: 110513155, anchr_ts: '2026-10-05T16:42:06', first_seen: '2026-10-05T16:42:08Z', status: 'FAILED', type: 'hive',
        required_auths: ['hive:lordbutterfly'], ledger: [],
        ops: [{ data: { action: 'transfer', contract_id: MERITUM, intents: [], payload: '{"creator":"hive:lordbutterfly","to":"hive:maestroask","amount":"8"}', rc_limit: 2497 }, index: 0, type: 'call' }]
      },
      {
        id: 'c33799a49671fd89f71630806e1fbc7f70086619', anchr_height: 110426514, anchr_ts: '2026-10-02T16:16:33', first_seen: '2026-10-02T16:16:36Z', status: 'CONFIRMED', type: 'hive',
        required_auths: ['hive:lordbutterfly'],
        ledger: [{ amount: 9991, asset: 'hbd', from: 'hive:lordbutterfly', memo: '', to: `contract:${MERITUM}`, type: 'transfer' }],
        ops: [{ data: { action: 'buy', contract_id: MERITUM, intents: [{ args: { decimals: '3', limit: '9.991', token: 'hbd' }, type: 'transfer.allow' }], payload: '{"creator":"hive:neoxian","tokens":"8.58"}', rc_limit: 4265 }, index: 0, type: 'call' }]
      }
    ]
  }
};
const magi = parseMagiTransactions(LIVE_MAGI);
ok('the signer is parsed from required_auths', magi[0].requiredAuths.join() === 'hive:lordbutterfly');
ok('an older reply without required_auths parses to no signer, not a throw', parseMagiTransactions({ data: { findTransaction: [{ id: 'x', ops: [], ledger: [] }] } })[0].requiredAuths.length === 0);

const names = { [MERITUM]: 'Meritum' };
const before = describeMagiTransaction(magi[0], 'hive:lordbutterfly', 'all', names)[0];
ok('(the bug, reproduced) without the contract id the transfer row has NO amount', before.amountText === null && before.labelKey.endsWith('contract_action_known'));

const sentRow = describeMagiTransaction(magi[0], 'hive:lordbutterfly', 'all', names, MERITUM)[0];
ok('★ FIXED: the sender sees the token amount and the token name', sentRow.amountText === '8.00 @lordbutterfly tokens');
ok('the sender row is money out, to the recipient', sentRow.category === 'out' && sentRow.tone === 'debit' && sentRow.labelKey.endsWith('meritum_sent') && sentRow.counterparty?.label === '@maestroask' && sentRow.counterparty?.direction === 'to');
const receivedRow = describeMagiTransaction(magi[0], 'hive:maestroask', 'all', names, MERITUM)[0];
ok('★ the recipient sees money in, from the sender', receivedRow.category === 'in' && receivedRow.tone === 'credit' && receivedRow.labelKey.endsWith('meritum_received') && receivedRow.counterparty?.label === '@lordbutterfly' && receivedRow.counterparty?.direction === 'from' && receivedRow.amountText === '8.00 @lordbutterfly tokens');
const failedRow = describeMagiTransaction(magi[1], 'hive:lordbutterfly', 'all', names, MERITUM)[0];
ok('★ a FAILED transfer keeps its amount but no sign: nothing moved', failedRow.status === 'failed' && failedRow.tone === 'neutral' && failedRow.amountText === '8.00 @lordbutterfly tokens');
const buyRow = describeMagiTransaction(magi[2], 'hive:lordbutterfly', 'all', names, MERITUM)[0];
ok('a Meritum buy is unchanged: the HBD that left, from the ledger', buyRow.amountText === '9.991 HBD' && buyRow.tone === 'debit' && buyRow.labelKey.endsWith('contract_action_known'));
const otherContract = describeMagiTransaction(magi[0], 'hive:lordbutterfly', 'all', {}, 'vsc1SomeOtherContract')[0];
ok('another contract called "transfer" is not read as Meritum', otherContract.amountText === null);
ok('the Contracts tab still holds the transfer call', describeMagiTransaction(magi[0], 'hive:lordbutterfly', 'contracts', names, MERITUM).length === 1 && describeMagiTransaction(magi[0], 'hive:lordbutterfly', 'transfers', names, MERITUM).length === 0);

if (failures === 0) {
  console.log(`\nmeritum-token-activity: ALL ${checks} CHECKS PASSED`);
  process.exit(0);
} else {
  console.error(`\nmeritum-token-activity: ${failures}/${checks} CHECK(S) FAILED`);
  process.exit(1);
}
