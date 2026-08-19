/**
 * Which strings can actually hold a token allowance — the client-side half of
 * audit anomaly A5-07 (2026-08-19).
 *
 * THE DEFECT. `core.Approve` validates a spender with `validAccount` alone:
 * printable ASCII, no `|`, at most 160 bytes. So it will happily store a grant
 * naming a spender that NO caller can ever present, and say nothing. The grant
 * is a permanent, unusable authority row, and `allowance` reads it back — so a
 * UI would show authority that does not exist.
 *
 * WHICH STRINGS CAN BE A CALLER, read from go-vsc-node at the PINNED commit
 * 33adaeb5 (not the working HEAD):
 *   - `hive:<account>` — every Hive-sourced auth is rewritten with the scheme
 *     prefix before it becomes the caller (state_engine.go:850/854, and again
 *     at :907/911, :958/962, :1191/1195).
 *   - `contract:<id>` — a nested contract call
 *     (execution-context.go:640, `Caller: "contract:" + ctx.env.ContractId`).
 *   - a DID, for a VSC-native transaction signed by a multichain identity.
 * A transaction may name its own `Caller`, but transactions.go:119-126 refuses
 * it unless it is already one of the auths, so the set above is closed.
 *
 * THEREFORE the two shapes the audit measured as dead really are dead: a BARE
 * contract id (`vsc1BcaD8…`) can never appear, because auths always carry a
 * scheme; and `hive:vsc1BcaD8…` would need a Hive account literally named
 * `vsc1BcaD8JrwJPAAN5cU1cHKCBdZrd7jz2WGt8` — 38 characters, with uppercase,
 * which Hive's own naming rules forbid.
 *
 * ★ WHY THIS LIVES IN THE CLIENT AND NOT IN THE CONTRACT. Narrowing
 * `core.Approve` would mean narrowing an AUTH door, and `validAccount` is
 * permissive on purpose — this contract has to accept multichain identities.
 * Guessing a whitelist there risks refusing a legitimate future caller shape
 * and silently breaking the magi-market integration the door exists for, which
 * is a far worse outcome than the harmless dead row this prevents. The typo is
 * best caught where it is made: before the grant is ever signed.
 *
 * ★ NOTHING CALLS THIS YET, AND THAT IS THE POINT. There is no approve /
 * allowance / safeTransferFrom surface anywhere in this client today (verified
 * by grep across apps/ and packages/: every "allowance" hit is Hive RC). This
 * exists so the guard is already here, with the evidence attached, when that
 * integration lands — and spender-shape.selftest.ts holds a tripwire that fails
 * the moment a grant builder appears without routing through it.
 */

/** The reason a spender string is unusable, or null when it is fine. */
export type SpenderShapeProblem = string | null;

/**
 * Hive account names: 3-16 characters, lowercase, made of dot-separated
 * segments; each segment starts with a letter, may contain digits and dashes,
 * and ends alphanumeric. Deliberately Hive's documented rule rather than
 * anything looser — the whole point is to reject a contract id wearing a
 * `hive:` prefix, and a looser test would let exactly that through.
 */
const HIVE_SEGMENT = /^[a-z][a-z0-9-]{1,}[a-z0-9]$/;

function isHiveAccountName(name: string): boolean {
  if (name.length < 3 || name.length > 16) return false;
  return name.split('.').every((seg) => HIVE_SEGMENT.test(seg));
}

/**
 * Explain why `spender` could never spend an allowance, or return null if it
 * could. Returning the reason rather than a bare boolean is deliberate: this
 * is a footgun guard, and "invalid" without a reason is how a caller ends up
 * guessing at the fix.
 */
export function spenderShapeProblem(spender: string): SpenderShapeProblem {
  if (typeof spender !== 'string' || spender.length === 0) {
    return 'spender is empty';
  }
  if (spender.includes('|')) {
    return 'spender contains "|", which is the contract\'s key delimiter and is refused on chain';
  }
  if (spender.startsWith('contract:')) {
    return spender.length > 'contract:'.length
      ? null
      : 'spender is a bare "contract:" prefix with no contract id';
  }
  if (spender.startsWith('did:')) {
    return spender.length > 'did:'.length
      ? null
      : 'spender is a bare "did:" prefix with no identity';
  }
  if (spender.startsWith('hive:')) {
    const name = spender.slice('hive:'.length);
    if (isHiveAccountName(name)) return null;
    return (
      `"${name}" is not a valid Hive account name (3-16 lowercase characters), so no signer can ` +
      'ever present this string as the caller. A contract must be named "contract:<id>", not "hive:<id>"'
    );
  }
  return (
    'spender has no scheme prefix. Only "hive:<account>", "contract:<id>" and "did:..." can ever ' +
    'be the caller on chain, so a bare id would be authority nothing can spend'
  );
}

/** True when `spender` is a string some signer could actually present. */
export function isPlausibleSpender(spender: string): boolean {
  return spenderShapeProblem(spender) === null;
}

/**
 * Throw unless `spender` could actually spend. Call this in any approve
 * payload builder BEFORE the grant is signed — an allowance to an unusable
 * string cannot be spent, cannot be noticed (the `allowance` read returns it
 * as though it were live), and is only cleared by approving to zero.
 */
export function assertSpenderShape(spender: string): void {
  const problem = spenderShapeProblem(spender);
  if (problem !== null) {
    throw new Error(
      `creator-tokens: refusing to grant an allowance that could never be spent — ${problem}`
    );
  }
}
