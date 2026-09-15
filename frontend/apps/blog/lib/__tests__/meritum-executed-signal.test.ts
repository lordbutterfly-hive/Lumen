/** UNIT TESTS for `lib/meritum/executed-signal.ts`. Run by `pnpm --filter @hive/blog test:unit` under ts-node; own harness. */
import { buyExecutedIn, depositCreditedIn, parseLedgerRows } from '../meritum/executed-signal';

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

// The owner's live funded buy on 2026-09-15 (Hive tx ff43500a…), verbatim from findLedgerTXs.
const TX = 'ff43500a98e9a6c4d804fcc5cd974c44217d07d2';
const live = parseLedgerRows({
  data: {
    findLedgerTXs: [
      { id: `${TX}#in`, amount: -2142, asset: 'hbd', from: '', owner: 'hive:lordbutterfly', type: 'transfer', block_height: 109944360 },
      { id: `${TX}#out`, amount: 2142, asset: 'hbd', from: '', owner: 'contract:vsc1BisggC1NtviuYN1mSR372HGSU6hUfdZARt', type: 'transfer', block_height: 109944360 },
      { id: TX, amount: 175, asset: 'hbd', from: 'hive:lordbutterfly', owner: 'hive:lordbutterfly', type: 'deposit', block_height: 109944359 }
    ]
  }
});

console.log('\nbuyExecutedIn');
ok('the live funded buy: the buyer draw is on the ledger -> executed', buyExecutedIn(live, TX, 'lordbutterfly') && buyExecutedIn(live, TX, 'hive:lordbutterfly'));
ok('another buyer -> not executed (the draw belongs to someone else)', !buyExecutedIn(live, TX, 'mallory'));
ok('another tx id -> not executed', !buyExecutedIn(live, 'deadbeef', 'lordbutterfly'));
ok('a deposit alone (call refused) -> not executed', !buyExecutedIn(parseLedgerRows({ data: { findLedgerTXs: [{ id: TX, amount: 175, asset: 'hbd', owner: 'hive:lordbutterfly', type: 'deposit' }] } }), TX, 'lordbutterfly'));
ok('the contract-side #out row alone is not the buyer draw', !buyExecutedIn([{ id: `${TX}#out`, owner: 'hive:lordbutterfly', amount: 2142, asset: 'hbd', type: 'transfer' }], TX, 'lordbutterfly'));
ok('a positive #in amount (money TO the buyer) is not a buy draw', !buyExecutedIn([{ id: `${TX}#in`, owner: 'hive:lordbutterfly', amount: 5, asset: 'hbd', type: 'transfer' }], TX, 'lordbutterfly'));
ok('a hive-asset draw is not the HBD draw', !buyExecutedIn([{ id: `${TX}#in`, owner: 'hive:lordbutterfly', amount: -5, asset: 'hive', type: 'transfer' }], TX, 'lordbutterfly'));
ok('empty, null, garbage -> not executed', !buyExecutedIn([], TX, 'x') && !buyExecutedIn(null, TX, 'x') && !buyExecutedIn(undefined, TX, 'x') && !buyExecutedIn(live, '', 'lordbutterfly'));

console.log('\ndepositCreditedIn');
ok('the live deposit row is recognised', depositCreditedIn(live, TX, 'lordbutterfly'));
ok('a deposit credited to someone else is not ours', !depositCreditedIn(live, TX, 'mallory'));

console.log('\nparseLedgerRows');
ok('three rows parsed', live !== null && live.length === 3);
ok('string amounts are numbers, bad rows dropped, non-lists null', (() => { const p = parseLedgerRows({ data: { findLedgerTXs: [{ id: 'a', owner: 'b', amount: '-7', asset: 'hbd', type: 'transfer' }, { id: 'c' }, 'junk', { id: 'd', owner: 'e', amount: 'NaN', asset: 'hbd', type: 'transfer' }] } }); return p !== null && p.length === 1 && p[0].amount === -7 && parseLedgerRows({ data: { findLedgerTXs: null } }) === null && parseLedgerRows('nope') === null && parseLedgerRows({ errors: [{}] }) === null; })());

if (failures === 0) {
  console.log(`\nmeritum-executed-signal: ALL ${checks} CHECKS PASSED`);
  process.exit(0);
} else {
  console.error(`\nmeritum-executed-signal: ${failures}/${checks} CHECK(S) FAILED`);
  process.exit(1);
}
