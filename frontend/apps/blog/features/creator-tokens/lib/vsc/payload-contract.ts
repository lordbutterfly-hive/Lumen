// Payload/parser contract for /mnt/o/CREATOR-TOKENS/contract/main.go — the
// safety net for the bug class fixed alongside this file (seam audit,
// 2026-07-20): main.go's flat-JSON reader has exactly two shapes,
//
//   jsonU64(payload, key)  main.go jsonU64 — bare, UNQUOTED decimal integer.
//                          Missing/malformed/negative silently reads as 0.
//   jsonStr(payload, key)  main.go jsonStr — a QUOTED JSON string. Anything
//                          else (absent key, unquoted value) silently reads
//                          back as "".
//
// Every money amount is read via jsonStr and then handed to parseBigDecimal
// (main.go parseBigDecimal: `new(big.Int).SetString(s, 10)`, `s == ""` and any sign
// or non-digit character rejected) — a *base-10 integer string*, never a
// bare JSON number and never a value with a decimal point. Get either of
// those two shapes wrong for any field below and the call INPUT-reverts
// (main.go handleErr handleErr -> sdk.Revert) every single time, at the cost of
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
// no exponent) or parseBigDecimal (main.go parseBigDecimal) rejects it even though
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
/**
 * ★★ CITATIONS ARE FUNCTION NAMES, NOT LINE NUMBERS (2026-08-31, found by
 * clauderfly-43). Every `main.go:NNN` in this file had drifted — face 512->657,
 * cap 517->662, ask.maxCredits 768->1175, buy.tokens 1010->1589. The drift was
 * NOT constant (+145 to +579), so they could not be bulk-corrected by an offset,
 * and a wrong pointer is worse than none: it is exactly what a future auditor
 * follows to re-verify a money path, and it would land them in an unrelated
 * function reading the wrong guard.
 *
 * Re-pinning the numbers would only reset the same clock — they drifted once and
 * would drift on the next contract edit. A FUNCTION NAME does not drift. Every
 * anchor below was checked to exist in the current `contract/main.go`; the TABLE
 * itself was already proven mechanically (43 diffed all 24 actions field-by-field
 * against main.go's three readers), so this changes documentation only.
 */
export const ACTION_PAYLOAD_SPECS: Record<string, ActionPayloadSpec> = {
  register: {
    face: 'number', // main.go jsonU64 i64FromU64(jsonU64(payload, "face"))
    cap: 'number', // main.go jsonU64 i64FromU64(jsonU64(payload, "cap"))
    // main.go jsonStr `if raw := jsonStr(payload, "firstBuy"); raw != ""` — the
    // OPTIONAL atomic creator first buy. Absent/0 == plain registration. When
    // present it executes an ORDINARY core.Buy at FULL curve cost plus the
    // full 10% trade fee in the same state transition: zero premine, no
    // discount. Structurally un-front-runnable, but NOT an anti-snipe device
    // (BasePrice does that work) — never describe it as one in the UI.
    firstBuy: { type: 'moneyString', optional: true }
  },
  renew: {
    creator: 'string', // main.go Renew
    periods: 'number', // main.go Renew
    paid: 'moneyString' // main.go Renew
  },
  setFace: {
    newFace: 'number' // main.go SetFace
  },
  setCap: {
    newCap: 'number' // main.go SetCap
  },
  // ---- the curve rails (WAVE D) ----
  buy: {
    creator: 'string', // main.go Buy
    // WHOLE TOKENS, not 3-decimal base units — see contract-math.ts's unit
    // note. Slippage is the buyer's OWN signed transfer.allow on the single
    // HiveDraw of TotalDue; there is deliberately no in-payload cost cap.
    tokens: 'moneyString' // main.go Buy
  },
  sell: {
    creator: 'string', // main.go Sell
    tokens: 'moneyString', // main.go Sell
    // main.go Sell — OPTIONAL signed floor on Net. Absent == NO guard (the
    // escape hatch that keeps an exit from ever being trapped); present but
    // malformed == a hard error, never a silent zero.
    minNet: { type: 'moneyString', optional: true }
  },
  ask: {
    creator: 'string', // main.go Ask
    contentHash: 'string', // main.go Ask
    deadlineBlocks: 'number', // main.go Ask
    maxCredits: 'moneyString', // main.go Ask — REQUIRED; core.Ask rejects nil/zero
    // main.go jsonU64Field jsonU64Field(payload, "offeringId") — the OFFERINGS SHOP.
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
    seq: 'number', // main.go Answer
    answerHash: 'string' // main.go Answer
  },
  reclaim: {
    creator: 'string', // main.go Reclaim
    seq: 'number' // main.go Reclaim
  },
  refund: {
    creator: 'string', // main.go Refund
    credits: 'moneyString', // main.go Refund
    minNet: { type: 'moneyString', optional: true } // main.go Refund
  },
  // ---- the offerings shop (creator-only; caller IS the creator on all five,
  // so no `creator` field on the four writes) ----
  createOffering: {
    title: 'string', // main.go jsonStr jsonStr(payload, "title")
    // UNQUOTED integer base units (jsonU64 -> i64FromU64), NOT a money string:
    // the shop entrypoints read prices with the loose number reader, unlike
    // ask/buy/sell which use parseBigDecimal. Sending "500" here would parse
    // as 0 and post a free service.
    price: 'number' // main.go CreateOffering
  },
  setOfferingPrice: {
    offeringId: 'number', // main.go jsonU64Field jsonU64Field — 0 is MEANINGFUL, never omit
    newPrice: 'number' // main.go SetOfferingPrice
  },
  setOfferingTitle: {
    offeringId: 'number', // main.go jsonU64Field jsonU64Field
    title: 'string' // main.go SetOfferingTitle
  },
  deleteOffering: {
    offeringId: 'number' // main.go jsonU64Field jsonU64Field
  },
  // The anti-grief rail (RULING E): the creator's free, honest "no" inside the
  // same window an Answer would be legal in. Full refund INCLUDING the
  // commission, and explicitly not a miss against the delivery record. Had no
  // client method at all until 2026-07-28.
  decline: {
    creator: 'string', // main.go Decline
    seq: 'number' // main.go jsonU64Field jsonU64Field — 0 is a real seq
  },
  // The buyer's rating of a delivered job. Reputation only — the contract
  // refuses to let it touch any fund path, and no client should imply it can.
  rate: {
    creator: 'string', // main.go (rate)
    seq: 'number', // jsonU64Field — 0 is a real seq
    score: 'number' // jsonU64Field — 1-5, bounded in core
  },
  refundHolder: {
    creator: 'string', // main.go RefundHolder
    holder: 'string' // main.go RefundHolder
  },
  // The wasm export is `transfer` (//go:wasmexport transfer) — NOT
  // `transferCredits`. Ten of eleven action names matched; this one did not,
  // so every transfer would have dispatched to an unknown action on-chain.
  transfer: {
    creator: 'string', // main.go Transfer
    to: 'string', // main.go Transfer
    amount: 'moneyString' // main.go Transfer
  },
  retire: {
    creator: 'string' // main.go Retire — creator-only, ONCE-ONLY, starts the 5-day notice
  },
  // No payload fields at all: the caller IS the beneficiary (core.ClaimTradeFees
  // zeroes kFeeBal(caller) and returns the debited amount to transfer back).
  claimTradeFees: {},
  closeIfDrained: {
    creator: 'string' // main.go CloseIfDrained
  },
  withdrawTreasury: {
    amount: 'moneyString' // main.go WithdrawTreasury — owner-gated inside core
  },
  pause: {},
  unpause: {}
};

/**
 * The escrow's two free-form commitment strings — `ask.contentHash` and
 * `answer.answerHash` — are the ONLY fields on this contract a user types
 * directly, and core/ask.go bounds them on three axes (Ask :336-343, Answer
 * :515-523):
 *
 *   - non-empty            -> "empty content hash" / "empty answer hash"
 *   - at most MaxHashLen   -> "contentHash too long" / "answerHash too long"
 *   - no "|" character     -> "... must not contain '|'"
 *
 * The pipe is not cosmetic: core/ask.go:157 packs the whole escrow record into
 * a single pipe-delimited string, so one stray "|" would re-partition the
 * record — which is exactly why the contract refuses it outright rather than
 * escaping it.
 *
 * ★ ADDED 2026-07-29. None of these three was enforced client-side. The answer
 * composer (ui/studio/creator-studio.tsx) is a free-text box whose own
 * placeholder invites "a link, a ticket number" — and a tracking URL longer
 * than 128 characters, or one carrying a "|" in a query parameter, is entirely
 * ordinary. A creator would type it, sign with their ACTIVE key, pay resource
 * credits, broadcast, and the escrow would simply not release: the on-chain
 * refusal arrives after the signature, not before it. Bounding it here means
 * the failure happens in the composer, where it costs nothing and says what to
 * change.
 *
 * MaxHashLen is mirrored from creator-tokens/core/params.go:171. The e2e
 * harness re-derives it from that file and fails if the two drift.
 */
export const MAX_HASH_LEN = 128;

/**
 * ★ ONE SOURCE FOR THE HASH RULES, because there were three and they disagreed.
 *
 * `assertHashField` (the op-builder's throw), the Answer dialog's `answerValid`
 * and vsc-data-source's inline pair were separate hand-written copies; none
 * checked control characters and all measured length in UTF-16 units where the
 * contract measures BYTES. A UI gate more permissive than the op builder is not
 * a gate — it lets someone press a live button and fail at signing, or on chain.
 *
 * TWO REGISTERS, deliberately (43's review, 2026-08-31):
 *   · `hashFieldProblem` returns what a PERSON should read. No field names, no
 *     file paths, no byte counts they did not ask for. It is rendered next to a
 *     textarea by someone who is trying to answer a customer.
 *   · `assertHashField` throws the DIAGNOSTIC — field name, rule, and the
 *     contract citation — because it lands in a log or a developer's console,
 *     where "this can't contain a line break" would be useless.
 * Same rules, one implementation; only the wording differs.
 *
 * The rules mirror core/ask.go:379-390 and :595-606 exactly, in their order:
 * non-empty, BYTE length <= MaxHashLen(128), no '|' (the escrow record is
 * pipe-packed), and validEventHash (core/ask.go:276-283) — no byte < 0x20 and
 * no 0x7f.
 */
type HashProblem = { human: string; diagnostic: string };

/** What a person calls the thing they just typed. */
const HASH_FIELD_NOUN: Record<'contentHash' | 'answerHash', string> = {
  contentHash: 'Your request',
  answerHash: 'Your answer'
};

function hashProblemOf(fieldName: 'contentHash' | 'answerHash', value: string): HashProblem | null {
  const noun = HASH_FIELD_NOUN[fieldName];
  if (value === '') {
    return {
      human: `${noun} can't be empty.`,
      diagnostic: `payload-contract: ${fieldName} is empty — the contract refuses an empty commitment string (core/ask.go).`
    };
  }
  // ★★ BYTES, NOT `value.length`. The contract's bound is `len(contentHash) >
  // MaxHashLen` and Go's len() counts BYTES, while String.length counts UTF-16
  // code units. They disagree in the DANGEROUS direction for non-ASCII: 100 CJK
  // characters are 100 units (client: fine) and 300 bytes (chain: refused, after
  // the user has signed and paid the RC). Emoji are worse.
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > MAX_HASH_LEN) {
    return {
      human: `${noun} is too long. Shorten it a little and it will send. (Accented and non-Latin characters count for more than one.)`,
      diagnostic: `payload-contract: ${fieldName} is ${bytes.length} bytes — the contract accepts at most ${MAX_HASH_LEN} (core/ask.go MaxHashLen, which counts BYTES not characters).`
    };
  }
  if (value.includes('|')) {
    return {
      human: `${noun} can't contain the "|" character. Remove it and it will send.`,
      diagnostic: `payload-contract: ${fieldName} contains a "|" — the escrow record is packed as a pipe-delimited string (core/ask.go:157).`
    };
  }
  // ★★ CONTROL CHARACTERS. core/ask.go validEventHash refuses ANY byte < 0x20
  // or == 0x7f, and no client copy checked them. The reachable case is not
  // exotic: the Answer dialog is a TEXTAREA, so one Enter puts a \n in the
  // string, which passed every client check and reverted on chain after signing.
  //
  // Byte-wise, mirroring the contract rather than approximating it with a
  // code-point test: every UTF-8 continuation byte is >= 0x80, so scanning bytes
  // cannot mistake a legitimate multi-byte character for a control byte.
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x20 || b === 0x7f) {
      const humanName = b === 0x0a || b === 0x0d ? 'line breaks' : b === 0x09 ? 'tabs' : 'invisible control characters';
      return {
        human: `${noun} can't contain ${humanName}. Put it on one line and it will send.`,
        diagnostic: `payload-contract: ${fieldName} contains a control character (0x${b.toString(16).padStart(2, '0')}) — the contract refuses any (core/ask.go validEventHash).`
      };
    }
  }
  return null;
}

/**
 * The sentence to show a PERSON, or null when the value is acceptable to the
 * contract. UI code gates on `hashFieldProblem(...) === null` rather than
 * re-implementing any of this.
 */
export function hashFieldProblem(fieldName: 'contentHash' | 'answerHash', value: string): string | null {
  return hashProblemOf(fieldName, value)?.human ?? null;
}

/** Throws the DIAGNOSTIC reason core/ask.go would have given, before anything is signed. */
export function assertHashField(fieldName: 'contentHash' | 'answerHash', value: string): void {
  const problem = hashProblemOf(fieldName, value);
  if (problem) throw new Error(problem.diagnostic);
}

/**
 * READ-ONLY preview entrypoints. Specced for the same drift protection, but
 * kept OUT of ACTION_PAYLOAD_SPECS because they are never broadcast as a
 * write — they carry no auth and mutate nothing. Listed here so a future
 * rename on the Go side still trips a checker if these are ever called
 * through a node that evaluates them.
 */
export const READ_PAYLOAD_SPECS: Record<string, ActionPayloadSpec> = {
  quote: {
    creator: 'string', // main.go Quote
    // Same convention and the same reason as `ask` above: a quote MUST preview
    // the price the ask will actually charge, so it takes the same optional
    // offeringId and refuses a malformed one rather than pricing the legacy
    // face. A preview that disagrees with the charge is worse than no preview.
    offeringId: { type: 'number', optional: true }
  },
  quoteBuy: {
    creator: 'string', // main.go QuoteBuy
    tokens: 'moneyString' // main.go QuoteBuy
  },
  quoteSell: {
    creator: 'string', // main.go QuoteSell
    // The exit tax is the HOLDER's own hold clock, so the holder to preview
    // is a PAYLOAD field — that is what keeps this a pure, caller-independent
    // read. The real `sell` still requires that holder's own active auth.
    holder: 'string', // main.go QuoteSell
    tokens: 'moneyString' // main.go QuoteSell
  },
  // Pure read, no auth, no mutation: returns the creator's whole posted
  // catalogue as {creator, offerings:[{offeringId,title,price}]}.
  listOfferings: { creator: 'string' } // main.go ListOfferings
};

// parseBigDecimal (main.go parseBigDecimal) is `new(big.Int).SetString(s, 10)` then
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
        problems.push(`"${key}" = ${JSON.stringify(value)} is not a bare non-negative base-10 integer string — parseBigDecimal (main.go parseBigDecimal) would reject it (no sign, no decimal point, no exponent allowed)`);
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
// RE-VERIFIED 2026-07-29 by walking every //go:wasmexport in main.go at the
// current commit: main.go declares 29 entrypoints, and 25 of them call
// requireActiveAuth(currentCaller()) — including the curve rails, and
// including the ones that look permissionless in core (closeIfDrained,
// refundHolder). The four that do NOT are all genuine pure reads: `quote`
// (main.go ListOfferings), `quoteBuy` (:1628), `quoteSell` (:1662), `listOfferings`
// (:1861) — they are specced in READ_PAYLOAD_SPECS below and are never
// broadcast. Of the 25 gated entrypoints, 24 are client-reachable; the 25th
// is `init` (main.go ListOfferings), which only the deployer calls. There is no write
// on this contract that a posting key may sign. `prepay` is gone
// (core/prepay.go deleted).
//
// ★ FIXED 2026-07-29 — THIS LIST WAS A HAND-MAINTAINED COPY AND IT HAD GONE
// STALE. It enumerated 18 actions while ACTION_PAYLOAD_SPECS above (and the
// data source's 22 write methods) covered 24. The six it had silently stopped
// covering were `decline`, `rate`, `createOffering`, `setOfferingPrice`,
// `setOfferingTitle` and `deleteOffering` — every one of them added after the
// list was written, and every one of them gated on requireActiveAuth on
// chain. Because assertAuthContract's first line is
// `if (!WRITE_ACTIONS_REQUIRING_ACTIVE_AUTH.includes(action)) return;`, the
// tripwire was returning CLEAN for all six: had a future edit to buildOp()
// re-introduced a posting-auth path, this check — the one guard whose entire
// job is to notice that — would have said nothing for the offerings shop, the
// anti-grief decline rail, and the ratings rail. That is the exact failure
// mode a hand-copied list has, so the list is no longer hand-copied: it is
// DERIVED from ACTION_PAYLOAD_SPECS, which is itself the ground truth every
// payload is already validated against. A new write action cannot be added to
// this feature without landing in that table, so it cannot be added without
// being covered here.
//
// The one thing derivation cannot prove is that ACTION_PAYLOAD_SPECS still
// matches main.go. That is checked separately and against the contract's own
// source, by the auth-tier section of
// ./__e2e__/vsc-data-path.e2e.ts (which reads contract/main.go and derives
// the gated set from the //go:wasmexport directives) and by
// contract/parse/auth_tier_crosscheck_test.go on the Go side.
export const WRITE_ACTIONS_REQUIRING_ACTIVE_AUTH: readonly string[] = Object.keys(ACTION_PAYLOAD_SPECS);

/**
 * Throws if a write action's built CustomJsonOp does not carry active
 * authority alone (a non-empty `requiredAuths`, with `requiredPostingAuths`
 * left empty). Always active — op-builders.ts's buildOp() calls this in
 * development the same way it already calls assertPayloadShape, so this is
 * live proof against whatever auth arrays a real write actually built, not
 * a synthetic sample.
 */
export function assertAuthContract(action: string, requiredAuths: string[], requiredPostingAuths: string[]): void {
  // An UNKNOWN action is a hard error, not a quiet pass. This used to `return`
  // — which is how the six actions missing from the old hand-written list
  // (decline, rate and the four shop writes) were skipped in silence. Every
  // caller of this function is building a WRITE that is about to be signed, so
  // "I have never heard of this action" is precisely when it must refuse.
  // buildOp() now calls this in production too, where assertPayloadShape's own
  // unknown-action check is switched off, so this is also the only guard that
  // catches a typo'd action name on a real money path.
  if (!WRITE_ACTIONS_REQUIRING_ACTIVE_AUTH.includes(action)) {
    throw new Error(
      `payload-contract auth violation: unknown creator-tokens write action "${action}" — it is not in ACTION_PAYLOAD_SPECS, so the auth tier it needs cannot be established. Add it there (citing its //go:wasmexport line in contract/main.go) before wiring a new write.`
    );
  }
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
