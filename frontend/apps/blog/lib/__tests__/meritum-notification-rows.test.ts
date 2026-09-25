/** UNIT TESTS for `lib/meritum/notification-rows.ts`. Run by `pnpm --filter @hive/blog test:unit` under ts-node; own harness. */
import {
  meritumNotificationRows,
  deliveredWhere,
  mention,
  zoned,
  isUnread,
  unreadCount,
  marksAfterOpen,
  marksFromLegacy,
  SEEN_IDS_CAP,
  SELLER_INBOX_URL,
  BUYER_ASKS_URL,
  MERITUM_NOTIFICATIONS_QUERY,
  DELIVERED_FOR_ASKS_QUERY,
  type MeritumNotificationData,
  type LumenNotificationRow
} from '../meritum/notification-rows';

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

// The mainnet test case, verbatim from the indexer (2026-09-21): creator
// hive:hbd-temp, asker hive:lordbutterfly, seq 0, offering 1 "Let there be light!",
// asked 17:23:57, answered 17:34:30 ("TESTING TEST"), rated 5 at 17:41:18.
const CONTRACT = 'vsc1BisggC1NtviuYN1mSR372HGSU6hUfdZARt';
const asked = { creator: 'hive:hbd-temp', actor: 'hive:lordbutterfly', seq: 0, offering_id: 1, credits_spent: '1', indexer_ts: '2026-09-21T17:23:57' };
const sellerData: MeritumNotificationData = {
  bought: [
    { creator: 'hive:hbd-temp', actor: 'hive:lordbutterfly', minted: '2', total_due: '2124', indexer_ts: '2026-09-21T17:00:42', indexer_tx_hash: '6087c43d5fca665d4c37d8635189cb86f9095f9c' },
    // The creator's own launch first-buy: never a notification.
    { creator: 'hive:hbd-temp', actor: 'hive:hbd-temp', minted: '1', total_due: '1107', indexer_ts: '2026-09-05T02:53:21', indexer_tx_hash: 'f7b1a002cd131bc04c2b2e3475df0b52a623c736' }
  ],
  ordered: [asked],
  placed: [],
  declined: [],
  rated: [{ creator: 'hive:hbd-temp', actor: 'hive:lordbutterfly', seq: 0, score: 5, indexer_ts: '2026-09-21T17:41:18' }],
  missed: [{ creator: 'hive:hbd-temp', actor: 'hive:lordbutterfly', asker: 'hive:lordbutterfly', seq: 3, indexer_ts: '2026-09-23T10:00:00' }, { creator: 'hive:hbd-temp', actor: 'hive:hbd-temp', asker: 'hive:hbd-temp', seq: 4, indexer_ts: '2026-09-23T11:00:00' }],
  offerings: [
    { offering_id: 1, title: 'Let there be light!' },
    { offering_id: 2, title: 'test1' }
  ],
  renamed: []
};
const buyerData: MeritumNotificationData = {
  bought: [],
  ordered: [],
  placed: [asked],
  declined: [],
  rated: [],
  offerings: [],
  renamed: [],
  delivered: [{ creator: 'hive:hbd-temp', seq: 0, answer_hash: 'TESTING TEST', indexer_ts: '2026-09-21T17:34:30' }]
};

console.log('\nseller side: hive:hbd-temp');
const seller = meritumNotificationRows(sellerData, ['hive:hbd-temp']);
const byType = (rows: LumenNotificationRow[], t: string) => rows.filter((r) => r.type === t);
ok('one buy, the self-buy dropped', byType(seller, 'buy').length === 1);
ok('buy row links to the moved market page m/<handle>', byType(seller, 'buy')[0]?.url === 'm/hbd-temp');
ok('buy row names the buyer like every other row', byType(seller, 'buy')[0]?.msg === '@lordbutterfly bought 2 Meritum of yours for $2.12');
ok('buy row id is the tx hash', byType(seller, 'buy')[0]?.id === 'buy:hive:hbd-temp:6087c43d5fca665d4c37d8635189cb86f9095f9c');
const missed = byType(seller, 'missed');
ok('one missed row, the self-dealt reclaim dropped', missed.length === 1 && missed[0].id === 'missed:hive:hbd-temp:3');
ok('missed row tells the seller what happened and where', /reclaimed their tokens after the deadline passed; a miss is on your record/.test(missed[0]?.msg ?? '') && missed[0]?.url === 'creators/studio?section=inbox&tab=requests');
const order = byType(seller, 'order')[0];
ok('order row exists', !!order);
ok('order row names the service and the tokens', order?.msg === '@lordbutterfly ordered your "Let there be light!" for 1 token', order?.msg);
ok('order row links to the Studio requests inbox', order?.url === SELLER_INBOX_URL);
ok('order row date is zoned UTC', order?.date === '2026-09-21T17:23:57Z');
ok('order row actor is the asker handle', order?.actor === 'lordbutterfly');
ok('order row id is the escrow key', order?.id === 'order:hive:hbd-temp:0');
const rated = byType(seller, 'rated')[0];
ok('rated row exists', !!rated);
ok('rated row says N of 5', rated?.msg === '@lordbutterfly rated your delivery 5 of 5 stars', rated?.msg);
ok('rated row links to the Studio requests inbox', rated?.url === SELLER_INBOX_URL);
ok('rated row date is the rating block time, not the ask', rated?.date === '2026-09-21T17:41:18Z');
ok('rated row id is the escrow key', rated?.id === 'rated:hive:hbd-temp:0');
ok('seller gets nothing on the buyer side', byType(seller, 'order_placed').length === 0 && byType(seller, 'delivered').length === 0);
ok('exactly four seller rows (buy, order, rated, missed)', seller.length === 4, String(seller.length));

console.log('\nbuyer side: hive:lordbutterfly');
const buyer = meritumNotificationRows(buyerData, ['hive:lordbutterfly']);
const placed = byType(buyer, 'order_placed')[0];
ok('order_placed row exists', !!placed);
ok('order_placed sentence', placed?.msg === 'Your request to @hbd-temp is placed and waiting for their answer', placed?.msg);
ok('order_placed links to the inbox asks', placed?.url === BUYER_ASKS_URL);
ok('order_placed face is the creator', placed?.actor === 'hbd-temp');
const delivered = byType(buyer, 'delivered')[0];
ok('delivered row exists', !!delivered);
ok('delivered sentence', delivered?.msg === '@hbd-temp delivered your request', delivered?.msg);
ok('delivered links to the inbox asks', delivered?.url === BUYER_ASKS_URL);
ok('delivered date is the answer block time', delivered?.date === '2026-09-21T17:34:30Z');
ok('delivered id is the escrow key', delivered?.id === 'delivered:hive:hbd-temp:0');
ok('exactly two buyer rows', buyer.length === 2, String(buyer.length));

console.log('\ndeclined, self-asks, titles, wallet identities');
const declined = meritumNotificationRows(
  { declined: [{ creator: 'hive:gtg', asker: 'hive:alice', seq: 4, indexer_ts: '2026-09-20T10:00:00' }] },
  ['hive:alice']
);
ok('declined sentence + link', declined[0]?.msg === '@gtg declined your request and refunded your tokens' && declined[0]?.url === BUYER_ASKS_URL);
const selfAsk = meritumNotificationRows({ ordered: [{ ...asked, actor: 'hive:hbd-temp' }], placed: [{ ...asked, actor: 'hive:hbd-temp' }] }, ['hive:hbd-temp']);
ok('a creator asking their own market rings nobody', selfAsk.length === 0);
const renamed = meritumNotificationRows(
  { ordered: [asked], offerings: [{ offering_id: 1, title: 'old' }], renamed: [{ offering_id: 1, title: 'new' }] },
  ['hive:hbd-temp']
);
ok('a later title change wins', renamed[0]?.msg.includes('"new"'));
const untitled = meritumNotificationRows({ ordered: [{ ...asked, offering_id: 9 }] }, ['hive:hbd-temp']);
ok('an unknown offering reads as "service"', untitled[0]?.msg === '@lordbutterfly ordered your service for 1 token', untitled[0]?.msg);
const plural = meritumNotificationRows({ ordered: [{ ...asked, credits_spent: '3' }] }, ['hive:hbd-temp']);
ok('tokens pluralise', plural[0]?.msg.endsWith('for 3 tokens'));
const did = 'did:pkh:eip155:1:0xB41fEE4a2E1C0B7b2C9d3c4e5f6a7b8c9d0e980B';
const wallet = meritumNotificationRows({ ordered: [{ ...asked, actor: did }] }, ['hive:hbd-temp']);
ok('a wallet asker is shortened, not pasted whole', wallet[0]?.msg.startsWith('0xB41f…980B ordered'), wallet[0]?.msg);
ok('a wallet asker has no face (the panel draws the mark)', wallet[0]?.actor === undefined);
const walletSeller = meritumNotificationRows({ bought: sellerData.bought }, [did]);
ok('a wallet creator\'s buy row links to m/<did>', walletSeller[0]?.url === `m/${did}`);
ok('mention: hive -> @name, short did left alone', mention('hive:gtg') === '@gtg' && mention('did:pkh:x:y:abc') === 'abc');
ok('zoned: already-zoned stays', zoned('2026-09-21T17:00:00Z') === '2026-09-21T17:00:00Z' && zoned('2026-09-21T17:00:00+00:00') === '2026-09-21T17:00:00+00:00');
ok('a rating without a score is skipped', meritumNotificationRows({ rated: [{ creator: 'hive:a', actor: 'hive:b', seq: 1, score: 'x', indexer_ts: '2026-09-21T17:00:00' }] }, ['hive:a']).length === 0);

console.log('\ndeliveredWhere: the second round trip');
const where = deliveredWhere([asked, { ...asked, creator: 'hive:gtg', seq: '7' }], CONTRACT) as { _and: unknown[] } | null;
ok('null when the reader never asked', deliveredWhere([], CONTRACT) === null);
ok(
  'pairs of (creator, seq) under the contract filter',
  JSON.stringify(where) ===
    JSON.stringify({
      _and: [{ indexer_contract_id: { _eq: CONTRACT } }, { _or: [{ creator: { _eq: 'hive:hbd-temp' }, seq: { _eq: 0 } }, { creator: { _eq: 'hive:gtg' }, seq: { _eq: 7 } }] }]
    }),
  JSON.stringify(where)
);
ok('queries name every field the builder reads', ['bought', 'ordered', 'placed', 'declined', 'rated', 'missed', 'offerings', 'renamed'].every((f) => MERITUM_NOTIFICATIONS_QUERY.includes(`${f}:`)) && DELIVERED_FOR_ASKS_QUERY.includes('delivered:'));
ok('every list is filtered to the deployed contract', (MERITUM_NOTIFICATIONS_QUERY.match(/indexer_contract_id: \{ _eq: \$contract \}/g) ?? []).length === 8);

console.log('\nunread: the lag scenario the timestamp cutoff lost');
const T = Date.parse('2026-09-21T17:02:00Z');
const row = (id: string, date: string): Pick<LumenNotificationRow, 'id' | 'date'> => ({ id, date });
const A = row('follow:h:alice:2026-09-21T16:57:00Z', '2026-09-21T16:57:00Z');
// The buy happened at 17:00 (block time) but reached the list only after the
// reader opened the bell at 17:02.
const B = row('buy:hive:me:abc', '2026-09-21T17:00:42Z');
const opened = marksAfterOpen([A], { ids: [], seenAt: 0 }, T);
ok('opening over [A] remembers A and the time', opened.ids.length === 1 && opened.ids[0] === A.id && opened.seenAt === T);
const oldRule = Date.parse(B.date) > opened.seenAt;
ok('the old rule (date > seenAt) counted the late buy as READ', oldRule === false);
ok('the id rule counts it as UNREAD', isUnread(B, opened) === true && unreadCount([A, B], opened) === 1);
const reopened = marksAfterOpen([A, B], opened, T + 60_000);
ok('after the next open it is read', unreadCount([A, B], reopened) === 0);
ok('a row with no id falls back to the timestamp rule', isUnread({ id: '', date: '2026-09-21T17:03:00Z' }, opened) === true && isUnread({ id: '', date: '2026-09-21T17:01:00Z' }, opened) === false);
ok('an unparseable date without an id is never unread', isUnread({ id: '', date: 'nope' }, opened) === false);
ok('reopening never duplicates ids', marksAfterOpen([A, A, B], reopened, T).ids.filter((id) => id === A.id).length === 1);
ok('the cutoff never moves backwards', marksAfterOpen([], reopened, T - 1).seenAt === reopened.seenAt);

console.log('\nunread: the set is bounded');
const many = Array.from({ length: SEEN_IDS_CAP + 50 }, (_, i) => row(`x:${i}`, '2026-09-21T17:00:00Z'));
const capped = marksAfterOpen(many, { ids: ['old:1'], seenAt: 0 }, T);
ok(`capped at ${SEEN_IDS_CAP}`, capped.ids.length === SEEN_IDS_CAP);
ok('the oldest ids are the ones evicted', !capped.ids.includes('old:1') && !capped.ids.includes('x:0') && capped.ids.includes(`x:${SEEN_IDS_CAP + 49}`));
ok('ids already known move to the newest end', marksAfterOpen([row('k:1', '')], { ids: ['k:1', 'k:2'], seenAt: 0 }, T).ids.join() === 'k:2,k:1');

console.log('\nunread: one-time seed from the old timestamp mark');
const seeded = marksFromLegacy([A, B, row('dm:h:bob:2026-09-21T17:05:00Z', '2026-09-21T17:05:00Z')], T);
ok('rows the old rule had already shown are seeded as seen', seeded.ids.includes(A.id) && seeded.ids.includes(B.id));
ok('rows newer than the old mark stay unread', !seeded.ids.includes('dm:h:bob:2026-09-21T17:05:00Z') && seeded.seenAt === T);
ok('a device that never opened the bell seeds nothing', marksFromLegacy([A, B], 0).ids.length === 0);

if (failures === 0) {
  console.log(`\nmeritum-notification-rows: ALL ${checks} CHECKS PASSED`);
  process.exit(0);
} else {
  console.error(`\nmeritum-notification-rows: ${failures}/${checks} CHECK(S) FAILED`);
  process.exit(1);
}

// v6 (2026-09-22): the indexer now carries decimal token strings ("1.50", "0.99") next to the
// whole-token rows of the v5.1 era; both must read as numbers, never truncate to an integer.
const v6 = meritumNotificationRows(
  {
    bought: [{ creator: 'hive:hbd-temp', actor: 'hive:lordbutterfly', minted: '1.50', total_due: '1638', indexer_ts: '2026-09-22T09:00:00', indexer_tx_hash: 'v6buy' }],
    ordered: [{ ...asked, credits_spent: '0.99' }]
  },
  ['hive:hbd-temp']
);
ok('v6 decimal buy row keeps the fraction', byType(v6, 'buy')[0]?.msg === '@lordbutterfly bought 1.5 Meritum of yours for $1.64', byType(v6, 'buy')[0]?.msg ?? '');
ok('v6 decimal order row keeps the fraction and pluralises', byType(v6, 'order')[0]?.msg === '@lordbutterfly ordered your "Let there be light!" for 0.99 tokens', byType(v6, 'order')[0]?.msg ?? '');
