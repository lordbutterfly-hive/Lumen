/**
 * UNIT TESTS for the pure half of the wallet's activity lists:
 *   - `features/wallet/lib/history-groups.ts` — which operations each Hive tab
 *     asks for, the uint64 filter mask, and the backwards-paging arithmetic;
 *   - `features/wallet/lib/magi-history.ts` — turning a Magi transaction into
 *     rows, including the two amount wire formats.
 *
 * Run by `pnpm --filter @hive/blog test:unit` under ts-node; own harness.
 * ★ Imports the PURE modules only — `../../features/wallet/lib/account-history`
 * imports the chain client, which ts-node cannot resolve, and one such import
 * aborts the whole runner at this file.
 *
 * ★ THE FIXTURES ARE REAL RESPONSES, captured from api.hive.blog and from the
 * mainnet Magi node vsc.techcoderx.com on 2026-09-18, not hand-written shapes.
 */
import {
  ALL_HISTORY_OPERATION_NAMES,
  REWARD_OPERATION_NAMES,
  TRANSFER_OPERATION_NAMES,
  categoryForOperation,
  nextCursorFrom,
  operationFilterMask,
  operationNamesForGroup,
  pageBoundsFromCursor,
  parseHistoryGroup
} from '../../features/wallet/lib/history-groups';
import {
  MAGI_GROUP_OP_TYPES,
  cleanMagiMemo,
  describeMagiTransaction,
  displayMagiAccount,
  formatMagiAmount,
  magiExplorerTxUrl,
  parseMagiHistoryGroup
} from '../../features/wallet/lib/magi-history';
import { normalizeMagiTimestamp, parseMagiTransactions } from '../lite/wallet/magi-transactions';

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

// ───────────────────────────── history groups ─────────────────────────────
console.log('\nhistory groups');

ok(
  'Rewards asks for reward operations only',
  REWARD_OPERATION_NAMES.includes('curation_reward_operation') &&
    !(REWARD_OPERATION_NAMES as readonly string[]).includes('transfer_operation')
);
ok(
  'Send & receive carries HP movements, not just transfers (owner ruling)',
  ['transfer_operation', 'transfer_to_vesting_operation', 'withdraw_vesting_operation', 'delegate_vesting_shares_operation'].every(
    (name) => (TRANSFER_OPERATION_NAMES as readonly string[]).includes(name)
  )
);
ok(
  'a witness block reward is in no tab — it would bury every other reward',
  !ALL_HISTORY_OPERATION_NAMES.includes('producer_reward_operation')
);
ok(
  'All is the union of the three sets and carries no duplicates',
  ALL_HISTORY_OPERATION_NAMES.length === new Set(ALL_HISTORY_OPERATION_NAMES).size &&
    ALL_HISTORY_OPERATION_NAMES.includes('fill_order_operation') &&
    REWARD_OPERATION_NAMES.every((n) => ALL_HISTORY_OPERATION_NAMES.includes(n)) &&
    TRANSFER_OPERATION_NAMES.every((n) => ALL_HISTORY_OPERATION_NAMES.includes(n))
);
ok('operationNamesForGroup routes each tab', operationNamesForGroup('rewards') === REWARD_OPERATION_NAMES && operationNamesForGroup('transfers') === TRANSFER_OPERATION_NAMES);
ok('an unknown group is rejected, never silently treated as All', parseHistoryGroup('nonsense') === null && parseHistoryGroup('rewards') === 'rewards' && parseHistoryGroup(['all']) === 'all');

// ───────────────────────────── the uint64 mask ─────────────────────────────
console.log('\noperation filter mask');

const mask = operationFilterMask([2, 3, 4, 32, 33, 34, 39, 40, 49, 51, 52, 55, 56, 57, 59, 62, 63, 83]);
const expectedLow = [2, 3, 4, 32, 33, 34, 39, 40, 49, 51, 52, 55, 56, 57, 59, 62, 63].reduce((acc, id) => acc | (BigInt(1) << BigInt(id)), BigInt(0));
ok('low word sets exactly the bits it was given', mask.low === expectedLow.toString(), mask.low);
ok('ids 64+ land in the high word (83 -> bit 19)', mask.high === (BigInt(1) << BigInt(19)).toString(), mask.high);
ok(
  '★ the real mask is past Number.MAX_SAFE_INTEGER — this is why it is a string',
  Number(mask.low) > Number.MAX_SAFE_INTEGER && String(Number(mask.low)) !== mask.low,
  `${mask.low} vs ${String(Number(mask.low))}`
);
ok('a lossy Number round-trip would change which operations come back', BigInt(Number(mask.low)) !== expectedLow);
ok('ids outside 0-127 are dropped, never wrapped into the wrong bit', operationFilterMask([128, -1, 1.5]).low === '0' && operationFilterMask([128, -1, 1.5]).high === '0');
ok('an empty set is an empty mask', operationFilterMask([]).low === '0');

// ───────────────────────────── paging arithmetic ─────────────────────────────
console.log('\npaging');

ok('no cursor asks the node for the newest page', pageBoundsFromCursor(null, 25).start === -1 && pageBoundsFromCursor(null, 25).limit === 25);
ok('a deep cursor takes the full page', pageBoundsFromCursor(657_989, 25).start === 657_989 && pageBoundsFromCursor(657_989, 25).limit === 25);
ok(
  '★ near sequence 0 the page SHRINKS (hived asserts start >= limit - 1)',
  pageBoundsFromCursor(3, 25).limit === 4 && pageBoundsFromCursor(0, 25).limit === 1
);
ok('the limit never reaches zero', pageBoundsFromCursor(0, 25).limit >= 1);
ok('a full page hands back the next cursor', nextCursorFrom([100, 101, 102], 3).nextCursor === 99 && nextCursorFrom([100, 101, 102], 3).hasMore === true);
ok('a short page is the end of the history', nextCursorFrom([100, 101], 25).hasMore === false && nextCursorFrom([100, 101], 25).nextCursor === null);
ok('sequence 0 is the end even on a full page', nextCursorFrom([0, 1, 2], 3).hasMore === false);
ok('an empty page is the end', nextCursorFrom([], 25).hasMore === false);
ok('order in the page does not matter', nextCursorFrom([102, 100, 101], 3).nextCursor === 99);

// ───────────────────────────── categories ─────────────────────────────
console.log('\ncategories');

ok('a transfer is in or out by direction', categoryForOperation('transfer_operation', true) === 'in' && categoryForOperation('transfer_operation', false) === 'out');
ok('HP operations are their own category', categoryForOperation('delegate_vesting_shares_operation') === 'power' && categoryForOperation('fill_vesting_withdraw_operation') === 'power');
ok('savings is not "in"', categoryForOperation('transfer_to_savings_operation') === 'savings');
ok('a savings WITHDRAWAL arriving is money in', categoryForOperation('fill_transfer_from_savings_operation') === 'in');
ok('rewards are rewards', categoryForOperation('curation_reward_operation') === 'reward' && categoryForOperation('interest_operation') === 'reward');
ok('an unknown operation is "other", never mislabelled', categoryForOperation('some_future_operation') === 'other');

// ───────────────────────────── Magi amounts ─────────────────────────────
console.log('\nMagi amounts');

ok('★ a deposit arrives as base units (175 = 0.175 HBD)', formatMagiAmount(175, 'hbd') === '0.175 HBD', String(formatMagiAmount(175, 'hbd')));
ok('★ a transfer arrives as a decimal string ("11.000")', formatMagiAmount('11.000', 'hbd') === '11.000 HBD');
ok('an integer STRING is still base units', formatMagiAmount('1000', 'hive') === '1.000 HIVE');
ok('thousands are grouped like every other wallet figure', formatMagiAmount(1234567, 'hbd') === '1,234.567 HBD', String(formatMagiAmount(1234567, 'hbd')));
ok('BTC keeps 8 decimals', formatMagiAmount(100000000, 'btc') === '1.00000000 BTC', String(formatMagiAmount(100000000, 'btc')));
ok('hbd_savings is priced as HBD', formatMagiAmount(2000, 'hbd_savings') === '2.000 HBD');
ok('an unknown asset yields nothing rather than a wrong number', formatMagiAmount(1000, 'doge') === null);
ok('unreadable input yields nothing, never 0', formatMagiAmount(undefined, 'hbd') === null && formatMagiAmount('abc', 'hbd') === null && formatMagiAmount(Number.NaN, 'hbd') === null);
ok('negative ledger legs print their magnitude (the sign is the row tone)', formatMagiAmount(-2142, 'hbd') === '2.142 HBD');

ok('a hive account shows as a handle', displayMagiAccount('hive:lumencontracts') === '@lumencontracts');
ok('a long address is shortened in the middle', displayMagiAccount('did:pkh:eip155:1:0x1234567890abcdef1234').startsWith('0x123456') && displayMagiAccount('did:pkh:eip155:1:0x1234567890abcdef1234').includes('…'));
ok('a contract id is shortened too', displayMagiAccount('contract:vsc1BisggC1NtviuYN1mSR372HGSU6hUfdZARt').includes('…'));

ok("altera's correlation id never reaches a Lumen reader", cleanMagiMemo('altera_id=abc123') === null && cleanMagiMemo('altera_id=abc&note=hello') === 'note=hello');
ok('an ordinary memo is untouched', cleanMagiMemo('thanks for the coffee') === 'thanks for the coffee' && cleanMagiMemo('') === null);

ok('mainnet rows link to the mainnet explorer', magiExplorerTxUrl('abc', 'mainnet/xyz') === 'https://vsc.techcoderx.com/tx/abc');
ok('a testnet build links to the testnet explorer', magiExplorerTxUrl('abc', 'testnet/0bf2e474') === 'https://magi-test.techcoderx.com/tx/abc');
ok('no transaction id, no link', magiExplorerTxUrl('', 'mainnet') === null);

// ───────────────────────────── Magi rows ─────────────────────────────
console.log('\nMagi rows');

ok(
  'anchr_ts has no zone marker and is normalised to UTC',
  normalizeMagiTimestamp('2026-09-16T18:12:18', '2026-09-16T18:12:21Z') === '2026-09-16T18:12:18Z'
);
ok('first_seen is used when the transaction is not anchored yet', normalizeMagiTimestamp(null, '2026-09-16T18:12:21Z') === '2026-09-16T18:12:21Z');

/** Captured verbatim from vsc.techcoderx.com, 2026-09-18. */
const LIVE_RESPONSE = {
  data: {
    findTransaction: [
      {
        id: '5225739353',
        anchr_height: 109964720,
        anchr_ts: '2026-09-16T12:50:33',
        first_seen: '2026-09-16T12:50:39Z',
        status: 'CONFIRMED',
        type: 'hive',
        ledger: [{ amount: 11000, asset: 'hbd', from: 'hive:lordbutterfly', memo: '', to: 'hive:lumencontracts', type: 'withdraw' }],
        ops: [{ index: 0, type: 'withdraw', data: { amount: '11.000', asset: 'hbd', from: 'hive:lordbutterfly', memo: '', to: 'hive:lumencontracts' } }]
      },
      {
        id: 'ff43500a98',
        anchr_height: 109950000,
        anchr_ts: '2026-09-15T19:42:09',
        first_seen: '2026-09-15T19:42:12Z',
        status: 'CONFIRMED',
        type: 'hive',
        ledger: [{ amount: 2142, asset: 'hbd', from: 'hive:lordbutterfly', memo: '', to: 'contract:vsc1BisggC1NtviuYN1mSR372HGSU6hUfdZARt', type: 'transfer' }],
        ops: [
          { index: 0, type: 'deposit', data: { amount: 175, asset: 'hbd', from: 'hive:lordbutterfly', memo: '', to: 'hive:lordbutterfly' } },
          { index: 1, type: 'call', data: { action: 'execute', contract_id: 'vsc1BisggC1NtviuYN1mSR372HGSU6hUfdZARt', intents: [], payload: '{}', rc_limit: 10000 } }
        ]
      },
      {
        id: '1f34d468',
        anchr_height: 109900000,
        anchr_ts: '2026-09-14T09:00:00',
        first_seen: '2026-09-14T09:00:03Z',
        status: 'FAILED',
        type: 'vsc',
        ledger: [],
        ops: [{ index: 0, type: 'transfer', data: { amount: '5.000', asset: 'hbd', from: 'hive:lordbutterfly', memo: 'altera_id=x', to: 'hive:someone' } }]
      },
      {
        id: '2858041b',
        anchr_height: 109800000,
        anchr_ts: '2026-09-13T09:00:00',
        first_seen: '2026-09-13T09:00:03Z',
        status: 'CONFIRMED',
        type: 'vsc',
        ledger: [{ amount: 226, asset: 'hbd', from: 'hive:lordbutterfly', to: 'hive:lordbutterfly', type: 'stake', memo: null }],
        ops: [{ index: 0, type: 'stake_hbd', data: { amount: '0.226', asset: 'hbd', from: 'hive:lordbutterfly', to: 'hive:lordbutterfly' } }]
      }
    ]
  }
};

const txs = parseMagiTransactions(LIVE_RESPONSE);
ok('the live envelope parses into four transactions', txs.length === 4);
ok('a GraphQL error is thrown, never returned as an empty history', (() => { try { parseMagiTransactions({ errors: [{ message: 'boom' }] }); return false; } catch { return true; } })());
ok('a null result set is an empty history, not a throw', parseMagiTransactions({ data: { findTransaction: null } }).length === 0);

const account = 'hive:lordbutterfly';
const withdrawRows = describeMagiTransaction(txs[0], account);
ok('a withdrawal is one row, out, with its amount', withdrawRows.length === 1 && withdrawRows[0].category === 'out' && withdrawRows[0].tone === 'debit' && withdrawRows[0].amountText === '11.000 HBD');
ok('the withdrawal names where it went', withdrawRows[0].counterparty?.label === '@lumencontracts' && withdrawRows[0].counterparty?.href === '/@lumencontracts');
ok('the row key is the transaction plus the op index', withdrawRows[0].key === '5225739353-0');

const fundedCall = describeMagiTransaction(txs[1], account);
ok('★ a deposit + the call it funds are TWO rows, not one', fundedCall.length === 2);
ok('the deposit reads as money in, at base-unit scale', fundedCall[0].category === 'in' && fundedCall[0].tone === 'credit' && fundedCall[0].amountText === '0.175 HBD');
ok('★ the call takes its amount from the ledger leg that left this account', fundedCall[1].category === 'market' && fundedCall[1].tone === 'debit' && fundedCall[1].amountText === '2.142 HBD');
ok('the call names its action', fundedCall[1].labelParams?.action === 'execute');

ok(
  '★ the tab filter applies PER OPERATION — a call never shows under Send & receive',
  describeMagiTransaction(txs[1], account, 'transfers').map((row) => row.category).join() === 'in' &&
    describeMagiTransaction(txs[1], account, 'contracts').length === 1
);
ok('the staking tab keeps stake rows only', describeMagiTransaction(txs[3], account, 'staking').length === 1 && describeMagiTransaction(txs[3], account, 'transfers').length === 0);

const failed = describeMagiTransaction(txs[2], account)[0];
ok('★ a FAILED transfer carries no sign — nothing moved', failed.status === 'failed' && failed.tone === 'neutral');
ok('a failed row still says what it was', failed.category === 'out' && failed.amountText === '5.000 HBD');
ok("a failed row's memo is still cleaned", failed.memo === null);

const staked = describeMagiTransaction(txs[3], account)[0];
ok('staking is neither a credit nor a debit', staked.category === 'power' && staked.tone === 'neutral' && staked.amountText === '0.226 HBD');

ok('every row timestamp carries a zone marker', [...withdrawRows, ...fundedCall, failed, staked].every((row) => /Z$/.test(row.timestamp)));

ok('an unknown Magi group is rejected', parseMagiHistoryGroup('nope') === null && parseMagiHistoryGroup('staking') === 'staking');
ok('the All tab sends no type filter', MAGI_GROUP_OP_TYPES.all.length === 0);

/** A transaction whose operation type this wallet has never seen must still render. */
const unknownOp = parseMagiTransactions({
  data: {
    findTransaction: [
      { id: 'future1', anchr_height: 1, anchr_ts: '2026-09-18T00:00:00', first_seen: '2026-09-18T00:00:01Z', status: 'CONFIRMED', type: 'vsc', ledger: [], ops: [{ index: 0, type: 'teleport_hbd', data: { amount: '1.000', asset: 'hbd' } }] }
    ]
  }
});
const futureRow = describeMagiTransaction(unknownOp[0], account)[0];
ok('an unknown operation is shown, not dropped', futureRow.category === 'other' && futureRow.labelParams?.type === 'teleport hbd' && futureRow.amountText === '1.000 HBD');

const malformed = parseMagiTransactions({ data: { findTransaction: [{ id: 'x', status: 'WEIRD', ops: null, ledger: null }] } });
ok('a malformed row degrades instead of throwing', malformed.length === 1 && malformed[0].ops.length === 0 && malformed[0].status === 'UNCONFIRMED');
ok('a transaction with no operations contributes no rows', describeMagiTransaction(malformed[0], account).length === 0);

/** Naming the contracts this app itself deploys against. */
const names = { vsc1BisggC1NtviuYN1mSR372HGSU6hUfdZARt: 'Meritum' };
const namedCall = describeMagiTransaction(txs[1], account, 'all', names)[1];
ok('a known contract is named, not shown as an id', namedCall.labelKey.endsWith('contract_action_known') && namedCall.labelParams?.contract === 'Meritum');
const unnamedCall = describeMagiTransaction(txs[1], account, 'all')[1];
ok('an unknown contract keeps its shortened id', unnamedCall.labelKey.endsWith('contract_action') && (unnamedCall.labelParams?.contract ?? '').includes('…'));

/** A withdrawal to somebody else must not read "Withdrew to Hive to @them". */
const withdrawElsewhere = parseMagiTransactions({
  data: {
    findTransaction: [
      { id: 'w1', anchr_height: 1, anchr_ts: '2026-09-16T12:50:33', first_seen: '2026-09-16T12:50:39Z', status: 'CONFIRMED', type: 'hive', ledger: [], ops: [{ index: 0, type: 'withdraw', data: { amount: '11.000', asset: 'hbd', from: account, to: 'hive:lumencontracts' } }] }
    ]
  }
});
const toSelf = parseMagiTransactions({
  data: {
    findTransaction: [
      { id: 'w2', anchr_height: 1, anchr_ts: '2026-09-16T12:50:33', first_seen: '2026-09-16T12:50:39Z', status: 'CONFIRMED', type: 'hive', ledger: [], ops: [{ index: 0, type: 'withdraw', data: { amount: '11.000', asset: 'hbd', from: account, to: account } }] }
    ]
  }
});
ok('a withdrawal to another account names it, with the label that fits', describeMagiTransaction(withdrawElsewhere[0], account)[0].labelKey.endsWith('withdraw_to') && describeMagiTransaction(withdrawElsewhere[0], account)[0].counterparty?.label === '@lumencontracts');
ok('a withdrawal to your own account has no counterparty', describeMagiTransaction(toSelf[0], account)[0].labelKey.endsWith('.withdraw') && describeMagiTransaction(toSelf[0], account)[0].counterparty === null);

if (failures === 0) {
  console.log(`\nwallet-activity-history: ALL ${checks} CHECKS PASSED`);
  process.exit(0);
} else {
  console.error(`\nwallet-activity-history: ${failures}/${checks} CHECK(S) FAILED`);
  process.exit(1);
}
