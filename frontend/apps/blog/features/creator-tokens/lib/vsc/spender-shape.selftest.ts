// The "test file" for spender-shape.ts — same shape and same reason as
// payload-contract.selftest.ts (see that file's header for the full survey of
// why apps/blog has no unit runner and why these are plain self-invoking
// checkers rather than *.test.ts files nothing would execute).
//
// HOW TO RUN IT BY HAND: `npx tsx features/creator-tokens/lib/vsc/spender-shape.selftest.ts`
// from apps/blog. It also runs itself automatically in development — see the
// bottom of this file, and the import in vsc-data-source.ts.

import * as builders from './op-builders';
import { isPlausibleSpender, spenderShapeProblem } from './spender-shape';

const SPENDABLE: string[] = [
  'hive:market',
  'hive:alice',
  'hive:foo.bar', // dotted names are legal when every segment is >= 3 characters
  'hive:blocktrades',
  'contract:vsc1BcaD8JrwJPAAN5cU1cHKCBdZrd7jz2WGt8',
  'did:pkh:eip155:1:0x1234567890abcdef1234567890abcdef12345678',
  'did:pkh:bip122:000000000019d6689c085ae165831e93:1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
];

// The two shapes the audit measured as permanently unspendable, plus the
// obvious neighbours. Each of these is accepted by core.Approve today.
const UNSPENDABLE: string[] = [
  'vsc1BcaD8JrwJPAAN5cU1cHKCBdZrd7jz2WGt8', // bare contract id — auths always carry a scheme
  'hive:vsc1BcaD8JrwJPAAN5cU1cHKCBdZrd7jz2WGt8', // a contract id wearing a hive: prefix
  'market', // bare account name — the caller is always hive:-prefixed
  'HIVE:market', // wrong case: the chain writes a lowercase scheme
  'hive:', // no body
  'contract:', // no body
  'did:', // no body
  '', // empty
  'hive:UPPER', // Hive names are lowercase
  'hive:ab', // too short for a Hive account
  'hive:a.b.c', // dotted, but Hive requires every segment to be >= 3 characters
  'hive:averyveryverylongaccountname', // too long for a Hive account
  'hive:mar|ket', // the contract's key delimiter
];

export function runSpenderShapeSelfTest(): void {
  const failures: string[] = [];

  for (const s of SPENDABLE) {
    const problem = spenderShapeProblem(s);
    if (problem !== null) {
      failures.push(`${JSON.stringify(s)} SHOULD be spendable but was refused: ${problem}`);
    }
  }
  for (const s of UNSPENDABLE) {
    if (isPlausibleSpender(s)) {
      failures.push(
        `${JSON.stringify(s)} was accepted, but no signer can ever present it as the caller — ` +
          'granting it would store permanent authority nothing can spend'
      );
    }
  }

  // ANTI-VACUITY: if the guard degenerated into "accept everything" or "refuse
  // everything", every case above could still line up by accident on an empty
  // list. Pin that both lists actually have teeth.
  if (SPENDABLE.length === 0 || UNSPENDABLE.length === 0) {
    failures.push('a case list is empty — this self-test would pass vacuously');
  }

  if (failures.length > 0) {
    throw new Error(`creator-tokens spender-shape self-test FAILED:\n- ${failures.join('\n- ')}`);
  }
}

/**
 * ★ THE TRIPWIRE, and the reason this file is not dormant.
 *
 * There is no approve / allowance / safeTransferFrom builder in this client
 * today — the doors exist on chain for magi-market and nothing here calls
 * them. The moment somebody adds one, this fails, so the person adding it is
 * told about assertSpenderShape at the point they need it rather than
 * discovering the footgun the way the audit did.
 *
 * When that happens: route the new builder through assertSpenderShape, then
 * replace this check with one that drives the builder itself and asserts it
 * REFUSES a spender from UNSPENDABLE above. A behavioural assertion is
 * strictly better than this name check; this only exists because there is
 * nothing to assert against yet.
 */
export function assertNoUnguardedGrantBuilder(): void {
  const grantBuilders = Object.keys(builders).filter((name) =>
    /approve|allowance|safeTransferFrom/i.test(name)
  );
  if (grantBuilders.length > 0) {
    throw new Error(
      `creator-tokens: op-builders.ts now exports ${grantBuilders.join(', ')}, but this self-test ` +
        'still only checks spender shapes in the abstract. Route the new builder through ' +
        'assertSpenderShape(spender) (lib/vsc/spender-shape.ts — it explains which strings can ' +
        'ever be a caller and why), then upgrade this check to drive the builder and assert it ' +
        'refuses an unspendable spender. See audit anomaly A5-07.'
    );
  }
}

if (process.env.NODE_ENV !== 'production') {
  runSpenderShapeSelfTest();
  assertNoUnguardedGrantBuilder();
}
