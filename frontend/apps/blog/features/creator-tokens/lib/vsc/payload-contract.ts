// Payload/parser contract for /mnt/o/CREATOR-TOKENS/contract/main.go — the
// safety net for the bug class fixed alongside this file (seam audit,
// 2026-07-20): main.go's flat-JSON reader has exactly two shapes,
//
//   jsonU64(payload, key)  main.go:239-264 — bare, UNQUOTED decimal integer.
//                          Missing/malformed/negative silently reads as 0.
//   jsonStr(payload, key)  main.go:211-237 — a QUOTED JSON string. Anything
//                          else (absent key, unquoted value) silently reads
//                          back as "".
//
// Every money amount is read via jsonStr and then handed to parseBigDecimal
// (main.go:266-281: `new(big.Int).SetString(s, 10)`, `s == ""` and any sign
// or non-digit character rejected) — a *base-10 integer string*, never a
// bare JSON number and never a value with a decimal point. Get either of
// those two shapes wrong for any field below and the call INPUT-reverts
// (main.go:99-105 handleErr -> sdk.Revert) every single time, at the cost of
// the caller's RC, with zero on-chain trace of what the payload even looked
// like.
//
// THIS FILE is that constraint, restated as data + a runtime checker, so a
// future rename on either side (a TS field renamed to no longer match the
// jsonStr/jsonU64 key main.go reads, or a money field's quoting/format
// regressing) fails LOUD in development instead of failing SILENT on-chain.
// See op-builders.ts's buildOp() for where this is actually wired in (every
// write action funnels through buildOp, so this is the one choke point that
// needs the call), and creator-tokens/README (n/a — see the report) for why
// this is a plain checker + dev-mode call rather than a `*.test.ts` file:
// apps/blog has no unit test runner wired (no jest/vitest config or
// devDependency anywhere in this repo; the only *.test.ts files that exist
// live under packages/ui and packages/renderer, and even packages/ui's have
// no runner/script attached to actually execute them — packages/renderer's
// mocha suite is the only unit runner wired into CI, scoped to that package
// only). apps/blog's own test tooling is exclusively Playwright E2E
// (apps/blog/playwright/**), which needs a running server/browser and is the
// wrong shape for a static payload-format assertion. Per the task brief's
// own fallback for "genuinely no runner": a plain exported checker the data
// source calls in development.

export type JsonFieldType =
  | 'number' // jsonU64: bare, unquoted JSON integer -> JS `number`.
  | 'string' // jsonStr: quoted JSON string -> JS `string`, any content.
  | 'moneyString'; // jsonStr -> parseBigDecimal: quoted JSON string that must
// ALSO be a bare non-negative base-10 integer (no sign, no decimal point,
// no exponent) or parseBigDecimal (main.go:272-281) rejects it even though
// the JSON *type* was correct — the exact near-miss this feature's `refund`/
// `transferCredits` fix could have regressed into if `.toFixed(3)` or a
// human-decimal string had been used instead of a base-unit integer string.

export type ActionPayloadSpec = Record<string, JsonFieldType>;

// ── Ground truth. One entry per wasmexport entrypoint in main.go that a
// write action in this feature calls. Every field cites the exact main.go
// line that reads it — if that line ever moves or the field name there ever
// changes, this comment (and, via assertPayloadShape below, a thrown error)
// is the tripwire. `creator` is deliberately ABSENT from register/setFace/
// setCap/answer: main.go never reads it for those four (caller is always
// used instead — see main.go's own file-level comment and each entrypoint's
// doc), so a payload that still sent it would be harmless but is no longer
// "exactly what the wrapper parses" — this spec (and the builders in
// op-builders.ts) intentionally omit it. ──
export const ACTION_PAYLOAD_SPECS: Record<string, ActionPayloadSpec> = {
  register: {
    face: 'number', // main.go:426 jsonU64(payload, "face")
    cap: 'number', // main.go:431 jsonU64(payload, "cap")
    feePaid: 'moneyString' // main.go:436 parseBigDecimal(jsonStr(payload, "feePaid"))
  },
  renew: {
    creator: 'string', // main.go:464 jsonStr(payload, "creator")
    periods: 'number', // main.go:465 jsonU64(payload, "periods")
    paid: 'moneyString' // main.go:466 parseBigDecimal(jsonStr(payload, "paid"))
  },
  setFace: {
    newFace: 'number' // main.go:492 jsonU64(payload, "newFace")
  },
  setCap: {
    newCap: 'number' // main.go:515 jsonU64(payload, "newCap")
  },
  prepay: {
    creator: 'string', // main.go:542 jsonStr(payload, "creator")
    hbdPaid: 'moneyString' // main.go:543 parseBigDecimal(jsonStr(payload, "hbdPaid"))
  },
  ask: {
    creator: 'string', // main.go:613 jsonStr(payload, "creator")
    contentHash: 'string', // main.go:614 jsonStr(payload, "contentHash")
    deadlineBlocks: 'number', // main.go:615 jsonU64(payload, "deadlineBlocks")
    commissionHbdPaid: 'moneyString', // parseBigDecimal(jsonStr(payload, "commissionHbdPaid"))
    maxCredits: 'moneyString' // REQUIRED: parseBigDecimal(jsonStr(payload, "maxCredits")); core.Ask rejects nil/zero
  },
  answer: {
    seq: 'number', // main.go:651 jsonU64(payload, "seq")
    answerHash: 'string' // main.go:652 jsonStr(payload, "answerHash")
  },
  reclaim: {
    creator: 'string', // main.go:678 jsonStr(payload, "creator")
    seq: 'number' // main.go:679 jsonU64(payload, "seq")
  },
  refund: {
    creator: 'string', // main.go:706 jsonStr(payload, "creator")
    credits: 'moneyString' // main.go:707 parseBigDecimal(jsonStr(payload, "credits"))
  },
  refundHolder: {
    creator: 'string', // main.go:743 jsonStr(payload, "creator")
    holder: 'string' // main.go:744 jsonStr(payload, "holder")
  },
  // The wasm export is `transfer` (//go:wasmexport transfer) — NOT
  // `transferCredits`. Ten of eleven action names matched; this one did not,
  // so every transfer would have dispatched to an unknown action on-chain.
  transfer: {
    creator: 'string', // main.go:573 jsonStr(payload, "creator")
    to: 'string', // main.go:574 jsonStr(payload, "to")
    amount: 'moneyString' // main.go:575 parseBigDecimal(jsonStr(payload, "amount"))
  }
};

// parseBigDecimal (main.go:272-281) is `new(big.Int).SetString(s, 10)` then
// a `Sign() < 0` rejection — in practice, for every field this feature ever
// sends, the only shapes that can ever legitimately reach the wire are bare
// non-negative digit strings (base units are always non-negative integers
// here; see contract-math.ts's humanToBaseUnits). A leading '+', a decimal
// point, scientific notation, or any non-digit character is exactly the
// class of "technically a string, still reverts" regression this exists to
// catch, so the check is intentionally stricter than SetString's own grammar.
const MONEY_STRING_RE = /^[0-9]+$/;

/**
 * Throws a single, itemised Error if `payload` does not EXACTLY match
 * `action`'s entry in ACTION_PAYLOAD_SPECS: every expected key present, no
 * extra keys, and every value's JS type (plus, for money fields, its digit
 * shape) matching what main.go's jsonU64/jsonStr/parseBigDecimal would
 * actually accept. Always active — callers decide whether to gate this on
 * NODE_ENV (see op-builders.ts's buildOp()).
 */
export function assertPayloadShape(action: string, payload: Record<string, unknown>): void {
  const spec = ACTION_PAYLOAD_SPECS[action];
  if (!spec) {
    throw new Error(
      `payload-contract: no spec registered for action "${action}" in ACTION_PAYLOAD_SPECS (payload-contract.ts) — add one, citing the exact main.go jsonStr/jsonU64 line it must match, before wiring a new write action.`
    );
  }

  const problems: string[] = [];
  const expectedKeys = Object.keys(spec);
  const actualKeys = Object.keys(payload);

  for (const key of expectedKeys) {
    if (!(key in payload)) problems.push(`missing key "${key}"`);
  }
  for (const key of actualKeys) {
    if (!(key in spec)) problems.push(`unexpected key "${key}" (main.go's ${action} entrypoint never reads it — see the payload doc comment above ${action}'s wasmexport in main.go)`);
  }
  for (const key of expectedKeys) {
    if (!(key in payload)) continue;
    const value = payload[key];
    const kind = spec[key];
    if (kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push(`"${key}" must be a bare JSON number (main.go reads it via jsonU64, an UNQUOTED integer) — got ${typeof value} (${JSON.stringify(value)})`);
      }
    } else if (kind === 'string') {
      if (typeof value !== 'string') {
        problems.push(`"${key}" must be a JSON string (main.go reads it via jsonStr, which requires a QUOTED value or silently reads "") — got ${typeof value} (${JSON.stringify(value)})`);
      }
    } else {
      // moneyString
      if (typeof value !== 'string') {
        problems.push(`"${key}" must be a quoted decimal string (main.go reads it via jsonStr then parseBigDecimal) — got ${typeof value} (${JSON.stringify(value)}); an unquoted number here is the exact bug this checker exists to catch`);
      } else if (!MONEY_STRING_RE.test(value)) {
        problems.push(`"${key}" = ${JSON.stringify(value)} is not a bare non-negative base-10 integer string — parseBigDecimal (main.go:272) would reject it (no sign, no decimal point, no exponent allowed)`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`payload-contract violation for creator-tokens action "${action}": ${problems.join('; ')}`);
  }
}

// ── Auth contract (finding C1 — posting-key-theft fix) ──
//
// A Hive POSTING key is the low-trust key routinely delegated to any dApp,
// including this frontend. The contract requires ACTIVE authority on every
// one of its 11 write entrypoints, so a posting-signed transfer/refund/
// reclaim/setFace/setCap/answer/refundHolder would let anyone holding only a
// posting key (this app, a compromised dApp, a phished posting-key grant)
// drain a holder's credits or a creator's funds. op-builders.ts's buildOp()
// no longer even accepts a `postingAuth` parameter for a write to fall back
// to (see that file's own AUTH comment) — this is the belt-and-suspenders
// runtime tripwire for the ONE way that guarantee could still regress: a
// future edit to buildOp() itself (e.g. someone re-adding an optional
// posting-auth parameter "just for one case") without updating this list.
export const WRITE_ACTIONS_REQUIRING_ACTIVE_AUTH: readonly string[] = [
  'register',
  'renew',
  'setFace',
  'setCap',
  'prepay',
  'ask',
  'answer',
  'reclaim',
  'refund',
  'refundHolder',
  'transfer'
];

/**
 * Throws if a write action's built CustomJsonOp does not carry active
 * authority alone (a non-empty `requiredAuths`, with `requiredPostingAuths`
 * left empty). Always active — op-builders.ts's buildOp() calls this in
 * development the same way it already calls assertPayloadShape, so this is
 * live proof against whatever auth arrays a real write actually built, not
 * a synthetic sample.
 */
export function assertAuthContract(action: string, requiredAuths: string[], requiredPostingAuths: string[]): void {
  if (!WRITE_ACTIONS_REQUIRING_ACTIVE_AUTH.includes(action)) return;
  const problems: string[] = [];
  if (requiredAuths.length === 0) {
    problems.push(
      `action "${action}" must carry active authority (required_auths) — it moves value or mutates state the contract now refuses to accept from a posting-only key`
    );
  }
  if (requiredPostingAuths.length > 0) {
    problems.push(
      `action "${action}" must NOT carry posting authority (required_posting_auths) — active auth alone is what the contract requires; a posting entry here is exactly the low-trust-key theft surface this check exists to close`
    );
  }
  if (problems.length > 0) {
    throw new Error(`payload-contract auth violation for creator-tokens action "${action}": ${problems.join('; ')}`);
  }
}
