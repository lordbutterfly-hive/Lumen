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

/**
 * A field the wrapper reads only when present. main.go gates these on a
 * non-empty read (`if raw := jsonStr(payload, "minNet"); raw != ""`), so
 * OMITTING the key is legal and meaningful — for minNet it opts out of the
 * slippage guard entirely, for firstBuy it means "plain registration". A
 * present-but-malformed value is still an ERROR on the contract side, never
 * silently dropped, so when the key IS sent it must satisfy its type.
 *
 * Never send an optional key with an empty string to mean "absent": for
 * `minNet` that is indistinguishable from absent to the wrapper, but for the
 * money fields the checker below would reject it, which is the safer failure.
 */
export interface OptionalFieldSpec {
  type: JsonFieldType;
  optional: true;
}

export type ActionPayloadSpec = Record<string, JsonFieldType | OptionalFieldSpec>;

function fieldType(spec: JsonFieldType | OptionalFieldSpec): JsonFieldType {
  return typeof spec === 'string' ? spec : spec.type;
}

function isOptional(spec: JsonFieldType | OptionalFieldSpec): boolean {
  return typeof spec !== 'string' && spec.optional === true;
}

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
// ★ RE-VERIFIED LINE-BY-LINE AGAINST main.go 2026-07-24, after the bonding-
// curve pivot. THREE ENTRIES WERE STALE AND WOULD HAVE REVERTED ON EVERY
// CALL:
//   - `register` carried `feePaid`. Registration is FREE now (core/launch.go
//     deleted the fee); main.go's register never reads that key, and it
//     gained an OPTIONAL `firstBuy` instead.
//   - `prepay` no longer exists at all — core/prepay.go was DELETED by the
//     pivot. Its replacement is `buy` (the curve), not a renamed prepay.
//   - `ask` carried `commissionHbdPaid`. main.go's ask no longer reads it:
//     the wrapper computes the exact commission itself via
//     core.CommissionOwedFor, because core.Ask requires it to match EXACTLY
//     (the H2 fix) and any client-side copy could only ever drift into
//     bricking every ask.
// Ten curve/lifecycle entrypoints (buy/sell/retire/claimTradeFees/
// closeIfDrained/withdrawTreasury/pause/unpause + the read-only quoteBuy/
// quoteSell) had NO spec at all.
export const ACTION_PAYLOAD_SPECS: Record<string, ActionPayloadSpec> = {
  register: {
    face: 'number', // main.go:512 i64FromU64(jsonU64(payload, "face"))
    cap: 'number', // main.go:517 i64FromU64(jsonU64(payload, "cap"))
    // main.go:527 `if raw := jsonStr(payload, "firstBuy"); raw != ""` — the
    // OPTIONAL atomic creator first buy. Absent/0 == plain registration. When
    // present it executes an ORDINARY core.Buy at FULL curve cost plus the
    // full 10% trade fee in the same state transition: zero premine, no
    // discount. Structurally un-front-runnable, but NOT an anti-snipe device
    // (BasePrice does that work) — never describe it as one in the UI.
    firstBuy: { type: 'moneyString', optional: true }
  },
  renew: {
    creator: 'string', // main.go:573
    periods: 'number', // main.go:574
    paid: 'moneyString' // main.go:575
  },
  setFace: {
    newFace: 'number' // main.go:605
  },
  setCap: {
    newCap: 'number' // main.go:632
  },
  // ---- the curve rails (WAVE D) ----
  buy: {
    creator: 'string', // main.go:1009
    // WHOLE TOKENS, not 3-decimal base units — see contract-math.ts's unit
    // note. Slippage is the buyer's OWN signed transfer.allow on the single
    // HiveDraw of TotalDue; there is deliberately no in-payload cost cap.
    tokens: 'moneyString' // main.go:1010
  },
  sell: {
    creator: 'string', // main.go:1054
    tokens: 'moneyString', // main.go:1055
    // main.go:1062 — OPTIONAL signed floor on Net. Absent == NO guard (the
    // escape hatch that keeps an exit from ever being trapped); present but
    // malformed == a hard error, never a silent zero.
    minNet: { type: 'moneyString', optional: true }
  },
  ask: {
    creator: 'string', // main.go:765
    contentHash: 'string', // main.go:766
    deadlineBlocks: 'number', // main.go:767
    maxCredits: 'moneyString', // main.go:768 — REQUIRED; core.Ask rejects nil/zero
    // main.go:830 jsonU64Field(payload, "offeringId") — the OFFERINGS SHOP.
    // ABSENT means 0, which is the reserved alias for the creator's legacy
    // single `face` price, so leaving it off keeps the pre-shop behaviour
    // exactly. A NONZERO id names one of the creator's posted services and
    // prices the ask at THAT offering's own banded price.
    //
    // It is an UNQUOTED integer (parse.U64Field), NOT a money string: the
    // contract reads it with the same loose-number reader `deadlineBlocks`
    // uses. Present-but-unparseable is REFUSED on-chain rather than defaulted,
    // because a silent fall back to 0 would settle against the wrong, cheaper
    // service and underpay the creator.
    //
    // Until 2026-07-28 this field did not exist in this client AT ALL, which
    // meant the entire offerings shop — on-chain, tested, five entrypoints —
    // was unreachable from any UI. That was the single sharpest gap in the
    // 2026-07-28 gap list.
    offeringId: { type: 'number', optional: true }
  },
  answer: {
    seq: 'number', // main.go:820
    answerHash: 'string' // main.go:821
  },
  reclaim: {
    creator: 'string', // main.go:876
    seq: 'number' // main.go:877
  },
  refund: {
    creator: 'string', // main.go:938
    credits: 'moneyString', // main.go:939
    minNet: { type: 'moneyString', optional: true } // main.go:966
  },
  // ---- the offerings shop (creator-only; caller IS the creator on all five,
  // so no `creator` field on the four writes) ----
  createOffering: {
    title: 'string', // main.go:1683 jsonStr(payload, "title")
    // UNQUOTED integer base units (jsonU64 -> i64FromU64), NOT a money string:
    // the shop entrypoints read prices with the loose number reader, unlike
    // ask/buy/sell which use parseBigDecimal. Sending "500" here would parse
    // as 0 and post a free service.
    price: 'number' // main.go:1684
  },
  setOfferingPrice: {
    offeringId: 'number', // main.go:1721 jsonU64Field — 0 is MEANINGFUL, never omit
    newPrice: 'number' // main.go:1726
  },
  setOfferingTitle: {
    offeringId: 'number', // main.go:1815 jsonU64Field
    title: 'string' // main.go:1820
  },
  deleteOffering: {
    offeringId: 'number' // main.go:1806 jsonU64Field
  },
  // The anti-grief rail (RULING E): the creator's free, honest "no" inside the
  // same window an Answer would be legal in. Full refund INCLUDING the
  // commission, and explicitly not a miss against the delivery record. Had no
  // client method at all until 2026-07-28.
  decline: {
    creator: 'string', // main.go:958
    seq: 'number' // main.go:963 jsonU64Field — 0 is a real seq
  },
  // The buyer's rating of a delivered job. Reputation only — the contract
  // refuses to let it touch any fund path, and no client should imply it can.
  rate: {
    creator: 'string', // main.go (rate)
    seq: 'number', // jsonU64Field — 0 is a real seq
    score: 'number' // jsonU64Field — 1-5, bounded in core
  },
  refundHolder: {
    creator: 'string', // main.go:1117
    holder: 'string' // main.go:1118
  },
  // The wasm export is `transfer` (//go:wasmexport transfer) — NOT
  // `transferCredits`. Ten of eleven action names matched; this one did not,
  // so every transfer would have dispatched to an unknown action on-chain.
  transfer: {
    creator: 'string', // main.go:675
    to: 'string', // main.go:676
    amount: 'moneyString' // main.go:688
  },
  retire: {
    creator: 'string' // main.go:1313 — creator-only, ONCE-ONLY, starts the 5-day notice
  },
  // No payload fields at all: the caller IS the beneficiary (core.ClaimTradeFees
  // zeroes kFeeBal(caller) and returns the debited amount to transfer back).
  claimTradeFees: {},
  closeIfDrained: {
    creator: 'string' // main.go:1167
  },
  withdrawTreasury: {
    amount: 'moneyString' // main.go:1220 — owner-gated inside core
  },
  pause: {},
  unpause: {}
};

/**
 * READ-ONLY preview entrypoints. Specced for the same drift protection, but
 * kept OUT of ACTION_PAYLOAD_SPECS because they are never broadcast as a
 * write — they carry no auth and mutate nothing. Listed here so a future
 * rename on the Go side still trips a checker if these are ever called
 * through a node that evaluates them.
 */
export const READ_PAYLOAD_SPECS: Record<string, ActionPayloadSpec> = {
  quote: {
    creator: 'string', // main.go:1351
    // Same convention and the same reason as `ask` above: a quote MUST preview
    // the price the ask will actually charge, so it takes the same optional
    // offeringId and refuses a malformed one rather than pricing the legacy
    // face. A preview that disagrees with the charge is worse than no preview.
    offeringId: { type: 'number', optional: true }
  },
  quoteBuy: {
    creator: 'string', // main.go:1398
    tokens: 'moneyString' // main.go:1399
  },
  quoteSell: {
    creator: 'string', // main.go:1432
    // The exit tax is the HOLDER's own hold clock, so the holder to preview
    // is a PAYLOAD field — that is what keeps this a pure, caller-independent
    // read. The real `sell` still requires that holder's own active auth.
    holder: 'string', // main.go:1433
    tokens: 'moneyString' // main.go:1434
  },
  // Pure read, no auth, no mutation: returns the creator's whole posted
  // catalogue as {creator, offerings:[{offeringId,title,price}]}.
  listOfferings: { creator: 'string' } // main.go:1826
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
    if (!(key in payload) && !isOptional(spec[key])) problems.push(`missing key "${key}"`);
  }
  for (const key of actualKeys) {
    if (!(key in spec)) problems.push(`unexpected key "${key}" (main.go's ${action} entrypoint never reads it — see the payload doc comment above ${action}'s wasmexport in main.go)`);
  }
  for (const key of expectedKeys) {
    if (!(key in payload)) continue;
    const value = payload[key];
    // An optional key that IS present must still satisfy its type: main.go
    // treats a present-but-malformed optional as a hard error, never as
    // absent. `undefined` is the one thing callers must not send — it
    // serialises away entirely, so reject it here rather than let it look
    // like a deliberate omission.
    if (value === undefined) {
      problems.push(`"${key}" is present but undefined — omit the key entirely to mean "absent", never send undefined`);
      continue;
    }
    const kind = fieldType(spec[key]);
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
// VERIFIED 2026-07-24 by walking every //go:wasmexport in main.go: ALL 18
// write entrypoints call requireActiveAuth(currentCaller()) — including the
// curve rails, and including the ones that look permissionless in core
// (closeIfDrained, refundHolder). There is no write on this contract that a
// posting key may sign. `prepay` is gone (core/prepay.go deleted).
export const WRITE_ACTIONS_REQUIRING_ACTIVE_AUTH: readonly string[] = [
  'register',
  'renew',
  'setFace',
  'setCap',
  'buy',
  'sell',
  'ask',
  'answer',
  'reclaim',
  'refund',
  'refundHolder',
  'transfer',
  'retire',
  'claimTradeFees',
  'closeIfDrained',
  'withdrawTreasury',
  'pause',
  'unpause'
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
