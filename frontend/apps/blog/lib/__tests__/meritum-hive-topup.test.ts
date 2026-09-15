/** UNIT TESTS for `lib/meritum/hive-topup.ts`. Run by `pnpm --filter @hive/blog test:unit` under ts-node; own harness. */
import {
  GATEWAY_ACCOUNT,
  GATEWAY_MEMO_NAME,
  HIVE_FREE_RC,
  assertFundedBundle,
  bareHiveName,
  depositIntentOf,
  gatewayDepositMemo,
  hbdString,
  planHiveTopUp,
  rcLimitOf,
  spendCapOf,
  type TopUpInputs
} from '../meritum/hive-topup';

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
function throws(fn: () => unknown, re: RegExp): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
}

console.log('\nbareHiveName / gatewayDepositMemo (binding 3: the memo can only name the signer)');
ok('alice and hive:alice -> alice', bareHiveName('alice') === 'alice' && bareHiveName('hive:alice') === 'alice');
ok('a DID is not a Hive name', bareHiveName('did:pkh:eip155:1:0xabc') === null);
ok('two-letter, upper-case, spaces, empty, null -> null', bareHiveName('al') === null && bareHiveName('Alice') === null && bareHiveName('a lice') === null && bareHiveName('') === null && bareHiveName(null) === null);
ok('a query-string injection cannot pass as a name', bareHiveName('alice&to=mallory') === null && bareHiveName('alice=x') === null && bareHiveName('to=mallory') === null);
ok('the node rule: 3..16 chars, lower-case, digits, dot, dash', GATEWAY_MEMO_NAME.test('a.b-c9') && GATEWAY_MEMO_NAME.test('a'.repeat(16)) && !GATEWAY_MEMO_NAME.test('a'.repeat(17)));
ok('memo is exactly to=<name>', gatewayDepositMemo('alice') === 'to=alice' && gatewayDepositMemo('hive:bob') === 'to=bob');
ok('memo for a non-name throws', throws(() => gatewayDepositMemo('alice&to=mallory'), /not a Hive account name/) && throws(() => gatewayDepositMemo('did:pkh:x'), /not a Hive account name/));

console.log('\nhbdString');
ok('654 -> 0.654, 1000 -> 1.000, 123456 -> 123.456, 0 -> 0.000', hbdString(654) === '0.654' && hbdString(1000) === '1.000' && hbdString(123456) === '123.456' && hbdString(0) === '0.000');
ok('a fraction or a negative is refused', throws(() => hbdString(1.5), /non-negative integer/) && throws(() => hbdString(-1), /non-negative integer/) && throws(() => hbdString(Number.NaN), /non-negative integer/));

console.log('\nplanHiveTopUp (the numbers, per go-vsc-node execution-context.go PullBalance + rc-system.go FreeRcRemaining)');
// lumencontracts on 2026-09-15: 2.545 HBD on Magi, RC 12409 of 12545 (frozen 136), a 3-token hbd-temp buy due 3.199.
const live: TopUpInputs = { signer: 'lumencontracts', totalDueBaseUnits: 3199, magiHbdBaseUnits: 2545, magiRcAvailable: 12409, magiRcMax: 12545, rcLimitBaseUnits: 4265, hiveLiquidHbdBaseUnits: 5000 };
const p1 = planHiveTopUp(live);
ok('shortfall only: free RC covers the reserve, so deposit = due - balance', p1.kind === 'top-up' && p1.depositBaseUnits === 654 && p1.from === 'lumencontracts' && p1.memo === 'to=lumencontracts', JSON.stringify(p1));
ok('Magi covers -> no deposit', planHiveTopUp({ ...live, totalDueBaseUnits: 2000 }).kind === 'magi-covers');
ok('exactly covered -> no deposit', planHiveTopUp({ ...live, totalDueBaseUnits: 2545 }).kind === 'magi-covers');
// frozen 9000 of the 10000 free: only 1000 free left, so 3265 of the 4265 reserve must come out of the balance.
const p2 = planHiveTopUp({ ...live, magiRcAvailable: 3545, magiRcMax: 12545 });
ok('a mostly-frozen allowance moves the reserve into the deposit: 3199 + 3265 - 2545', p2.kind === 'top-up' && p2.depositBaseUnits === 3919, JSON.stringify(p2));
// balance 200, RC 50 of 10200 (frozen 10150 -> no free left): the credits, not the price, set the deposit.
const p3 = planHiveTopUp({ ...live, totalDueBaseUnits: 100, magiHbdBaseUnits: 200, magiRcAvailable: 50, magiRcMax: 10200 });
ok('when credits are the binding constraint: max(100 + 4265 - 200, 4265 - 50) = 4215', p3.kind === 'top-up' && p3.depositBaseUnits === 4215, JSON.stringify(p3));
ok('the deposit never exceeds due + reserve (binding 4)', (() => { for (const due of [1, 100, 3199, 50000]) for (const bal of [0, 1, 2545]) for (const [avail, max] of [[0, 10000], [50, 10200], [12409, 12545], [0, 0]]) { const p = planHiveTopUp({ ...live, totalDueBaseUnits: due, magiHbdBaseUnits: bal, magiRcAvailable: avail, magiRcMax: max }); if (p.kind === 'top-up' && p.depositBaseUnits > due + 4265) return false; } return true; })());
ok('a fresh account (0 balance, RC = free allowance) deposits exactly the price', (() => { const p = planHiveTopUp({ ...live, magiHbdBaseUnits: 0, magiRcAvailable: HIVE_FREE_RC, magiRcMax: HIVE_FREE_RC }); return p.kind === 'top-up' && p.depositBaseUnits === 3199; })());
ok('short on Hive -> short-on-hive with the missing amount', (() => { const p = planHiveTopUp({ ...live, hiveLiquidHbdBaseUnits: 100 }); return p.kind === 'short-on-hive' && p.depositBaseUnits === 654 && p.missingBaseUnits === 554; })());
ok('Hive balance unread -> hive-unknown, still with the memo and amount', (() => { const p = planHiveTopUp({ ...live, hiveLiquidHbdBaseUnits: null }); return p.kind === 'hive-unknown' && p.depositBaseUnits === 654 && p.memo === 'to=lumencontracts'; })());
ok('a DID signer -> not-a-hive-account (never a deposit)', planHiveTopUp({ ...live, signer: 'did:pkh:eip155:1:0xabc' }).kind === 'not-a-hive-account');
ok('hive: prefix accepted, name bound to the memo', (() => { const p = planHiveTopUp({ ...live, signer: 'hive:alice' }); return p.kind === 'top-up' && p.from === 'alice' && p.memo === 'to=alice'; })());
ok('a fractional or negative input is refused, never rounded', throws(() => planHiveTopUp({ ...live, totalDueBaseUnits: 3199.5 }), /non-negative integer/) && throws(() => planHiveTopUp({ ...live, magiHbdBaseUnits: -1 }), /non-negative integer/) && throws(() => planHiveTopUp({ ...live, hiveLiquidHbdBaseUnits: Number.NaN }), /non-negative integer/));
ok('depositIntentOf: only top-up and hive-unknown yield an intent, with no `to` field', (() => { const a = depositIntentOf(p1); const b = depositIntentOf({ kind: 'magi-covers' }); const c = depositIntentOf(planHiveTopUp({ ...live, hiveLiquidHbdBaseUnits: 100 })); return a !== null && a.from === 'lumencontracts' && a.memo === 'to=lumencontracts' && a.amountBaseUnits === 654 && !('to' in a) && b === null && c === null; })());

console.log('\nspendCapOf / rcLimitOf (read from the op the buyer signs, never from a caller)');
const opJson = (extra: Record<string, unknown> = {}) => JSON.stringify({ net_id: 'vsc-mainnet', contract_id: 'vsc1x', action: 'buy', payload: { creator: 'hive:hbd-temp', tokens: '3' }, rc_limit: 4265, intents: [{ type: 'transfer.allow', args: { limit: '3.199', token: 'hbd', decimals: '3' } }], ...extra });
const buyOp = { required_auths: ['lumencontracts'], required_posting_auths: [] as string[], json: opJson() };
ok('cap = the transfer.allow limit in base units', spendCapOf(buyOp) === 3199);
ok('rc_limit read back', rcLimitOf(buyOp) === 4265);
ok('no intents -> null; a hive-token intent -> null; garbage json -> null', spendCapOf({ ...buyOp, json: opJson({ intents: [] }) }) === null && spendCapOf({ ...buyOp, json: opJson({ intents: [{ type: 'transfer.allow', args: { limit: '1.000', token: 'hive', decimals: '3' } }] }) }) === null && spendCapOf({ ...buyOp, json: '{nope' }) === null && rcLimitOf({ ...buyOp, json: '[]' }) === null);
ok('a limit with a bad shape is not a cap', spendCapOf({ ...buyOp, json: opJson({ intents: [{ type: 'transfer.allow', args: { limit: '1e3', token: 'hbd' } }] }) }) === null && spendCapOf({ ...buyOp, json: opJson({ intents: [{ type: 'transfer.allow', args: { limit: '1.0000', token: 'hbd' } }] }) }) === null);

console.log('\nassertFundedBundle (the four bindings, each refused independently)');
const good = { from: 'lumencontracts', memo: 'to=lumencontracts', amountBaseUnits: 654 };
ok('the honest pair passes', !throws(() => assertFundedBundle(good, buyOp, 'vsc.gateway', 4265), /./));
ok('1. deposit from another account than the signer -> refused', throws(() => assertFundedBundle({ ...good, from: 'mallory' }, buyOp, 'vsc.gateway', 4265), /signed by "lumencontracts"/));
ok('1b. buy signed by a DID -> refused (no Hive wallet to draw from)', throws(() => assertFundedBundle(good, { ...buyOp, required_auths: ['did:pkh:eip155:1:0xabc'] }, 'vsc.gateway', 4265), /not signed by a Hive account/));
ok('1c. two signers or none -> refused', throws(() => assertFundedBundle(good, { ...buyOp, required_auths: ['lumencontracts', 'bob'] }, 'vsc.gateway', 4265), /exactly one active authority/) && throws(() => assertFundedBundle(good, { ...buyOp, required_auths: [] }, 'vsc.gateway', 4265), /exactly one active authority/));
ok('1d. posting authority present -> refused', throws(() => assertFundedBundle(good, { ...buyOp, required_posting_auths: ['lumencontracts'] }, 'vsc.gateway', 4265), /posting authority/));
ok('2. a gateway that is not a Hive name (a DID, an injection) -> refused', throws(() => assertFundedBundle(good, buyOp, 'did:pkh:eip155:1:0xabc', 4265), /gateway account/) && throws(() => assertFundedBundle(good, buyOp, 'vsc.gateway&x=1', 4265), /gateway account/) && throws(() => assertFundedBundle(good, buyOp, '', 4265), /gateway account/));
ok('2c. a well-formed gateway name that is not vsc.gateway -> refused (the node credits that literal only)', GATEWAY_ACCOUNT === 'vsc.gateway' && throws(() => assertFundedBundle(good, buyOp, 'vsc.gateway2', 4265), /is not vsc\.gateway/) && throws(() => assertFundedBundle(good, buyOp, 'vsc.mocknet', 4265), /is not vsc\.gateway/));
ok('2b. the signer cannot be the gateway', throws(() => assertFundedBundle({ ...good, from: 'vsc.gateway', memo: 'to=vsc.gateway' }, { ...buyOp, required_auths: ['vsc.gateway'] }, 'vsc.gateway', 4265), /gateway cannot deposit to itself/));
ok('3. a memo crediting someone else -> refused', throws(() => assertFundedBundle({ ...good, memo: 'to=mallory' }, buyOp, 'vsc.gateway', 4265), /does not credit the signer/));
ok('3b. a memo with an extra parameter, a JSON memo, an empty memo -> refused', throws(() => assertFundedBundle({ ...good, memo: 'to=lumencontracts&to=mallory' }, buyOp, 'vsc.gateway', 4265), /does not credit the signer/) && throws(() => assertFundedBundle({ ...good, memo: '{"to":"mallory"}' }, buyOp, 'vsc.gateway', 4265), /does not credit the signer/) && throws(() => assertFundedBundle({ ...good, memo: '' }, buyOp, 'vsc.gateway', 4265), /does not credit the signer/));
ok('4. an amount above cap + reserve -> refused; exactly cap + reserve passes', throws(() => assertFundedBundle({ ...good, amountBaseUnits: 3199 + 4265 + 1 }, buyOp, 'vsc.gateway', 4265), /exceeds this buy's cap/) && !throws(() => assertFundedBundle({ ...good, amountBaseUnits: 3199 + 4265 }, buyOp, 'vsc.gateway', 4265), /./));
ok('4b. zero, fractional, negative amounts -> refused', throws(() => assertFundedBundle({ ...good, amountBaseUnits: 0 }, buyOp, 'vsc.gateway', 4265), /nothing to deposit/) && throws(() => assertFundedBundle({ ...good, amountBaseUnits: 1.5 }, buyOp, 'vsc.gateway', 4265), /non-negative integer/) && throws(() => assertFundedBundle({ ...good, amountBaseUnits: -5 }, buyOp, 'vsc.gateway', 4265), /non-negative integer/));
ok('4c. a buy op without a spend allowance has no ceiling -> refused', throws(() => assertFundedBundle(good, { ...buyOp, json: opJson({ intents: [] }) }, 'vsc.gateway', 4265), /no HBD spend allowance/));

if (failures === 0) {
  console.log(`\nmeritum-hive-topup: ALL ${checks} CHECKS PASSED`);
  process.exit(0);
} else {
  console.error(`\nmeritum-hive-topup: ${failures}/${checks} CHECK(S) FAILED`);
  process.exit(1);
}
