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
// — m|<creator>|<field>, mb|<creator>|<holder>, e|<creator>|<seq>,
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
// MaxAccountLen is 160 on the contract side (core/util.go), not 96. The 96
// here was too TIGHT, and a too-tight client guard is a real bug of its own: it
// rejects BTC P2WSH/taproot did:pkh forms the contract would happily accept, so
// a legitimate holder could never be sent tokens or swept. Widened 2026-07-28
// (gap list) to match core exactly — the point of this mirror is to agree with
// core, and disagreeing in EITHER direction is a defect.
export function isWellFormedDid(account: string): boolean {
  if (account.length === 0 || account.length > 160) return false;
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

// ── The offerings shop (core/keys.go's mko/kOffer*). Offering keys are
// EPOCH-SCOPED: Register bumps kOfferEpoch, which orphans the whole previous
// incarnation's catalogue in one write instead of deleting N keys. So every
// shop read is two-stage — resolve the epoch first, then build the id keys
// against it. Reading with a stale epoch silently returns a DEAD shop. ──
function mko(c: string, epoch: number, id: number, field: string): string {
  return `m|${toDid(c)}|o|${epoch}|${id}|${field}`;
}
/** Monotone offering-namespace epoch, bumped by Register. Absent/0 is the normal first-incarnation value. */
export function kOfferEpoch(c: string): string {
  return mk(c, 'oep');
}
/** The LIVE ids, comma-separated. The list IS the live set — its length is the live count, and there is no second counter that could drift from it. Id 0 is not an offering (it doubles as the counter slot), so it never appears here. */
export function kOfferIds(c: string, epoch: number): string {
  return mko(c, epoch, 0, 'ids');
}
/** HBD base units. 0 means deleted or never set — the contract refuses an ask against it rather than falling back to the face price. */
export function kOfferPrice(c: string, epoch: number, id: number): string {
  return mko(c, epoch, id, 'p');
}
/** Free-form display label. Also the key of the price BAND (bands are title-anchored, so a rename cannot reset one). */
export function kOfferTitle(c: string, epoch: number, id: number): string {
  return mko(c, epoch, id, 't');
}

/** Parses kOfferIds' comma-separated list. Tolerates absent/empty (a creator with no shop) and skips anything unparseable rather than throwing — a malformed entry must not blank the whole catalogue. */
export function parseOfferIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  const out: number[] = [];
  for (const part of raw.split(',')) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return out;
}
export function kFaceSetAt(c: string): string {
  return mk(c, 'fsa');
}

/**
 * The delivery gate's penalty deadline (core/keys.go's kDelinquentUntil,
 * "ddu"): the block until which the creator's INFLOWS are refused because they
 * ignored too many paying customers. 0 = clear.
 *
 * RequireInflowOpen consults it on-chain, so a client that does not read it
 * renders a live Buy/Ask button for a market that will revert every attempt —
 * the exact "the UI lies" class this feature has already been burned by. Note
 * it gates INFLOWS ONLY: every outflow (sell, refund, reclaim, claim) stays
 * open, by design (`non-payment AND non-delivery never gate funds`).
 */
export function kDelinquentUntil(c: string): string {
  return mk(c, 'ddu');
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
// keys.go kRetiredAt ("rat") — the RULING-D retire notice mark. STORED AS
// block+1 so that 0 can encode "never retired"; decodeRetiredAt below is the
// one place that offset is undone. Phase() folds it in as MAX(natural,
// retired), so a client that never reads this key shows a retired market as
// tradeable ACTIVE right up until the buy reverts.
export function kRetiredAt(c: string): string {
  return mk(c, 'rat');
}
// keys.go kFeeBal ("fee|<account>") — PULL-claimable trade-fee balance, the
// creator's 5% half of every trade fee (RULING F8: the fee is NEVER pushed).
// Keyed by ACCOUNT, not by market: one pot per beneficiary across all their
// markets. Neither reserve nor treasury — its own resting bucket.
export function kFeeBal(account: string): string {
  return `fee|${toDid(account)}`;
}
// keys.go kAcqBlock ("acq|<creator>|<holder>") — the weighted-average
// acquisition block (`wacq`), the hold clock the exit-tax RATE keys on. Reset
// toward `now` on every inflow, so a fresh or sybil account always looks
// maximally fresh. UNSET (0) reads as "never clocked" and must be treated as
// maximally FRESH (max tax), never as ancient — holdclock.go's own direction,
// and getting it backwards would preview a 0% tax on a position the chain
// taxes at 20%.
export function kAcqBlock(c: string, holder: string): string {
  return `acq|${toDid(c)}|${toDid(holder)}`;
}
export function kTreasury(): string {
  return 'treasury';
}
export function kOwner(): string {
  return 'owner';
}
// keys.go kObsLong ("twl|") — the 7-day settlement observation ring (RULING
// C1), sampled at most once per LongObsSpacing blocks. Disjoint from the
// short "tw|" ring: creator names can never contain '|'.
export function kObsLong(c: string, i: number): string {
  return `twl|${toDid(c)}|${i}`;
}
export function kObsLongIdx(c: string): string {
  return `twl|${toDid(c)}|n`;
}

/**
 * Undo kRetiredAt's block+1 encoding: the chain stores `block+1` so that a
 * stored 0 (or an absent key) unambiguously means "never retired" even for a
 * market retired at block 0. Returns null for never-retired, else the real
 * retire height.
 */
export function decodeRetiredAt(raw: string | null | undefined): number | null {
  const v = parseStrictBaseUnits(raw);
  if (v === null || v === 0) return null;
  return v - 1;
}
// MATURING balance. Renamed from `bal|` to `mb|` on 2026-07-30 to match
// core/keys.go — `bal|` is now reserved for the market-facing MATURED family,
// which magi-market reads directly as `bal|<holder>|<creator>` (transposed) in
// little-endian u64. Reading the old prefix here would return the wrong
// family's bytes, or nothing at all.
export function kBal(c: string, holder: string): string {
  return `mb|${toDid(c)}|${toDid(holder)}`;
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
  /**
   * ★ A WHOLE TOKEN COUNT, not a 3-decimal base-units amount. ask.go's
   * creditsForAsk is ceil(face/rate) where `rate` is HBD base units PER
   * TOKEN, so the quotient is a token count and the escrow debits the same
   * whole-token balance Buy/Sell move. Renamed from `creditsBaseUnits`
   * precisely so the old name can no longer invite a baseUnitsToHuman()
   * divide — that would understate every escrowed amount by 1000x.
   */
  tokensEscrowed: number;
  deadlineBlock: number;
  status: 'PENDING' | 'ANSWERED' | 'RECLAIMED' | 'DECLINED';
  /** The asker's hold clock, carried through the escrow so reclaiming cannot launder a fresh position into an aged, untaxed one. */
  acqBlock: number;
  contentHash: string;
  answerHash: string;
}

export function parseEscrow(v: string): ParsedEscrow | null {
  // ★ EIGHT fields as of the curve pivot (ask.go packEscrow, verified at
  // source 2026-07-24 — Go reads it back with strings.SplitN(v, "|", 8)):
  //
  //   asker|credits|deadline|status|commissionHbd|acqBlock|contentHash|answerHash
  //
  // `acqBlock` was INSERTED before the two free-form fields: an escrow now
  // carries the asker's hold clock so the credits it holds keep their
  // acquisition age across the escrow round-trip (otherwise escrowing and
  // reclaiming would launder a fresh position into an aged, untaxed one).
  //
  // THIS PARSER READ SEVEN. Against real eight-field state it silently put
  // acqBlock into contentHash and a pipe-joined `contentHash|answerHash` pair
  // into answerHash — the EXACT failure mode the six-to-seven migration
  // documented one revision earlier, repeated. Only the first 7 delimiters
  // are structural; the 8th field is "everything after" even if it contains
  // a literal '|', matching SplitN's own semantics.
  const parts: string[] = [];
  let rest = v;
  for (let i = 0; i < 7; i++) {
    const idx = rest.indexOf('|');
    if (idx < 0) return null;
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  parts.push(rest);
  const [asker, creditsStr, deadlineStr, status, commissionHbdStr, acqBlockStr, contentHash, answerHash] = parts;
  const acqBlock = parseStrictBaseUnits(acqBlockStr);
  if (acqBlock === null) return null;
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
  // DECLINED must be accepted here (2026-07-28). It is one of ask.go's four
  // real escrow statuses, and rejecting it made every declined escrow parse as
  // null — i.e. silently disappear from the creator's inbox and the asker's
  // list, as if the ask had never existed.
  if (status !== 'PENDING' && status !== 'ANSWERED' && status !== 'RECLAIMED' && status !== 'DECLINED') return null;
  return { asker, tokensEscrowed: creditsBaseUnits, deadlineBlock, status, acqBlock, contentHash, answerHash };
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

/**
 * The one Market shape readMarket() resolves with on a genuine read failure —
 * see creator-tokens-data-source.ts's own interface doc for why this is a
 * resolve, not a reject.
 *
 * ★ CURVE-PIVOT UPDATE (2026-07-24): rewritten to the post-pivot Market shape
 * (types.ts) — capTokens/supplyTokens (integer counts, not the deleted PAR
 * capCredits/supplyCredits), canBuy (not canPrepay), retiredAtBlock (RULING D
 * — null here, matching "unknown" rather than claiming "never retired"),
 * floorPriceHbd/spotPriceHbd/reserveCoverage (the curve's own derived
 * display fields, replacing refundPricePerCredit). All zeroed/null exactly
 * like every other field on this UNKNOWN placeholder — this is a "couldn't
 * read the chain" marker, never a claim about real state.
 */
export function unknownMarket(creator: string): Market {
  return {
    creator,
    faceHbd: 0,
    faceSetAtBlock: 0,
    faceBand: { minHbd: 0, maxHbd: 0, bandActive: false, windowEndsAtBlock: 0 },
    capTokens: 0,
    supplyTokens: 0,
    reserveHbd: 0,
    paidUntilBlock: 0,
    paidUntilAt: Date.now(),
    registeredAtBlock: 0,
    phase: 'UNKNOWN',
    graceExpiresAtBlock: 0,
    graceExpiresAt: Date.now(),
    globalInflowPaused: false,
    canBuy: false,
    canAsk: false,
    // null, not 0: on an UNKNOWN market we make no claim about delivery
    // standing either. The actions are disabled by canBuy/canAsk being false,
    // and the UI must attribute that to the failed read, never to the creator.
    delinquentUntilBlock: null,
    retiredAtBlock: null,
    floorPriceHbd: 0,
    spotPriceHbd: 0,
    reserveCoverage: 0
  };
}

export function buildAskFromParsed(creator: string, seq: number, parsed: ParsedEscrow, head: number | null): Ask {
  const reclaimableAtBlock = parsed.deadlineBlock + RECLAIM_GRACE_BLOCKS;
  // A stored status (ANSWERED/RECLAIMED) is a fact regardless of head; only
  // the PENDING -> awaiting/reclaimable split needs "now" — default to the
  // non-actionable `awaiting` when head is unavailable rather than guessing.
  const status =
    head !== null
      ? deriveAskStatus(parsed.status, parsed.deadlineBlock, head)
      : parsed.status === 'ANSWERED'
        ? 'answered'
        : parsed.status === 'RECLAIMED'
          ? 'reclaimed'
          : parsed.status === 'DECLINED'
            ? 'declined'
            : 'awaiting';
  return {
    id: `${creator}:${seq}`,
    creator,
    seq,
    asker: parsed.asker,
    // NO baseUnitsToHuman: escrowed amounts are whole tokens (see
    // ParsedEscrow.tokensEscrowed) — dividing by 1000 here understated every
    // ask in the UI by three orders of magnitude.
    tokensEscrowed: parsed.tokensEscrowed,
    acqBlock: parsed.acqBlock,
    deadlineBlock: parsed.deadlineBlock,
    deadlineAt: blockToEpochMs(parsed.deadlineBlock, head),
    reclaimableAtBlock,
    reclaimableAt: blockToEpochMs(reclaimableAtBlock, head),
    status,
    contentHash: parsed.contentHash,
    answerHash: parsed.answerHash || null
  };
}
