/**
 * Self-test for the Altera port: op shapes vs the node's structs and the SDK.
 *   npx tsx apps/blog/features/wallet/lib/magi-ops.selftest.ts
 * (run with the resolve hook for the ESM-only SDK; see WALLET-MAGI-BALANCES-BUILD-MAP §M)
 */
import assert from 'node:assert/strict';
import { CoinAmount, getHiveSwapOp } from '@vsc.eco/crosschain-core';
import { decodeDagCbor } from '@/blog/lib/lite/wallet/vsc-tx/dag-cbor';
import { buildTransferOp, buildWithdrawOp, RC_COST_TRANSFER, RC_COST_WITHDRAW } from '@/blog/lib/lite/wallet/vsc-tx/container';
import {
  btcToSats,
  formatMagiAmount,
  magiBtcTransferCustomJson,
  magiBtcUnmapCustomJson,
  magiTransferCustomJson,
  magiWithdrawCustomJson,
  parseMagiRecipient,
  requiredAuthFor
} from './magi-ops';
import { buildMagiSwapCustomJson, customJsonFromSdkOp, toSdkConfig } from './magi-swap';

let n = 0;
const ok = (cond: boolean, msg: string) => {
  n += 1;
  assert.ok(cond, `${n}. ${msg}`);
  console.log(`ok ${n} - ${msg}`);
};

const EVM = 'did:pkh:eip155:1:0xB41fEE7B3a034a474ae8E0C41DA8B211b73A980B';
const BTC = 'did:pkh:bip122:000000000019d6689c085ae165831e93:bc1qewdludr3fpy3k903hqave02ue4xm9ha83c9c0m';

// Recipient parsing = Altera getDidFromUsername (getAccountName.ts:48-62)
ok(parseMagiRecipient('vaultec')?.id === 'hive:vaultec', 'bare Hive name -> hive:');
ok(parseMagiRecipient('@Vaultec')?.hiveName === 'vaultec', '@Name lower-cased, bare name kept for the exists check');
ok(parseMagiRecipient('hive:vaultec')?.kind === 'hive', 'hive: passthrough');
ok(parseMagiRecipient('0xB41fEE7B3a034a474ae8E0C41DA8B211b73A980B')?.id === EVM.toLowerCase().replace('did:pkh:eip155:1:', 'did:pkh:eip155:1:'), '0x address -> eip155 DID, lower-cased like Altera');
ok(parseMagiRecipient(EVM)?.kind === 'evm', 'eip155 DID passthrough');
ok(parseMagiRecipient('bc1qewdludr3fpy3k903hqave02ue4xm9ha83c9c0m')?.id === BTC, 'bc1q address -> bip122 mainnet DID');
ok(parseMagiRecipient(BTC)?.kind === 'btc', 'bip122 DID passthrough');
ok(parseMagiRecipient('bc1p' + 'a'.repeat(58)) === null, 'taproot refused (node refuses at DID parse)');
ok(parseMagiRecipient('not a name at all!') === null, 'garbage -> null, never a guessed id');
ok(parseMagiRecipient('') === null, 'empty -> null');
ok(requiredAuthFor('hive:alice') === 'alice' && requiredAuthFor(EVM) === EVM, 'required auth: bare name on L1, DID on L2');

// Amounts
ok(formatMagiAmount('1.2') === '1.200' && formatMagiAmount(0.5) === '0.500', 'three-decimal amounts');
ok(btcToSats('0.00001') === '1000' && btcToSats('1') === '100000000', 'BTC -> sats integer string');
assert.throws(() => btcToSats('0.000000001'), 'sub-satoshi refused');
ok(true, 'sub-satoshi refused');

// L1 custom_json = Altera transfer.ts / withdrawal.ts
const tr = magiTransferCustomJson({ from: 'hive:alice', to: EVM, amount: '1.000', asset: 'hbd', netId: 'vsc-testnet' });
ok(tr.id === 'vsc.transfer' && tr.required_auths[0] === 'alice' && tr.required_posting_auths.length === 0, 'vsc.transfer with the bare active auth');
ok(JSON.parse(tr.json).from === 'hive:alice' && JSON.parse(tr.json).net_id === 'vsc-testnet' && !('memo' in JSON.parse(tr.json)), 'json carries hive: from, net_id, no empty memo');
const trm = magiTransferCustomJson({ from: 'hive:alice', to: 'hive:bob', amount: '1.000', asset: 'hive', memo: 'hi', netId: 'vsc-testnet' });
ok(JSON.parse(trm.json).memo === 'hi', 'memo carried when set');
const wd = magiWithdrawCustomJson({ from: EVM, to: 'hive:alice', amount: '2.500', asset: 'hive', netId: 'vsc-mainnet' });
ok(wd.id === 'vsc.withdraw' && wd.required_auths[0] === EVM, 'vsc.withdraw; a DID is its own auth');
assert.throws(() => magiWithdrawCustomJson({ from: 'hive:alice', to: EVM, amount: '1.000', asset: 'hbd', netId: 'x' }), 'withdraw to a DID refused');
ok(true, 'withdraw to a DID refused (L1 pays Hive accounts only)');

// BTC mapping-contract ops = Altera bitcoin.ts
const bt = magiBtcTransferCustomJson({ caller: 'hive:alice', to: BTC, sats: '1000', contractId: 'vsc1Bk', netId: 'vsc-testnet' });
const btj = JSON.parse(bt.json);
ok(bt.id === 'vsc.call' && btj.action === 'transfer' && btj.rc_limit === 1000 && btj.caller === 'hive:alice' && btj.payload.amount === '1000' && btj.payload.to === BTC, 'BTC transfer call: action/rc_limit/payload as Altera bitcoin.ts:31-41');
const un = magiBtcUnmapCustomJson({ caller: EVM, to: 'bc1qewdludr3fpy3k903hqave02ue4xm9ha83c9c0m', sats: '5000', contractId: 'vsc1Bk', netId: 'vsc-testnet' });
ok(JSON.parse(un.json).action === 'unmap' && JSON.parse(un.json).rc_limit === 10000 && un.required_auths[0] === EVM, 'unmap call: rc_limit 10000, DID auth');
assert.throws(() => magiBtcUnmapCustomJson({ caller: EVM, to: EVM, sats: '5000', contractId: 'c', netId: 'n' }), 'unmap needs a Bitcoin address');
ok(true, 'unmap to a non-Bitcoin address refused');
assert.throws(() => magiBtcTransferCustomJson({ caller: EVM, to: BTC, sats: '0', contractId: 'c', netId: 'n' }));
ok(true, 'zero sats refused');

// L2 container ops = node TxVSCTransfer / TxVSCWithdraw (transactions.go:292-301), Altera eth/index.ts:69-92
const op = buildTransferOp({ from: EVM, to: 'hive:alice', amount: '0.100', asset: 'hbd' });
const body = decodeDagCbor(op.payload) as Record<string, unknown>;
ok(op.type === 'transfer' && Object.keys(body).sort().join() === 'amount,asset,from,to', 'transfer op body: from,to,amount,asset (net_id in headers)');
const opm = buildTransferOp({ from: EVM, to: 'hive:alice', amount: '0.100', asset: 'hbd', memo: 'x' });
ok((decodeDagCbor(opm.payload) as Record<string, unknown>).memo === 'x', 'memo present when set');
assert.throws(() => buildTransferOp({ from: EVM, to: EVM, amount: '0.100', asset: 'hbd' }), 'self transfer refused');
ok(true, 'self transfer refused (ledger_session.go:412)');
assert.throws(() => buildTransferOp({ from: EVM, to: 'alice', amount: '0.100', asset: 'hbd' }));
ok(true, 'unprefixed party refused (transactions.go:321)');
assert.throws(() => buildTransferOp({ from: EVM, to: 'hive:alice', amount: '0.1', asset: 'hbd' }));
ok(true, 'amount must carry three decimals');
assert.throws(() => buildTransferOp({ from: EVM, to: 'hive:alice', amount: '0.100', asset: 'btc' }));
ok(true, 'btc is not a ledger transfer asset (utils.go:8)');
assert.throws(() => buildTransferOp({ from: EVM, to: 'hive:alice', amount: '0.100', asset: 'hbd', net_id: 'x' } as never));
ok(true, 'body-level net_id refused');
const wop = buildWithdrawOp({ from: BTC, to: 'hive:alice', amount: '1.000', asset: 'hive' });
ok(wop.type === 'withdraw', 'withdraw op type');
assert.throws(() => buildWithdrawOp({ from: BTC, to: EVM, amount: '1.000', asset: 'hive' }));
ok(true, 'withdraw to a DID refused');
assert.throws(() => buildWithdrawOp({ from: BTC, to: 'hive:alice', amount: '1.000', asset: 'hbd_savings' }));
ok(true, 'hbd_savings not withdrawable');
ok(RC_COST_TRANSFER === 100 && RC_COST_WITHDRAW === 200, 'RC costs mirror transaction-pool/utils.go:67-68');

// Swap: the DID-capable builder is byte-identical to the SDK for a Hive caller
const config = toSdkConfig({
  network: 'vsc-testnet',
  dexRouterContractId: 'vsc1Bens5nrhnbbHEUftCWaLPYegDx9LGLXEUP',
  btcMappingContractId: 'vsc1BkWohDf5fPcwn7V9B9ar6TyiWc3A2ZGJ4t',
  gatewayAccount: 'vsc.gateway',
  hiveAssetName: 'TESTS',
  hbdAssetName: 'TBD'
});
const amountIn = CoinAmount.fromDecimal('5.000', 'HBD');
const quote = {
  assetIn: 'HBD',
  assetOut: 'HIVE',
  amountIn,
  preview: { expectedOutput: BigInt(71397), minAmountOut: BigInt(68028), totalFee: BigInt(0), hops: 1 }
} as never;
const sdk = customJsonFromSdkOp(getHiveSwapOp({ username: 'magi.contracts', amountIn, assetIn: 'HBD', assetOut: 'HIVE', minAmountOut: BigInt(68028), config }));
const mine = buildMagiSwapCustomJson('hive:magi.contracts', quote, config);
// The chain sees id, json and the two auth arrays (pushed as fields); the wrapper's key order is not serialized.
ok(sdk.json === mine.json, 'Hive caller: signed json == SDK getHiveSwapOp json (byte-identical)');
ok(sdk.id === mine.id && JSON.stringify(sdk.required_auths) === JSON.stringify(mine.required_auths) && JSON.stringify(sdk.required_posting_auths) === JSON.stringify(mine.required_posting_auths), 'Hive caller: id and auths == SDK');
const didSwap = buildMagiSwapCustomJson(EVM, quote, config, 1500);
const dj = JSON.parse(didSwap.json);
ok(didSwap.required_auths[0] === EVM && dj.caller === EVM && JSON.parse(dj.payload).recipient === EVM && dj.rc_limit === 1500, 'DID caller: caller, recipient and auth are the DID');
ok(dj.intents[0].type === 'transfer.allow' && dj.intents[0].args.token === 'hbd' && dj.intents[0].args.limit === '5.000', 'native input carries the transfer.allow intent');

console.log(`\n${n} checks passed`);
