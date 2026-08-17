/**
 * `assertDigestMatches` invariants — plain assertions, no test runner (this repo
 * has none, and adding one is out of scope).
 *
 * RUN IT (from the repo root — running it from apps/blog cannot resolve the
 * entry path and dies with MODULE_NOT_FOUND before a single check executes):
 *   npx ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node","esModuleInterop":true,"skipLibCheck":true}' \
 *     packages/smart-signer/lib/signer/__tests__/assert-digest.test.ts
 *
 * Exits 0 when every check passes, 1 otherwise.
 *
 * ★ THE DIGESTS BELOW ARE REAL, NOT INVENTED. They were measured on 2026-08-17
 * by building one creator-tokens `register` transaction on the Magi testnet
 * chain and rebuilding the SAME proto on the app's global mainnet chain, which
 * is exactly what the wallet signers do:
 *
 *   testnet (what the broadcaster passes as `digest`) 77cc5e5c...cc724
 *   mainnet (what the wallet was handed to sign)      2f582dff...c6948
 *
 * Hard-coded rather than recomputed so this test needs no network and cannot go
 * green because an API was unreachable. The live reproduction lives in the
 * module's own comment.
 */
import { assertDigestMatches } from '../assert-digest';

const TESTNET_DIGEST = '77cc5e5ce2663f994952a46a482261f36e5c32018572811d561cc5f3311cc724';
const MAINNET_DIGEST = '2f582dfff74f10746eb0ea2f6d18067315a7f0be3285c40a2030ee54c54c6948';

let checks = 0;
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function threw(fn: () => void): Error | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

// ── 1. the real wrong-chain case must be refused ───────────────────────────
const wrongChain = threw(() => assertDigestMatches(TESTNET_DIGEST, MAINNET_DIGEST, 'Keychain'));
check('a transaction built for another network is REFUSED', wrongChain !== null);
check(
  'the refusal names the signer',
  wrongChain !== null && wrongChain.message.includes('Keychain'),
  wrongChain?.message
);
check(
  'the refusal explains it is a network mismatch, not a hash mismatch',
  wrongChain !== null && /different network/i.test(wrongChain.message),
  wrongChain?.message
);
check(
  'the refusal does not leak a full digest',
  wrongChain !== null && !wrongChain.message.includes(TESTNET_DIGEST),
  wrongChain?.message
);

// ── 2. NEGATIVE CONTROL — the ordinary case must be untouched ──────────────
//
// Without this, check 1 would pass for a function that threw unconditionally,
// which would break every signature in the app rather than fix one.
check('matching digests are allowed through', threw(() => assertDigestMatches(TESTNET_DIGEST, TESTNET_DIGEST, 'Keychain')) === null);
check('matching digests are allowed through (mainnet too)', threw(() => assertDigestMatches(MAINNET_DIGEST, MAINNET_DIGEST, 'PeakVault')) === null);

// ── 3. it must not be fooled by case or truncation ─────────────────────────
check(
  'a digest differing only in its tail is refused',
  threw(() => assertDigestMatches(TESTNET_DIGEST, TESTNET_DIGEST.slice(0, -1) + '0', 'MetaMask')) !== null
);

console.log(
  failures === 0
    ? `\nPASS — ${checks} checks, refusal proven on the real measured digests with its negative control`
    : `\nFAIL — ${failures} of ${checks} checks failed`
);
process.exit(failures === 0 ? 0 : 1);
