/**
 * Proves the real `AccountCreator` (lib/lite/upgrade/hive-account-creator.ts).
 *
 *   cd apps/blog && npx tsx ../../scripts/lite-account-creator-e2e.ts
 *
 * Everything here runs WITHOUT a chain, on purpose. The one thing this module does
 * that cannot be undone — `create_claimed_account` — permanently spends a token and
 * permanently occupies a name, so a test suite is exactly the wrong place to
 * exercise it. What CAN be proven offline is everything that decides whether that
 * broadcast should happen at all:
 *
 *   - key derivation is real, reversible by the user, and bound to the account name
 *   - the pre-broadcast guards reject the inputs that would strand an account
 *   - the bootstrap guards refuse the configurations that would create one by accident
 *   - the read path fails loud instead of answering "no such account" on a node outage
 *
 * The guard cases run in CHILD PROCESSES because `liteConfig` freezes its values at
 * import: a test that mutated env after importing would be testing nothing. Each
 * child imports the module fresh under one specific configuration.
 *
 * Still requires a real testnet before launch: an actual claim_account + a real
 * create_claimed_account against a funded creator account. Named in the report at the
 * bottom rather than quietly skipped.
 */

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const MAINNET_CHAIN_ID = 'beeab0de00000000000000000000000000000000000000000000000000000000';

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Run `fn` and report the error it threw, or null if it unexpectedly succeeded. */
async function thrown(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/* ══════════════════════════ part 1 — offline, in-process ══════════════════════════ */

async function runKeyTests(): Promise<void> {
  const { hiveAccountCreator } = await import('../apps/blog/lib/lite/upgrade/hive-account-creator');
  const { scrubSensitiveData } = await import('../packages/ui/lib/sentry-scrub');
  const { createWaxFoundation } = await import('@hiveio/wax');
  const wax = await createWaxFoundation();

  console.log('\nkey generation');

  const name = 'lumentest1';
  const keys = await hiveAccountCreator.generateKeys(name);
  const roles = ['owner', 'active', 'posting', 'memo'] as const;

  check(
    'master password is "P" + WIF',
    /^P5[1-9A-HJ-NP-Za-km-z]{50,51}$/.test(keys.masterPassword),
    `got length ${keys.masterPassword.length}`
  );

  // The format is load-bearing, not cosmetic: this exact pattern is what stops an
  // owner key reaching Sentry when something throws while holding the password.
  check(
    'the Sentry scrubber redacts a real generated master password',
    !scrubSensitiveData(`boom: ${keys.masterPassword}`).includes(keys.masterPassword)
  );
  check(
    'the Sentry scrubber redacts a real generated private WIF',
    !scrubSensitiveData(`boom: ${keys.owner.privateWif}`).includes(keys.owner.privateWif)
  );

  check(
    'every private key matches its public key',
    roles.every((role) => wax.calculatePublicKey(keys[role].privateWif) === keys[role].publicKey)
  );

  // The user gets ONE artefact — the master password. If it does not regenerate these
  // four keys, the account is unrecoverable no matter what else is correct.
  const rederived = roles.map((role) => wax.getPrivateKeyFromPassword(name, role, keys.masterPassword));
  check(
    'the master password re-derives all four keys for this account name',
    roles.every((role, i) => rederived[i].associatedPublicKey === keys[role].publicKey)
  );

  check('four roles are four distinct keys', new Set(roles.map((r) => keys[r].publicKey)).size === 4);

  const second = await hiveAccountCreator.generateKeys(name);
  check(
    'two generations for the same name produce different passwords (real entropy)',
    second.masterPassword !== keys.masterPassword
  );

  const otherName = await hiveAccountCreator.generateKeys('lumentest2');
  check(
    'derivation is account-name bound',
    wax.getPrivateKeyFromPassword('lumentest2', 'owner', keys.masterPassword).associatedPublicKey !==
      keys.owner.publicKey,
    'the same password derived the same owner key for a different name'
  );
  check('a second name yields a different master password', otherName.masterPassword !== keys.masterPassword);
}

/* ═══════════════════ part 2 — pre-broadcast guards, in-process ════════════════════ */

async function runGuardTests(): Promise<void> {
  const { hiveAccountCreator } = await import('../apps/blog/lib/lite/upgrade/hive-account-creator');

  console.log('\npre-broadcast refusals (nothing reaches the chain)');

  const keys = await hiveAccountCreator.generateKeys('lumentest1');

  // THE case this guard exists for. `generateKeys(a)` then `createClaimedAccount(b)`
  // would mint an account whose master password does not open it — silently, with no
  // error anywhere, forever.
  const mismatch = await thrown(() => hiveAccountCreator.createClaimedAccount('lumentest2', keys));
  check(
    'refuses keys generated for a DIFFERENT account name',
    mismatch !== null && /does not derive from this master password/.test(mismatch),
    mismatch ?? 'it did not throw'
  );
  check(
    'the name-mismatch refusal happens before any signer/config access',
    // No WIF and no creator account are configured in this process, so reaching the
    // signer would produce a config error instead. A binding error proves the order.
    mismatch !== null && !/LITE_ACCOUNT_CREATOR/.test(mismatch),
    mismatch ?? ''
  );
  check(
    'the refusal names only public keys, never the master password or a WIF',
    mismatch !== null &&
      !mismatch.includes(keys.masterPassword) &&
      !['owner', 'active', 'posting', 'memo'].some((r) =>
        mismatch.includes(keys[r as 'owner'].privateWif)
      )
  );

  const corrupted = { ...keys, posting: { ...keys.posting, privateWif: keys.owner.privateWif } };
  const corruptErr = await thrown(() => hiveAccountCreator.createClaimedAccount('lumentest1', corrupted));
  check(
    'refuses a private/public key pair that does not match',
    corruptErr !== null && /does not derive from this master password|does not match its public key/.test(corruptErr),
    corruptErr ?? 'it did not throw'
  );

  const badFormat = { ...keys, masterPassword: keys.masterPassword.slice(1) }; // drop the 'P'
  const formatErr = await thrown(() => hiveAccountCreator.createClaimedAccount('lumentest1', badFormat));
  check(
    'refuses a master password that is not in "P" + WIF format',
    formatErr !== null && /not in the required "P"\+WIF format/.test(formatErr),
    formatErr ?? 'it did not throw'
  );

  const empty = { ...keys, memo: { publicKey: '', privateWif: '' } };
  const emptyErr = await thrown(() => hiveAccountCreator.createClaimedAccount('lumentest1', empty));
  check(
    'refuses a key pair that is blank or missing',
    emptyErr !== null && /the memo key pair is missing/.test(emptyErr),
    emptyErr ?? 'it did not throw'
  );

  const swapped = { ...keys, owner: keys.active, active: keys.owner };
  const swapErr = await thrown(() => hiveAccountCreator.createClaimedAccount('lumentest1', swapped));
  check(
    'refuses role keys that have been swapped',
    swapErr !== null && /does not derive from this master password/.test(swapErr),
    swapErr ?? 'it did not throw'
  );

  // Correct input must NOT be rejected by the guards — otherwise the suite above only
  // proves the module refuses everything. This one is expected to fail LATER, at the
  // signer, because no creator account is configured in this process.
  const validErr = await thrown(() => hiveAccountCreator.createClaimedAccount('lumentest1', keys));
  check(
    'correctly bound keys pass every offline guard and fail only at the unconfigured signer',
    validErr !== null && /LITE_ACCOUNT_CREATOR_ACCOUNT|not configured/.test(validErr),
    validErr ?? 'it did not throw at all — the signer guard is missing'
  );
}

/* ══════════════ part 2b — why claims must be spaced (offline, provable) ═══════════ */

/**
 * Pins the fact `CLAIM_INTERVAL_MS` exists for. If wax ever starts varying something
 * per transaction (a nonce, sub-second expiration), this test fails and the pacing
 * can be reconsidered — rather than silently remaining cargo-cult.
 */
async function runDuplicateTxTest(): Promise<void> {
  console.log('\nthe reason claims are paced');

  const { createWaxFoundation } = await import('@hiveio/wax');
  const wax = await createWaxFoundation();
  const tapos = '0000000109833ce528d5bbfb3f6225b39ee10086';
  const op = {
    claim_account_operation: {
      creator: 'lumen-creator',
      fee: { amount: '0', precision: 3, nai: '@@000000021' },
      extensions: []
    }
  };
  const build = () => {
    const tx = wax.createTransactionWithTaPoS(tapos);
    tx.pushOperation(op);
    return tx;
  };

  check(
    'two back-to-back claim_account transactions are byte-identical (Hive would reject the duplicate)',
    build().id === build().id,
    'they now differ — CLAIM_INTERVAL_MS may no longer be needed'
  );
}

/* ═══════════════════ part 3 — bootstrap guards, in child processes ════════════════ */

interface Case {
  name: string;
  env: Record<string, string | undefined>;
  expect: string;
}

/**
 * Each case names the ONE configuration it is proving. `expect` is matched against
 * the child's single line of output, which is either `ok:<detail>` or `throw:<message>`.
 */
const CASES: Case[] = [
  {
    name: 'no WIF configured leaves the creator dark (returns false, installs nothing)',
    env: { LITE_ACCOUNT_CREATOR_ACTIVE_WIF: undefined },
    expect: 'ok:false installed=false'
  },
  {
    name: 'refuses an env-var private key in production',
    env: { NODE_ENV: 'production' },
    expect: 'throw:.*must not be used in production'
  },
  {
    name: 'refuses to arm against MAINNET without an explicit opt-in',
    env: { REACT_APP_CHAIN_ID: MAINNET_CHAIN_ID, REACT_APP_API_ENDPOINT: 'https://api.hive.blog' },
    expect: 'throw:Refusing to arm the dev account creator against MAINNET'
  },
  {
    name: 'arms against MAINNET only when the opt-in is stated out loud',
    env: {
      REACT_APP_CHAIN_ID: MAINNET_CHAIN_ID,
      REACT_APP_API_ENDPOINT: 'https://api.hive.blog',
      LITE_ACCOUNT_CREATOR_ALLOW_MAINNET: 'yes'
    },
    expect: 'ok:true installed=true'
  },
  {
    name: 'an unset CHAIN_ID is treated as mainnet, not as a free pass',
    env: { REACT_APP_CHAIN_ID: undefined, REACT_APP_API_ENDPOINT: undefined },
    expect: 'throw:Refusing to arm the dev account creator against MAINNET'
  },
  {
    name: 'a mainnet ENDPOINT is refused even when CHAIN_ID says testnet',
    env: { REACT_APP_CHAIN_ID: 'testnet', REACT_APP_API_ENDPOINT: 'https://api.openhive.network' },
    expect: 'throw:Refusing to arm the dev account creator against MAINNET'
  },
  {
    name: 'arms freely against a testnet',
    env: { REACT_APP_CHAIN_ID: 'testnet', REACT_APP_API_ENDPOINT: 'https://testnet.example.invalid' },
    expect: 'ok:true installed=true'
  },
  {
    name: 'accountExists PROPAGATES a node failure (never answers false on doubt)',
    env: { REACT_APP_CHAIN_ID: 'testnet', REACT_APP_API_ENDPOINT: 'http://127.0.0.1:1' },
    expect: 'throw:.'
  },
  {
    name: 'pendingActCount refuses when no creator account is configured',
    env: { LITE_ACCOUNT_CREATOR_ACCOUNT_TESTNET: undefined, REACT_APP_CHAIN_ID: 'testnet' },
    expect: 'throw:No account-creator account configured'
  }
];

/** What a child process actually does, selected by LITE_TEST_CASE. */
async function runChildCase(index: number): Promise<void> {
  const { hiveAccountCreator, installDevAccountCreator } = await import(
    '../apps/blog/lib/lite/upgrade/hive-account-creator'
  );
  const { hasAccountCreator } = await import('../apps/blog/lib/lite/upgrade/account-creator');

  const name = CASES[index].name;
  try {
    if (name.startsWith('accountExists')) {
      const exists = await hiveAccountCreator.accountExists('nosuchaccount');
      // Reaching here at all is the failure: a refused connection must not become `false`.
      console.log(`ok:returned ${exists} instead of throwing`);
      return;
    }
    if (name.startsWith('pendingActCount')) {
      const count = await hiveAccountCreator.pendingActCount();
      console.log(`ok:returned ${count} instead of throwing`);
      return;
    }
    const installed = installDevAccountCreator();
    console.log(`ok:${installed} installed=${hasAccountCreator()}`);
  } catch (error) {
    console.log(`throw:${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runCaseTests(): Promise<void> {
  console.log('\nbootstrap guards (each in a fresh process, real frozen config)');
  const self = fileURLToPath(import.meta.url);

  // A throwaway but genuinely well-formed WIF. None of these cases ever imports it
  // into a wallet — `installDevAccountCreator` only checks that one is CONFIGURED —
  // but a real key shape keeps the test honest if that ever changes.
  const { createWaxFoundation } = await import('@hiveio/wax');
  const { randomBytes } = await import('crypto');
  const throwawayWif = (await createWaxFoundation()).convertRawPrivateKeyToWif(
    randomBytes(32).toString('hex')
  );

  // Inherit the loader flags this process was started with (tsx), so the children
  // run TypeScript the same way regardless of how tsx is installed.
  const loaderArgs = process.execArgv.filter((arg, i, all) => arg !== '--eval' && all[i - 1] !== '--eval');

  CASES.forEach((testCase, index) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      // Defaults every case starts from; individual cases override or unset these.
      NODE_ENV: 'development',
      REACT_APP_CHAIN_ID: 'testnet',
      REACT_APP_API_ENDPOINT: 'https://testnet.example.invalid',
      LITE_ACCOUNT_CREATOR_ACCOUNT_TESTNET: 'lumen-creator',
      LITE_ACCOUNT_CREATOR_ACTIVE_WIF: throwawayWif,
      LITE_TEST_CASE: String(index)
    };
    delete env.LITE_ACCOUNT_CREATOR_ALLOW_MAINNET;
    for (const [key, value] of Object.entries(testCase.env)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }

    const result = spawnSync(process.execPath, [...loaderArgs, self], {
      env,
      encoding: 'utf8',
      cwd: process.cwd()
    });
    const line =
      (result.stdout || '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('ok:') || l.startsWith('throw:'))
        .pop() ?? `no-output(status=${result.status}) ${(result.stderr || '').split('\n').slice(-4).join(' | ')}`;

    check(testCase.name, new RegExp(testCase.expect).test(line), line.slice(0, 220));
  });
}

/* ═════════════════════════════════════ main ══════════════════════════════════════ */

async function main(): Promise<void> {
  if (process.env.LITE_TEST_CASE) {
    await runChildCase(Number(process.env.LITE_TEST_CASE));
    return;
  }

  console.log('lite account creator — offline proof');
  await runKeyTests();
  await runGuardTests();
  await runDuplicateTxTest();
  await runCaseTests();

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(
    '\nNOT PROVEN HERE (needs a testnet + a creator account with delegated HP/RC):\n' +
      '  - claim_account actually lands and increments pending_claimed_accounts\n' +
      '  - create_claimed_account actually creates a usable account\n' +
      '  - the boot-time ACTIVE-authority and weight-threshold checks against a real account\n' +
      '  - the new account can be logged into with the master password this module minted'
  );
  process.exit(failed === 0 ? 0 : 1);
}

void main();
