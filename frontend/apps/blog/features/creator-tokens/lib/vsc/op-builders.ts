// custom_json op construction. Same envelope as
// prediction-market/lib/op-builders.ts (id "vsc.call",
// { net_id, contract_id, action, payload, rc_limit, intents }) —
// WIRING-VERIFY (deploy): unverified against a live node, same as that file's
// own admission.
//
// AUTH (finding C1, posting-key-theft fix): the contract requires ACTIVE
// authority on every one of its 24 client-reachable write entrypoints, full
// stop (25 counting `init`, which only the deployer calls) — a Hive
// POSTING key is the low-value key delegated to every dApp including this
// frontend, and a posting-signed transfer/refund/reclaim/setFace/setCap/
// answer/refundHolder would let anyone holding only that key (this app, a
// compromised dApp, a phished posting-key grant) drain a holder's credits or
// a creator's funds. `activeAuth` below is therefore REQUIRED, not optional
// — there is deliberately no `postingAuth` parameter for a write to fall
// back to; a caller cannot even accidentally construct a posting-signed
// write, because the type signature no longer offers that option. (An
// EARLIER version of this file split by whether an action drew HBD
// — prepay/ask/register/renew got active auth, the other seven got posting
// — which was wrong: HBD-drawing is irrelevant to what authority level a
// STATE-MUTATING call needs, and every one of those seven state mutations
// (moving credits, changing a price, resolving an escrow) is exactly the
// kind of action a posting key must never be able to authorize alone.)
//
// Every `payload` object below is built by the pure functions further down
// this file (registerPayload, renewPayload, ...) — one per main.go
// entrypoint, each producing EXACTLY the key set/JSON shape
// ./payload-contract.ts's ACTION_PAYLOAD_SPECS says main.go's jsonU64/jsonStr
// reader expects (money amounts as QUOTED base-10 integer strings, never a
// bare JS number — see payload-contract.ts's file doc for the bug class this
// fixes). buildOp() itself re-checks every payload against that same spec in
// development (assertPayloadShape), and re-checks the auth shape above on
// EVERY build including production (assertAuthContract) — so vsc-data-source.ts's
// 22 write methods don't each need their own guard; this is the one choke
// point every one of them already funnels through. The signing side of the
// same guarantee (that the signature is actually made with the ACTIVE key,
// which the envelope alone cannot state) lives one layer out, in
// ./broadcaster.ts.

import { assertAuthContract, assertHashField, assertPayloadShape } from './payload-contract';

export interface CustomJsonOp {
  id: string;
  json: string;
  required_auths: string[];
  required_posting_auths: string[];
}

export const VSC_CALL_ID = 'vsc.call';

/**
 * rc_limit on Magi is denominated in the caller's own HBD: RC is a 5-day
 * rolling allowance SIZED by HBD held (read, never debited), so a high
 * rc_limit is not free headroom — it demands the caller keep that much HBD
 * idle, and a maximal spend can close their own exit for up to five days.
 *
 * 30_000 (= 30 HBD idle) was a placeholder copied in before anyone had
 * measured a real call, and it is far too high for these ops: every write here
 * is a small state transition, not a proof verification. 1_000 is the working
 * default until a devnet call reports real gas_used; override via
 * REACT_APP_CREATOR_TOKENS_RC_LIMIT rather than editing this.
 *
 * WIRING-VERIFY (deploy): still unmeasured against a live node.
 */
export const DEFAULT_RC_LIMIT = 1_000;

export function buildOp(opts: {
  netId: string;
  contractId: string;
  action: string;
  payload: Record<string, unknown>;
  hbdLegBaseUnits?: number;
  /** The Hive ACTIVE-authority account signing this write (required_auths). Required — see the file-level AUTH comment: every one of the 24 write actions needs active authority, never posting. A blank value is refused rather than silently producing an unsigned op. */
  activeAuth: string;
  rcLimit?: number;
}): CustomJsonOp {
  // Dev-mode-only (see payload-contract.ts's file doc for why this is a
  // runtime checker and not a *.test.ts file): every real write call from
  // vsc-data-source.ts funnels through here, so this is live proof — not a
  // synthetic sample — that whatever payload/auth a write method actually
  // built for a real user input still matches main.go byte-for-byte and the
  // active-auth-only contract (C1).
  if (process.env.NODE_ENV !== 'production') {
    assertPayloadShape(opts.action, opts.payload);
  }
  const intents = opts.hbdLegBaseUnits
    ? [{ type: 'transfer.allow', args: { limit: (opts.hbdLegBaseUnits / 1000).toFixed(3), token: 'hbd', decimals: '3' } }]
    : [];
  const body = {
    net_id: opts.netId,
    contract_id: opts.contractId,
    action: opts.action,
    payload: opts.payload,
    rc_limit: opts.rcLimit ?? DEFAULT_RC_LIMIT,
    intents
  };
  // ★ 2026-07-29: `opts.activeAuth ? [...] : []` used to fail OPEN. `activeAuth`
  // is typed as a required string, but TypeScript cannot stop `''` or a
  // whitespace-only name arriving from a caller that read it out of a session
  // object — and an empty/blank value silently produced `required_auths: []`,
  // i.e. an op with NO authority at all. The chain refuses that
  // (contract/main.go:206-212 requireActiveAuth), so it was never a theft
  // vector, but "money write, silently unsigned by anyone" must not be a shape
  // this function is able to return. It now throws where the stack trace still
  // names the write method that lost the signer.
  const activeAuth = typeof opts.activeAuth === 'string' ? opts.activeAuth.trim() : '';
  if (activeAuth === '') {
    throw new Error(
      `op-builders: action "${opts.action}" was built with no active-auth signer — every creator-tokens write must name the Hive account whose ACTIVE authority signs it (required_auths). Refusing to build an op that carries no authority.`
    );
  }
  const requiredAuths = [activeAuth];
  const requiredPostingAuths: string[] = [];
  // ALWAYS, including production. This is two array-length checks plus a set
  // lookup on a path that is already about to do a network round trip and a
  // wallet prompt — the cost is nil, and it is the last programmatic statement
  // of "a posting key may never authorize this" before the op leaves the
  // module. It was previously dev-only, which meant the only build that
  // handles real HBD was the one build running without it. (assertPayloadShape
  // stays dev-only: it walks every field of every payload and its failure mode
  // — a malformed field — is caught again by the contract's own parser, which
  // an auth-tier mistake is not.)
  assertAuthContract(opts.action, requiredAuths, requiredPostingAuths);
  return {
    id: VSC_CALL_ID,
    json: JSON.stringify(body),
    required_auths: requiredAuths,
    required_posting_auths: requiredPostingAuths
  };
}

// ===================================
// Per-action payload builders — pure, no network. Each returns EXACTLY the
// object ACTION_PAYLOAD_SPECS declares for that action; vsc-data-source.ts's
// write methods call these instead of hand-building payload literals, and
// payload-contract.selftest.ts (the "test file" for this feature — see that
// file's own doc for why it lives there) calls them too, so both the real
// write path and the safety net exercise the SAME code, never a hand-copied
// duplicate that could quietly drift from it. Callers pass amounts already
// converted to base units (contract-math.ts's humanToBaseUnits) — these
// functions only handle wire shape (which fields, quoted or bare), never
// money math.
//
// `creator` is omitted from registerPayload/setFacePayload/setCapPayload/
// answerPayload because main.go never reads it for those four entrypoints
// (caller is always used instead — see each entrypoint's own doc comment in
// main.go and payload-contract.ts's spec doc).

/**
 * main.go Register (main.go:502-560). REGISTRATION IS FREE — the `feePaid`
 * field this used to send is DELETED on the contract side, and sending it now
 * trips the unread-key check. `firstBuyTokens` is the OPTIONAL atomic creator
 * first buy: omit it (or pass 0) for a plain registration.
 */
export function registerPayload(faceBaseUnits: number, capTokens: number, firstBuyTokens = 0): Record<string, unknown> {
  const payload: Record<string, unknown> = { face: faceBaseUnits, cap: capTokens };
  // Omit the KEY entirely when there is no first buy — main.go gates on
  // `raw != ""`, and an explicit "0" would take the buy branch for zero
  // tokens rather than the plain-registration branch.
  if (firstBuyTokens > 0) payload.firstBuy = intStr(firstBuyTokens);
  return payload;
}

/**
 * main.go Buy (main.go:999-1042). `tokens` is a count of WHOLE TOKENS, not a
 * 3-decimal amount. There is deliberately no cost cap in the payload: the
 * buyer's slippage protection is their own signed `transfer.allow` on the
 * single HiveDraw of TotalDue, which buildOp() sets from hbdLegBaseUnits.
 */
export function buyPayload(creator: string, tokens: number): Record<string, unknown> {
  return { creator, tokens: intStr(tokens) };
}

/**
 * main.go Sell (main.go:1044-1105). `minNet` is the seller's OPTIONAL signed
 * floor on the HBD they receive — the front-run/slippage guard core.Sell
 * checks BEFORE any write. Omitting it opts OUT of the guard entirely (which
 * is what keeps an exit from ever being trapped), so pass one whenever the UI
 * has shown the seller a quote.
 */
export function sellPayload(creator: string, tokens: number, minNetBaseUnits?: number): Record<string, unknown> {
  const payload: Record<string, unknown> = { creator, tokens: intStr(tokens) };
  if (minNetBaseUnits !== undefined && minNetBaseUnits > 0) payload.minNet = moneyStr(minNetBaseUnits);
  return payload;
}

/** main.go Retire (main.go:1303-1344). Creator-only, ONCE-ONLY; starts the 5-day notice then FROZEN. Moves no funds. */
export function retirePayload(creator: string): Record<string, unknown> {
  return { creator };
}

/** main.go ClaimTradeFees (main.go:1261-1301). No payload at all — the caller IS the beneficiary. */
export function claimTradeFeesPayload(): Record<string, unknown> {
  return {};
}

/** main.go CloseIfDrained (main.go:1157-1208). */
export function closeIfDrainedPayload(creator: string): Record<string, unknown> {
  return { creator };
}

/** main.go WithdrawTreasury (main.go:1210-1259). Owner-gated inside core; the UI must keep this behind an owner-only surface. */
export function withdrawTreasuryPayload(amountBaseUnits: number): Record<string, unknown> {
  return { amount: moneyStr(amountBaseUnits) };
}

/** main.go Pause/Unpause (main.go:438/461). Global INBOUND pause only — outflows (sell, refund, claim, answer) never pause. */
export function pausePayload(): Record<string, unknown> {
  return {};
}
export function unpausePayload(): Record<string, unknown> {
  return {};
}

/** main.go Renew (main.go:451-479). */
export function renewPayload(creator: string, periods: number, paidBaseUnits: number): Record<string, unknown> {
  return { creator, periods, paid: moneyStr(paidBaseUnits) };
}

/** main.go SetFace (main.go:481-504). */
export function setFacePayload(newFaceBaseUnits: number): Record<string, unknown> {
  return { newFace: newFaceBaseUnits };
}

/** main.go SetCap (main.go:506-527). */
export function setCapPayload(newCapBaseUnits: number): Record<string, unknown> {
  return { newCap: newCapBaseUnits };
}

// prepayPayload is GONE. core/prepay.go was DELETED by the bonding-curve
// pivot — there is no PAR issuance entrypoint to call any more, and the
// replacement is buyPayload (the curve), NOT a renamed prepay. Anything still
// importing prepayPayload is pre-pivot code that must be re-pointed at buy.

/**
 * main.go Ask (main.go:755-808). TWO fields the wrapper does NOT read, and
 * that must therefore never be sent: `rate` (the wrapper sources it fresh
 * from core's own settlement derivation) and `commissionHbdPaid` — the
 * wrapper computes the exact commission itself via core.CommissionOwedFor,
 * because core.Ask requires it to match EXACTLY (the H2 fix) and any
 * client-side copy of that formula could only ever drift into bricking every
 * ask.
 */
export function askPayload(
  creator: string,
  contentHash: string,
  deadlineBlocks: number,
  maxCreditsBaseUnits: number,
  offeringId?: number
): Record<string, unknown> {
  // maxCredits is REQUIRED by core.Ask — it is the asker's own signed cap on
  // credits spent, and the contract rejects a missing or zero value rather than
  // defaulting to unlimited. It exists because `face` is creator-controlled and
  // intra-block order is producer-chosen, so a creator could otherwise spike the
  // price between the asker signing and the tx executing.
  // core/ask.go:336-343 — non-empty, <= MaxHashLen, no '|'. Checked HERE, at
  // the last chokepoint before the wire, so a doomed ask never reaches a
  // signature. See payload-contract.ts's assertHashField doc.
  assertHashField('contentHash', contentHash);
  const payload: Record<string, unknown> = { creator, contentHash, deadlineBlocks, maxCredits: moneyStr(maxCreditsBaseUnits) };
  // OMITTED, not sent as 0, when there is no named offering: absent and 0 mean
  // the same thing on-chain (the legacy `face` price), and omitting keeps the
  // payload byte-identical to every pre-shop ask. When a service IS named, the
  // id must be a whole number — a fractional or negative value would be
  // present-but-unparseable, which the contract refuses outright rather than
  // defaulting to the cheaper face price.
  if (offeringId !== undefined && offeringId > 0) payload.offeringId = offeringIdNum(offeringId);
  return payload;
}

/** main.go Answer (main.go:639-661). */
export function answerPayload(seq: number, answerHash: string): Record<string, unknown> {
  // core/ask.go:515-523 — same three bounds as contentHash. The answer box is
  // free text with a "paste a link" placeholder, so this is the likelier of the
  // two to be tripped by an ordinary user doing an ordinary thing.
  assertHashField('answerHash', answerHash);
  return { seq, answerHash };
}

/**
 * main.go Decline (main.go:948-979) — the creator's free, honest "no", legal in
 * the SAME window an Answer is. Returns the asker's credits AND the whole
 * commission, and is explicitly NOT a miss against the delivery record.
 *
 * This is the rail that makes griefing pointless and makes a miss mean "you
 * ignored a paying customer" rather than "you are selective", so a UI that
 * offers Answer without offering Decline is pushing creators toward taking a
 * black mark for jobs they simply cannot do.
 */
export function declinePayload(creator: string, seq: number): Record<string, unknown> {
  return { creator, seq };
}

/**
 * main.go Rate — the BUYER's 1-5 score for a delivered job.
 *
 * This is the only counterweight to `answer` being a unilateral "this is done"
 * that pays the creator: the contract never sees the work, so it cannot judge
 * it. The buyer records what actually happened, and a creator who takes money
 * without delivering watches their own token's reputation fall.
 *
 * Both fields are UNQUOTED integers (parse.U64Field): `seq` because escrow #0 is
 * real, and `score` because it is a count, not money.
 */
export function ratePayload(creator: string, seq: number, score: number): Record<string, unknown> {
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new Error(`op-builders: invalid score ${JSON.stringify(score)} — must be a whole number 1-5`);
  }
  return { creator, seq, score };
}

/** main.go Reclaim (main.go:663-688). */
export function reclaimPayload(creator: string, seq: number): Record<string, unknown> {
  return { creator, seq };
}

/**
 * main.go Refund (main.go:928-997) — the WIND-DOWN exit (FROZEN/CLOSED only;
 * while the market trades the exit is `sell`). The wire field is still named
 * `credits`, but under the curve it is a count of WHOLE TOKENS. `minNet` is
 * the same optional signed floor `sell` takes, checked before any write.
 *
 * The payout is pro-rata AND TAXED: net = gross − ceil(gross·τ(h)/1e4) where
 * τ is the caller's own hold clock (there is no trade fee on this rail). Any
 * minNet the UI passes must be computed from the NET, not the gross.
 */
export function refundPayload(creator: string, tokens: number, minNetBaseUnits?: number): Record<string, unknown> {
  const payload: Record<string, unknown> = { creator, credits: intStr(tokens) };
  if (minNetBaseUnits !== undefined && minNetBaseUnits > 0) payload.minNet = moneyStr(minNetBaseUnits);
  return payload;
}

/** main.go RefundHolder (main.go:725-757). */
export function refundHolderPayload(creator: string, holder: string): Record<string, unknown> {
  return { creator, holder };
}

/**
 * main.go Transfer (main.go:665-753) — moves TOKENS between holders. `from`
 * is deliberately never a field here: the wrapper always sources it from the
 * env caller, never the payload.
 *
 * Renamed from transferCreditsPayload with the pivot: there are no "credits"
 * any more, and the amount is a whole-token count rather than a 3-decimal
 * base-units value.
 */
export function transferTokensPayload(creator: string, to: string, tokens: number): Record<string, unknown> {
  return { creator, to, amount: intStr(tokens) };
}

// ===================================
// The offerings shop (main.go:1673-1838) — a creator posts N named services,
// each with its own HBD price under its own 2x/7d anti-rug band. The caller IS
// the creator on all four writes, so none of them carries a `creator` field.
//
// PRICES HERE ARE UNQUOTED NUMBERS, not money strings. The four shop
// entrypoints read them with jsonU64/i64FromU64, unlike ask/buy/sell/refund
// which use parseBigDecimal on a quoted string. Sending a quoted "500" would
// parse as 0 and post a FREE service — which is why offeringPriceNum below
// refuses anything that is not already a whole, non-negative base-units
// integer instead of coercing.
// ===================================

/** main.go CreateOffering (main.go:1673-1701). `priceBaseUnits` is HBD in base units (3 decimals), e.g. 200_000 for 200.000 HBD. */
export function createOfferingPayload(title: string, priceBaseUnits: number): Record<string, unknown> {
  return { title, price: offeringPriceNum(priceBaseUnits) };
}

/**
 * main.go SetOfferingPrice (main.go:1703-1745). Bounded by the offering's own
 * TITLE-anchored 2x/7d band — a rename, a delete-and-recreate, or a case change
 * will not reset it.
 */
export function setOfferingPricePayload(offeringId: number, newPriceBaseUnits: number): Record<string, unknown> {
  return { offeringId: offeringIdNum(offeringId), newPrice: offeringPriceNum(newPriceBaseUnits) };
}

/** main.go SetOfferingTitle (main.go:1747-1786). Renaming ONTO another live offering's title is refused on-chain (it would launder that title's price band). */
export function setOfferingTitlePayload(offeringId: number, title: string): Record<string, unknown> {
  return { offeringId: offeringIdNum(offeringId), title };
}

/** main.go DeleteOffering (main.go:1788-1821). Delisting only — it does not touch escrows already asked against this offering. */
export function deleteOfferingPayload(offeringId: number): Record<string, unknown> {
  return { offeringId: offeringIdNum(offeringId) };
}

/** main.go ListOfferings (main.go:1823-1838) — a pure read; returns the creator's whole posted catalogue. */
export function listOfferingsPayload(creator: string): Record<string, unknown> {
  return { creator };
}

/**
 * offeringIdNum guards the one field where 0 is MEANINGFUL rather than empty:
 * id 0 is the reserved alias for the creator's legacy single `face` price. The
 * contract reads it with parse.U64Field, which refuses anything that is not an
 * unquoted non-negative decimal — so a float, a negative, or a stringified id
 * is a hard on-chain error, never a silent fall back to the cheaper face price.
 * Catch it here, where the stack trace still names the caller.
 */
function offeringIdNum(n: number): number {
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`op-builders: invalid offeringId ${JSON.stringify(n)} — must be a non-negative whole number (0 is the reserved legacy-face alias)`);
  }
  return n;
}

/** offeringPriceNum is moneyStr's counterpart for the shop's UNQUOTED price fields. Same base-units input, different wire shape — see the section doc above for why sending a quoted string here posts a free service. */
function offeringPriceNum(n: number): number {
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`op-builders: invalid offering price ${JSON.stringify(n)} — must be a non-negative whole number of HBD base units`);
  }
  return n;
}

// moneyStr converts an already-computed non-negative integer base-units
// number into the exact wire shape parseBigDecimal (main.go:266-281) accepts
// — a quoted, bare base-10 integer string. Throws rather than silently
// clamping/truncating a bad value: this is the last line of defense before a
// real HBD/credits amount goes out on the wire, and a loud local failure
// here is strictly better than either sending a silently-wrong amount or a
// string parseBigDecimal will reject anyway.
function moneyStr(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`op-builders: invalid money amount ${JSON.stringify(n)} — must be a non-negative finite base-units number`);
  }
  return String(Math.round(n));
}

/**
 * intStr is moneyStr's counterpart for TOKEN COUNTS (buy/sell/refund/transfer
 * `tokens`, register `firstBuy`). Same wire shape — parseBigDecimal accepts
 * only a quoted bare base-10 integer either way — but a DIFFERENT unit, and
 * that distinction is the whole point of having two names: a token count must
 * never be run through humanToBaseUnits/baseUnitsToHuman (see contract-math.ts's
 * unit note — that would be a silent 1000x error on a fund path).
 *
 * REJECTS a fractional value rather than rounding it: you cannot buy half a
 * token, and silently rounding 0.5 to 1 would charge the user for a token
 * they did not ask for. The caller must floor deliberately.
 */
function intStr(n: number): string {
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`op-builders: invalid token count ${JSON.stringify(n)} — must be a non-negative whole number (tokens are integers on the curve; floor before calling)`);
  }
  return String(n);
}
