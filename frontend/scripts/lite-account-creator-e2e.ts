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

  console.log('\nkeys are the browser\'s job, not this module\'s');

  // THE structural property of the 2026-07-28 custody change. A master password IS the
  // owner key; a server that can mint one can take the account later, whatever it
  // promises. So the capability is gone, not merely unused — asserted here because a
  // helpful refactor could otherwise add it back and nothing would complain.
  check(
    'the server-side creator exposes NO key generation',
    !('generateKeys' in hiveAccountCreator),
    `keys: ${Object.keys(hiveAccountCreator).join(', ')}`
  );
  check(
    'and no other member returns private key material',
    !Object.keys(hiveAccountCreator).some((k) => /password|wif|private|secret/i.test(k))
  );

  console.log('\nthe derivation the BROWSER performs (same wax, run here offline)');

  // Mirrors features/lite-auth/upgrade/browser-keys.ts. That module cannot be imported
  // here (it pulls the client chain module), so the properties it must hold are proven
  // against the same wax primitives it calls.
  const name = 'lumentest1';
  const masterPassword = `P${wax.suggestBrainKey().wifPrivateKey}`;
  const roles = ['owner', 'active', 'posting', 'memo'] as const;
  const derived = Object.fromEntries(
    roles.map((role) => {
      const key = wax.getPrivateKeyFromPassword(name, role, masterPassword);
      return [role, { publicKey: key.associatedPublicKey, privateWif: key.wifPrivateKey }];
    })
  ) as Record<(typeof roles)[number], { publicKey: string; privateWif: string }>;

  check(
    'master password is "P" + WIF',
    /^P5[1-9A-HJ-NP-Za-km-z]{50,51}$/.test(masterPassword),
    `got length ${masterPassword.length}`
  );
  // The format is load-bearing, not cosmetic: it is what stops an owner key reaching
  // Sentry if a browser error report ever carries one.
  check(
    'the Sentry scrubber redacts a real master password',
    !scrubSensitiveData(`boom: ${masterPassword}`).includes(masterPassword)
  );
  check(
    'the Sentry scrubber redacts a real private WIF',
    !scrubSensitiveData(`boom: ${derived.owner.privateWif}`).includes(derived.owner.privateWif)
  );
  check(
    'every private key matches its public key',
    roles.every((role) => wax.calculatePublicKey(derived[role].privateWif) === derived[role].publicKey)
  );
  // The user keeps ONE artefact. If it does not regenerate these four keys, the
  // account is unrecoverable no matter what else is correct.
  check(
    'the master password re-derives all four keys for this account name',
    roles.every(
      (role) =>
        wax.getPrivateKeyFromPassword(name, role, masterPassword).associatedPublicKey ===
        derived[role].publicKey
    )
  );
  check('four roles are four distinct keys', new Set(roles.map((r) => derived[r].publicKey)).size === 4);
  check(
    'derivation is account-name bound (so keys must be made AFTER the name is final)',
    wax.getPrivateKeyFromPassword('lumentest2', 'owner', masterPassword).associatedPublicKey !==
      derived.owner.publicKey
  );
  check(
    'two generations produce different passwords (real entropy)',
    `P${wax.suggestBrainKey().wifPrivateKey}` !== masterPassword
  );
}

/* ═══════════════════ part 2 — pre-broadcast guards, in-process ════════════════════ */

async function runGuardTests(): Promise<void> {
  const { hiveAccountCreator } = await import('../apps/blog/lib/lite/upgrade/hive-account-creator');
  const { createWaxFoundation } = await import('@hiveio/wax');
  const wax = await createWaxFoundation();

  console.log('\npre-broadcast refusals (nothing reaches the chain)');

  const password = `P${wax.suggestBrainKey().wifPrivateKey}`;
  const pub = (role: 'owner' | 'active' | 'posting' | 'memo') =>
    wax.getPrivateKeyFromPassword('lumentest1', role, password).associatedPublicKey;
  const keys = { owner: pub('owner'), active: pub('active'), posting: pub('posting'), memo: pub('memo') };

  const malformed = await thrown(() =>
    hiveAccountCreator.createClaimedAccount('lumentest1', { ...keys, memo: 'not-a-key' })
  );
  check(
    'refuses a malformed public key',
    malformed !== null && /memo public key is missing or malformed/.test(malformed),
    malformed ?? 'it did not throw'
  );

  // A client bug that posted a private key into a public-key field must be refused at
  // the boundary, not written into an authority — and not into our request logs.
  const wifAsPublic = await thrown(() =>
    hiveAccountCreator.createClaimedAccount('lumentest1', {
      ...keys,
      posting: wax.getPrivateKeyFromPassword('lumentest1', 'posting', password).wifPrivateKey
    })
  );
  check(
    'refuses a WIF submitted where a public key belongs',
    wifAsPublic !== null && /posting public key is missing or malformed/.test(wifAsPublic),
    wifAsPublic ?? 'it did not throw'
  );

  // Reusing one key across roles would quietly give the posting key — the one that
  // lives in browsers and third-party apps — the authority to move funds.
  const duplicated = await thrown(() =>
    hiveAccountCreator.createClaimedAccount('lumentest1', { ...keys, posting: keys.active })
  );
  check(
    'refuses the same key in two roles',
    duplicated !== null && /must be distinct/.test(duplicated),
    duplicated ?? 'it did not throw'
  );

  const missing = await thrown(() =>
    hiveAccountCreator.createClaimedAccount('lumentest1', {
      ...keys,
      active: undefined as unknown as string
    })
  );
  check(
    'refuses a missing key',
    missing !== null && /active public key is missing or malformed/.test(missing),
    missing ?? 'it did not throw'
  );

  check(
    'no refusal message can leak a secret (there is none in scope to leak)',
    [malformed, wifAsPublic, duplicated, missing].every((m) => !m || !m.includes(password))
  );

  // Correct input must NOT be rejected by the guards — otherwise the suite above only
  // proves the module refuses everything. This one is expected to fail LATER, at the
  // signer, because no creator account is configured in this process.
  const validErr = await thrown(() => hiveAccountCreator.createClaimedAccount('lumentest1', keys));
  check(
    'well-formed keys pass every offline guard and fail only at the unconfigured signer',
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
      '  - the browser-minted master password actually opens the account this module creates'
  );
  process.exit(failed === 0 ? 0 : 1);
}

void main();
