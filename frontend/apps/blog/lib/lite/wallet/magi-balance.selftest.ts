/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * Self-test for the Magi spending-power read. Run:
 *   cd apps/blog && npx tsx lib/lite/wallet/magi-balance.selftest.ts
 *
 * Two halves. The pure logic runs offline against a stubbed fetch. Then, if
 * MAGI_GQL_URL is set, it does ONE read-only query against a real node to prove the
 * query shape still matches the schema — reads only, nothing is ever submitted.
 */

import {
  RC_HIVE_FREE_AMOUNT,
  checkAffordable,
  getsFreeResourceCredits,
  readMagiSpendingPower,
  type MagiSpendingPower
} from './magi-balance';

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (ok) console.log(`ok    ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const realFetch = globalThis.fetch;
function stubFetch(body: unknown, ok = true, status = 200): void {
  globalThis.fetch = (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;
}
function restore(): void {
  globalThis.fetch = realFetch;
}

async function throws(name: string, fn: () => Promise<unknown>, fragment: string): Promise<void> {
  let msg = '';
  try {
    await fn();
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  check(name, msg.includes(fragment), msg === '' ? 'it did NOT throw' : `threw: ${msg}`);
}

async function main(): Promise<void> {
  // ── who gets free resource credits ──────────────────────────────────────────
  check('a hive: account gets the free allowance', getsFreeResourceCredits('hive:alice'));
  check('an EVM wallet gets NOTHING free', !getsFreeResourceCredits('did:pkh:eip155:1:0xabc'));
  check('a BTC wallet gets NOTHING free', !getsFreeResourceCredits('did:pkh:bip122:000:bc1q'));
  check('the free allowance matches params.go', RC_HIVE_FREE_AMOUNT === 10_000);

  // ── the happy read ──────────────────────────────────────────────────────────
  {
    // Shaped on a REAL live response from magi-test.techcoderx.com.
    stubFetch({
      data: {
        getAccountBalance: { account: 'hive:milo.magi', block_height: 4810460, hbd: 103297 },
        getAccountRC: { account: 'hive:milo.magi', amount: 113297, max_rcs: 113297 }
      }
    });
    const p = await readMagiSpendingPower('http://x', 'hive:milo.magi');
    check('balance is read in base units', p.balance.hbdBaseUnits === 103297, JSON.stringify(p.balance));
    check('RC is read', p.rc.amount === 113297);
    check('a funded account can transact', !p.cannotTransact);
    // The live pair differs by exactly the free allowance — the formula, observed.
    check(
      'RC minus balance equals the free allowance for a hive: account',
      p.rc.amount - p.balance.hbdBaseUnits === RC_HIVE_FREE_AMOUNT,
      `${p.rc.amount} - ${p.balance.hbdBaseUnits}`
    );
    restore();
  }

  // ── the wallet identity with nothing: the state that shapes the product ─────
  {
    stubFetch({
      data: {
        getAccountBalance: { account: 'did:pkh:eip155:1:0xabc', block_height: 100, hbd: 0 },
        getAccountRC: { account: 'did:pkh:eip155:1:0xabc', amount: 0, max_rcs: 0 }
      }
    });
    const p = await readMagiSpendingPower('http://x', 'did:pkh:eip155:1:0xabc');
    check('an empty wallet is flagged as unable to transact', p.cannotTransact);
    check(
      'and the reason given is RC, not the price',
      checkAffordable(p, 1000) === 'no_resource_credits',
      checkAffordable(p, 1000)
    );
    restore();
  }

  // ── a failed read must NEVER look like a zero balance ───────────────────────
  {
    stubFetch({}, false, 503);
    await throws('an HTTP failure throws', () => readMagiSpendingPower('http://x', 'hive:a'), 'HTTP 503');
    restore();
  }
  {
    stubFetch({ errors: [{ message: 'node exploded' }] });
    await throws(
      'a GraphQL error throws',
      () => readMagiSpendingPower('http://x', 'hive:a'),
      'node exploded'
    );
    restore();
  }
  {
    // The subtle one: the query succeeds and the record is null. That is "unknown",
    // not "zero", and conflating them would tell someone their funds are gone.
    stubFetch({ data: { getAccountBalance: null, getAccountRC: null } });
    await throws(
      'a null balance record throws rather than reading as 0',
      () => readMagiSpendingPower('http://x', 'hive:a'),
      // ★ Matched to the message the code ACTUALLY throws. This expected
      // 'no balance record' while `readMagiSpendingPower` says "no record at
      // all", so the assertion never matched and the check has been failing —
      // i.e. inert — since the both-null branch was reworded. Pre-existing;
      // found while sweeping the suite on 2026-08-20.
      'no record at all'
    );
    restore();
  }
  {
    stubFetch({
      data: {
        getAccountBalance: { hbd: 'not-a-number', block_height: 1 },
        getAccountRC: { amount: 1, max_rcs: 1 }
      }
    });
    await throws(
      'a non-numeric balance throws rather than becoming NaN',
      () => readMagiSpendingPower('http://x', 'hive:a'),
      'was not a number'
    );
    restore();
  }
  await throws('no endpoint throws', () => readMagiSpendingPower('', 'hive:a'), 'no GraphQL endpoint');
  await throws('no account throws', () => readMagiSpendingPower('http://x', ''), 'no account');

// ★ A BARE Hive username must be prefixed before it reaches the ledger. Without
// this the balance read queried an account that never existed, returned a
// present-but-zero RC row beside a missing balance row (a genuine zero by
// design), and disabled Buy and Ask for every full Hive account. Measured on
// testnet: `lumen.aria` -> null / RC 0; `hive:lumen.aria` -> 92,946 HBD.
{
  let sent: string | null = null;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init: { body: string }) => {
    sent = JSON.parse(init.body).variables.account as string;
    return { ok: true, json: async () => ({ data: { getAccountBalance: { hbd: 1, block_height: 1 }, getAccountRC: { amount: 1, max_rcs: 1 } } }) };
  }) as never;
  await readMagiSpendingPower('http://x', 'lumen.aria');
  check('a bare Hive username is sent as hive:<name>', sent === 'hive:lumen.aria', String(sent));
  await readMagiSpendingPower('http://x', 'hive:lumen.aria');
  check('an already-prefixed account is not double-prefixed', sent === 'hive:lumen.aria', String(sent));
  await readMagiSpendingPower('http://x', 'did:pkh:eip155:1:0xabc');
  check('a DID is passed through untouched', sent === 'did:pkh:eip155:1:0xabc', String(sent));
  globalThis.fetch = original;
}

  // ── affordability reasons ───────────────────────────────────────────────────
  {
    const funded: MagiSpendingPower = {
      balance: { account: 'hive:a', hbdBaseUnits: 5000, blockHeight: 1 },
      rc: { account: 'hive:a', amount: 15000, maxRcs: 15000 },
      cannotTransact: false
    };
    check('affordable when the balance covers it', checkAffordable(funded, 5000) === 'ok');
    check(
      'short balance is reported as insufficient HBD',
      checkAffordable(funded, 5001) === 'insufficient_hbd'
    );
    check('a zero cost is affordable', checkAffordable(funded, 0) === 'ok');

    // RC is reported FIRST even when the balance is also short: telling someone to
    // top up by 5 HBD is a wrong instruction when no amount would let them transact.
    const broke: MagiSpendingPower = { ...funded, rc: { ...funded.rc, amount: 0 }, cannotTransact: true };
    check(
      'zero RC outranks an insufficient balance',
      checkAffordable(broke, 999999) === 'no_resource_credits'
    );
  }

  // ── optional: one live read-only query ──────────────────────────────────────
  const liveUrl = process.env.MAGI_GQL_URL;
  if (liveUrl) {
    try {
      const p = await readMagiSpendingPower(liveUrl, process.env.MAGI_ACCOUNT ?? 'hive:milo.magi');
      check(`live read succeeded (hbd=${p.balance.hbdBaseUnits}, rc=${p.rc.amount})`, true);
    } catch (e) {
      check('live read', false, e instanceof Error ? e.message : String(e));
    }
  } else {
    console.log('note  live read skipped (set MAGI_GQL_URL to include it)');
  }

  console.log(`\n${checks - failures}/${checks} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
