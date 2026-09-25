/**
 * UNIT TESTS for `features/direct-messages/lib/hive-memo.ts`: the browser's Hive memo code
 * (used to back up a WIF login's messaging key to its own posting key) against wax's own
 * beekeeper encryption provider, the reference for the "#" memo Keychain reads. Both
 * directions, plus a stranger's key. Random keys only; no secret is needed or read.
 * Run by `pnpm --filter @hive/blog test:unit` under ts-node; own harness.
 */
import { randomBytes } from 'crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { decodeMemo, encodeMemo, encodeMemoToKey, publicKeyOfWif } from '../../features/direct-messages/lib/hive-memo';

let checks = 0;
let failures = 0;
function ok(label: string, pass: boolean, detail = '') {
  checks++;
  if (pass) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}
function randomWif(): string {
  const body = new Uint8Array([0x80, ...secp256k1.utils.randomPrivateKey()]);
  return base58(new Uint8Array([...body, ...sha256(sha256(body)).slice(0, 4)]));
}

// ts-node compiles to CommonJS, which would turn import() into require(); these two
// packages are ES modules, so the import is kept as a real one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped dynamic ESM imports in a test
const esm = new Function('p', 'return import(p)') as (p: string) => Promise<any>;

async function main() {
  const { default: createBeekeeper } = await esm('@hiveio/beekeeper');
  const { createWaxFoundation } = await esm('@hiveio/wax');
  const { BeekeeperProvider } = await esm('@hiveio/wax-signers-beekeeper');
  const wax = await createWaxFoundation();
  const bk = await createBeekeeper({ inMemory: true, enableLogs: false });
  const session = bk.createSession(randomBytes(16).toString('hex'));
  const walletFor = async (wif: string) => {
    const { wallet } = await session.createWallet(`w${randomBytes(4).toString('hex')}`, undefined, true);
    const pub = await wallet.importKey(wif);
    return { pub, provider: BeekeeperProvider.for(wax, wallet, pub) };
  };

  const wif = randomWif();
  const me = await walletFor(wif);
  const secret = randomBytes(32).toString('base64');

  ok('the public key derived here is the one beekeeper derives', publicKeyOfWif(wif) === me.pub);

  const reference = await me.provider.encryptData(secret, me.pub);
  ok('the reference writes a "#" memo', reference.startsWith('#'));
  ok('a reference memo decodes here', (await decodeMemo(wif, reference)) === secret);

  const ours = await encodeMemo(wif, me.pub, secret);
  ok('ours is a "#" memo without the text in it', ours.startsWith('#') && !ours.includes(secret));
  ok('ours decodes in the reference', (await me.provider.decryptData(ours)) === secret);
  ok('ours decodes here', (await decodeMemo(wif, ours)) === secret);

  // How every messaging-key backup is now made (2026-09-25): sealed from a one-time key,
  // so no signer is asked. The account's own posting key must open it, in the reference
  // (what Keychain's requestVerifyKey does) and here.
  const sealed = await encodeMemoToKey(me.pub, secret);
  ok('a one-time-key memo is a "#" memo without the text in it', sealed.startsWith('#') && !sealed.includes(secret));
  ok('a one-time-key memo is not from the account key', sealed !== ours && (await encodeMemoToKey(me.pub, secret)) !== sealed);
  ok('a one-time-key memo opens in the reference with the account key', (await me.provider.decryptData(sealed)) === secret);
  ok('a one-time-key memo opens here with the account key', (await decodeMemo(wif, sealed)) === secret);

  const strangerWif = randomWif();
  const stranger = await walletFor(strangerWif);
  let strangerSealed = false;
  try {
    strangerSealed = (await stranger.provider.decryptData(sealed)) === secret;
  } catch {
    strangerSealed = false;
  }
  ok('a different key cannot open a one-time-key memo', !strangerSealed);
  let strangerHere = false;
  try {
    strangerHere = (await decodeMemo(strangerWif, ours)) === secret;
  } catch {
    strangerHere = false;
  }
  ok('a different key cannot open ours', !strangerHere);
  let strangerRef = false;
  try {
    strangerRef = (await stranger.provider.decryptData(reference)) === secret;
  } catch {
    strangerRef = false;
  }
  ok('a different key cannot open the reference memo', !strangerRef);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
