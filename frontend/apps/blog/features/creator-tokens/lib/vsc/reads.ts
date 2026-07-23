import type { Ask, Market } from '../../types';
import { RECLAIM_GRACE_BLOCKS, baseUnitsToHuman, blockToEpochMs, deriveAskStatus, parseStrictBaseUnits } from '../contract-math';

// getStateByKeys plumbing and decoding — mirrors how
// features/prediction-market/lib/vsc-gql.ts (the GQL client) and
// vsc-market-data-source.ts's own key builders/parsers are kept apart from
// the orchestrating class. Everything here is either "how do I ask the node
// for state" or "how do I turn what it returned into a domain shape"; nothing
// here builds or signs a write.

// ── Identity namespace (finding C-A). go-vsc-node builds the execution
// caller (msg.caller) from the Hive transaction's RequiredAuths[0] and
// prefixes EVERY Hive L1 auth with "hive:" before the contract ever sees it
// — verified directly against /mnt/o/CREATOR-TOKENS/core/util.go's
// validAccount doc, which documents the exact same fact from the contract
// side ("the real value is 'hive:username'... Every Register, Prepay,
// RefundHolder and TransferCredits would have reverted for every real user").
// core.Register always uses that DID-form caller AS the market's own
// `creator` identity (main.go's Register entrypoint: caller==creator,
// enforced by core.Register itself), so every state key core/keys.go builds
// — m|<creator>|<field>, bal|<creator>|<holder>, e|<creator>|<seq>,
// tw|<creator>|<i> — is namespaced under "hive:<name>", never a bare
// username. A client that builds `m|alice|face` instead of
// `m|hive:alice|face` reads null forever ("never registered") even against
// a market that genuinely exists. toDid() is the ONE conversion point; every
// key builder below routes every account parameter through it so this can
// never be forgotten at a call site. Bare account values are still what
// callers pass in and what this module echoes back in Market/Ask/etc. for
// display (UI-friendly) — only the wire key (and, in vsc-data-source.ts, the
// wire PAYLOAD account fields core's own functions compare caller against)
// need the DID form.
export function toDid(account: string): string {
  if (account.startsWith('hive:') || account.startsWith('did:')) return account;
  return `hive:${account}`;
}

// Mirrors core/util.go's validAccount: printable ASCII (0x20-0x7e), 1-96
// bytes, never the '|' key-delimiter — core's OWN guard on any account
// string concatenated into a state key. Deliberately does NOT check Hive
// account-name grammar (util.go's own doc explains why that would be wrong:
// it would reject every real "hive:username" DID). Used client-side
// (finding M-e) on any account about to be sent as a WRITE DESTINATION
// distinct from the signer (transferCredits' `to`, refundHolder's `holder`)
// — core's own validAccount only runs AFTER the tx has already spent the
// caller's RC, so this is one guard the client can usefully run first.
export function isWellFormedDid(account: string): boolean {
  if (account.length === 0 || account.length > 96) return false;
  for (let i = 0; i < account.length; i++) {
    const c = account.charCodeAt(i);
    if (c === 0x7c /* '|' */ || c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

// ── State-key builders. COUPLING WARNING: mirror /mnt/o/CREATOR-TOKENS/core/keys.go byte-for-byte. Every account parameter is routed through toDid() (see above) — never build a key from a raw account string directly. ──
function mk(c: string, field: string): string {
  return `m|${toDid(c)}|${field}`;
}
export function kFace(c: string): string {
  return mk(c, 'face');
}
export function kFaceSetAt(c: string): string {
  return mk(c, 'fsa');
}
// kFaceAnchor/kFaceAnchorAt (keys.go: "fan"/"faa") — the band's rolling
// window anchor, added to core alongside the 2026-07-20 SetFace fix (see
// contract-math.ts's deriveFaceBandBaseUnits doc). Distinct from kFace/
// kFaceSetAt: those track the CURRENT face and when it was last set; these
// track the face/block the current 7-day band is measured AGAINST.
export function kFaceAnchor(c: string): string {
  return mk(c, 'fan');
}
export function kFaceAnchorAt(c: string): string {
  return mk(c, 'faa');
}
export function kCap(c: string): string {
  return mk(c, 'cap');
}
export function kSupply(c: string): string {
  return mk(c, 'sup');
}
export function kReserve(c: string): string {
  return mk(c, 'res');
}
export function kPaidUntil(c: string): string {
  return mk(c, 'pu');
}
export function kState(c: string): string {
  return mk(c, 'st');
}
export function kRegisteredAt(c: string): string {
  return mk(c, 'reg');
}
export function kSeq(c: string): string {
  return mk(c, 'seq');
}
export function kBal(c: string, holder: string): string {
  return `bal|${toDid(c)}|${toDid(holder)}`;
}
export function kEscrow(c: string, seq: number): string {
  return `e|${toDid(c)}|${seq}`;
}
export function kObs(c: string, i: number): string {
  return `tw|${toDid(c)}|${i}`;
}
export function kObsIdx(c: string): string {
  return `tw|${toDid(c)}|n`;
}
export function kPaused(): string {
  return 'paused';
}

export const STATE_CLOSED = 'CLOSED';

// Mirrors util.go's getU64/getMoney "malformed -> zero" convention
// (never a panic/reject) — but integer-strict (M-f): a decimal string like
// "5.5" is finite under a naive Number.isFinite check yet neither
// strconv.ParseUint nor big.Int.SetString would ever accept it. See
// parseStrictBaseUnits's own doc in contract-math.ts.
export function toU64(value: string | null | undefined): number {
  return parseStrictBaseUnits(value) ?? 0;
}

// ── Escrow record: asker|credits|deadline|status|commissionHbd|contentHash|answerHash
// (ask.go packEscrow). Manual split (not String.split) to match Go's
// strings.SplitN(v, "|", 7): only the first 6 delimiters are structural, the
// 7th field is "everything after" even if it contained a literal '|'. ──
export interface ParsedEscrow {
  asker: string;
  creditsBaseUnits: number;
  deadlineBlock: number;
  status: 'PENDING' | 'ANSWERED' | 'RECLAIMED';
  contentHash: string;
  answerHash: string;
}

export function parseEscrow(v: string): ParsedEscrow | null {
  // ask.go's packEscrow now emits SEVEN fields:
  //   asker|credits|deadline|status|commissionHbd|contentHash|answerHash
  // commissionHbd was inserted before the two free-form fields when the
  // commission moved into escrow (so it is returned on reclaim rather than
  // forfeited). Reading the old six-field layout silently put the commission
  // into contentHash and a pipe-joined pair into answerHash.
  const parts: string[] = [];
  let rest = v;
  for (let i = 0; i < 6; i++) {
    const idx = rest.indexOf('|');
    if (idx < 0) return null;
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  parts.push(rest);
  const [asker, creditsStr, deadlineStr, status, commissionHbdStr, contentHash, answerHash] = parts;
  // Integer-strict (M-f): credits/commissionHbd are unpacked in Go via
  // big.Int.SetString(s,10) (money.go parseMoney), deadline via
  // strconv.ParseUint — NEITHER accepts a decimal point, so a naive
  // `Number(...)`+`isFinite` check here was looser than what the chain
  // itself would ever have accepted or produced. See
  // parseStrictBaseUnits's own doc in contract-math.ts.
  const commissionHbdBaseUnits = parseStrictBaseUnits(commissionHbdStr);
  if (commissionHbdBaseUnits === null) return null;
  const creditsBaseUnits = parseStrictBaseUnits(creditsStr);
  if (creditsBaseUnits === null) return null;
  const deadlineBlock = parseStrictBaseUnits(deadlineStr);
  if (deadlineBlock === null) return null;
  if (status !== 'PENDING' && status !== 'ANSWERED' && status !== 'RECLAIMED') return null;
  return { asker, creditsBaseUnits, deadlineBlock, status, contentHash, answerHash };
}

// ── Minimal GQL client — plain fetch, scoped to this feature. Same two
// queries as prediction-market/lib/vsc-gql.ts, grounded in the same
// go-vsc-node schema. ──
export function getJsonProp(value: unknown, key: string): unknown {
  if (typeof value === 'object' && value !== null && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

function collectGqlErrors(value: unknown): string | null {
  const errors = getJsonProp(value, 'errors');
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors.map((e) => (typeof getJsonProp(e, 'message') === 'string' ? getJsonProp(e, 'message') : 'unknown error')).join('; ');
}

async function postGql(gqlUrl: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(gqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`Creator Tokens GQL HTTP ${res.status}`);
  const json: unknown = await res.json();
  const errorMsg = collectGqlErrors(json);
  if (errorMsg) throw new Error(`Creator Tokens GQL error: ${errorMsg}`);
  return getJsonProp(json, 'data');
}

const STATE_QUERY = `query CreatorTokensState($contractId: String!, $keys: [String!]!) {
  getStateByKeys(contractId: $contractId, keys: $keys)
}`;
const HEAD_QUERY = `query CreatorTokensHead {
  localNodeInfo { last_processed_block }
}`;

export class CreatorTokensGqlClient {
  constructor(private readonly gqlUrl: string) {}

  async getStateByKeys(contractId: string, keys: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    if (keys.length === 0) return out;
    // getStateByKeys accepts 1..100 keys per call (schema.graphql:813); batch.
    const CHUNK = 100;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = keys.slice(i, i + CHUNK);
      const data = await postGql(this.gqlUrl, STATE_QUERY, { contractId, keys: chunk });
      const rawMap = getJsonProp(data, 'getStateByKeys');
      for (const key of chunk) {
        const value = getJsonProp(rawMap, key);
        out[key] = typeof value === 'string' ? value : null;
      }
    }
    return out;
  }

  async getHeadBlock(): Promise<number | null> {
    try {
      const data = await postGql(this.gqlUrl, HEAD_QUERY, {});
      const raw = getJsonProp(getJsonProp(data, 'localNodeInfo'), 'last_processed_block');
      const height = Number(raw);
      // M-g, fixed at the ROOT rather than at each of readMarket's/
      // readQuote's/readCreatorAsks's own call sites: a head that coerces to
      // 0 (a missing field, an empty string, `null` itself) is finite under
      // `Number.isFinite` alone and was previously accepted as a REAL block
      // height — every downstream phase/deadline/TWAP-window computation
      // then ran against "block 0" instead of failing closed the way a
      // genuinely-unavailable head must. Every caller of getHeadBlock()
      // already treats a `null` return as "read failed, don't guess" (see
      // e.g. vsc-data-source.ts's readMarket: `if (head === null) return
      // unknownMarket(creator)`), so guaranteeing here that a non-null
      // result is ALWAYS a real, positive, integer block height fixes every
      // one of those call sites at once, rather than re-adding the same
      // "is this really a valid head" check at each of them individually.
      return Number.isFinite(height) && Number.isInteger(height) && height > 0 ? height : null;
    } catch {
      return null;
    }
  }
}

// ── Decoding: turn parsed chain state into the domain shapes types.ts
// declares. ──

/** The one Market shape readMarket() resolves with on a genuine read failure — see creator-tokens-data-source.ts's own interface doc for why this is a resolve, not a reject. */
export function unknownMarket(creator: string): Market {
  return {
    creator,
    faceHbd: 0,
    faceSetAtBlock: 0,
    faceBand: { minHbd: 0, maxHbd: 0, bandActive: false, windowEndsAtBlock: 0 },
    capCredits: 0,
    supplyCredits: 0,
    reserveHbd: 0,
    paidUntilBlock: 0,
    paidUntilAt: Date.now(),
    registeredAtBlock: 0,
    phase: 'UNKNOWN',
    graceExpiresAtBlock: 0,
    graceExpiresAt: Date.now(),
    globalInflowPaused: false,
    canPrepay: false,
    canAsk: false,
    refundPricePerCredit: 0
  };
}

export function buildAskFromParsed(creator: string, seq: number, parsed: ParsedEscrow, head: number | null): Ask {
  const reclaimableAtBlock = parsed.deadlineBlock + RECLAIM_GRACE_BLOCKS;
  // A stored status (ANSWERED/RECLAIMED) is a fact regardless of head; only
  // the PENDING -> awaiting/reclaimable split needs "now" — default to the
  // non-actionable `awaiting` when head is unavailable rather than guessing.
  const status = head !== null ? deriveAskStatus(parsed.status, parsed.deadlineBlock, head) : parsed.status === 'ANSWERED' ? 'answered' : parsed.status === 'RECLAIMED' ? 'reclaimed' : 'awaiting';
  return {
    id: `${creator}:${seq}`,
    creator,
    seq,
    asker: parsed.asker,
    creditsEscrowed: baseUnitsToHuman(parsed.creditsBaseUnits),
    deadlineBlock: parsed.deadlineBlock,
    deadlineAt: blockToEpochMs(parsed.deadlineBlock, head),
    reclaimableAtBlock,
    reclaimableAt: blockToEpochMs(reclaimableAtBlock, head),
    status,
    contentHash: parsed.contentHash,
    answerHash: parsed.answerHash || null
  };
}
