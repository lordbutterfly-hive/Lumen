// custom_json op construction. Same envelope as
// prediction-market/lib/op-builders.ts (id "vsc.call",
// { net_id, contract_id, action, payload, rc_limit, intents }) —
// WIRING-VERIFY (deploy): unverified against a live node, same as that file's
// own admission.
//
// AUTH (finding C1, posting-key-theft fix): the contract requires ACTIVE
// authority on every one of its 11 write entrypoints, full stop — a Hive
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
// fixes). buildOp() itself re-checks every payload against that same spec,
// AND re-checks the auth shape above, in development (assertPayloadShape /
// assertAuthContract below), so vsc-data-source.ts's 11 write methods don't
// each need their own guard — this is the one choke point every one of them
// already funnels through.

import { assertAuthContract, assertPayloadShape } from './payload-contract';

export interface CustomJsonOp {
  id: string;
  json: string;
  required_auths: string[];
  required_posting_auths: string[];
}

export const VSC_CALL_ID = 'vsc.call';

// WIRING-VERIFY (deploy): placeholder rc_limit; override via
// REACT_APP_CREATOR_TOKENS_RC_LIMIT once a devnet call reports real gas_used.
export const DEFAULT_RC_LIMIT = 30_000;

export function buildOp(opts: {
  netId: string;
  contractId: string;
  action: string;
  payload: Record<string, unknown>;
  hbdLegBaseUnits?: number;
  /** The Hive ACTIVE-authority account signing this write (required_auths). Required — see the file-level AUTH comment: every one of the 11 write actions needs active authority, never posting. */
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
  const requiredAuths = opts.activeAuth ? [opts.activeAuth] : [];
  const requiredPostingAuths: string[] = [];
  if (process.env.NODE_ENV !== 'production') {
    assertAuthContract(opts.action, requiredAuths, requiredPostingAuths);
  }
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

/** main.go Register (main.go:411-449). */
export function registerPayload(faceBaseUnits: number, capBaseUnits: number, feePaidBaseUnits: number): Record<string, unknown> {
  return { face: faceBaseUnits, cap: capBaseUnits, feePaid: moneyStr(feePaidBaseUnits) };
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

/** main.go Prepay (main.go:529-557). */
export function prepayPayload(creator: string, hbdPaidBaseUnits: number): Record<string, unknown> {
  return { creator, hbdPaid: moneyStr(hbdPaidBaseUnits) };
}

/** main.go Ask (main.go:589-637). `rate` is deliberately never a field here — see main.go's file-level "departure #1" comment; the wrapper always sources it fresh from core.AskRate, never the payload. */
export function askPayload(
  creator: string,
  contentHash: string,
  deadlineBlocks: number,
  commissionHbdPaidBaseUnits: number,
  maxCreditsBaseUnits: number
): Record<string, unknown> {
  // maxCredits is REQUIRED by core.Ask — it is the asker's own signed cap on
  // credits spent, and the contract rejects a missing or zero value rather than
  // defaulting to unlimited. It exists because `face` is creator-controlled and
  // intra-block order is producer-chosen, so a creator could otherwise spike the
  // price between the asker signing and the tx executing.
  return {
    creator,
    contentHash,
    deadlineBlocks,
    commissionHbdPaid: moneyStr(commissionHbdPaidBaseUnits),
    maxCredits: moneyStr(maxCreditsBaseUnits)
  };
}

/** main.go Answer (main.go:639-661). */
export function answerPayload(seq: number, answerHash: string): Record<string, unknown> {
  return { seq, answerHash };
}

/** main.go Reclaim (main.go:663-688). */
export function reclaimPayload(creator: string, seq: number): Record<string, unknown> {
  return { creator, seq };
}

/** main.go Refund (main.go:690-723). */
export function refundPayload(creator: string, creditsBaseUnits: number): Record<string, unknown> {
  return { creator, credits: moneyStr(creditsBaseUnits) };
}

/** main.go RefundHolder (main.go:725-757). */
export function refundHolderPayload(creator: string, holder: string): Record<string, unknown> {
  return { creator, holder };
}

/** main.go Transfer/transferCredits (main.go:559-587). `from` is deliberately never a field here — see main.go's file-level "departure #2" comment; the wrapper always sources it from the env caller, never the payload. */
export function transferCreditsPayload(creator: string, to: string, amountBaseUnits: number): Record<string, unknown> {
  return { creator, to, amount: moneyStr(amountBaseUnits) };
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
