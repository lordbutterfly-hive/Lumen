// End-to-end integration harness for the REAL creator-tokens frontend data
// path — the layer every actually-found bug lived in (see
// /mnt/o/CREATOR-TOKENS/PRUNED-ADJUDICATION-2026-07-21.md, "FINAL VERIFICATION
// BATTERY" item 3). This closes the layer gap the in-process Go sims cannot:
// it constructs the ACTUAL VscCreatorTokensDataSource (not the mock) and drives
// every read/write against scripted, chain-SHAPED state, capturing the exact
// op each write emits without ever transmitting it.
//
// WHY A HARNESS, NOT A UNIT TEST: apps/blog has no jest/vitest runner wired
// (see payload-contract.selftest.ts's own doc for the full survey). Per the
// task brief's fallback, this is a plain `npx tsx`-runnable script that runs
// assertions and exits non-zero on failure — same pattern as
// payload-contract.selftest.ts.
//
//   RUN:  npx tsx apps/blog/features/creator-tokens/lib/vsc/__e2e__/vsc-data-path.e2e.ts
//
// It also writes the captured payload JSON strings to a fixtures file
// (/mnt/o/CREATOR-TOKENS/contract/parse/captured_payloads.json) that the
// companion Go test (golden_crosscheck_test.go) feeds through the REAL Go
// `contract/parse` package — the only way to verify, cross-language, that the
// actual parse bytecode accepts what this TS path emits.
//
// ZERO PRODUCTION CHANGES: the constructor already injects both `gql` and
// `broadcaster`; this harness supplies a FakeGql (chain-shaped state, keys
// hive:-prefixed exactly as the chain stores them) and a capturingBroadcaster
// (records the outgoing op, never transmits). Nothing in production code is
// modified — this file only READS the real data path.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { CreatorTokensConfig } from '../../creator-tokens-data-source';
import { VscCreatorTokensDataSource } from '../../vsc-data-source';
import { areaBaseUnits } from '../../contract-math';
import { CreatorTokensGqlClient, kBal, kEscrow, kRegisteredAt, kSeq, toDid } from '../reads';
import { ACTION_PAYLOAD_SPECS, MAX_HASH_LEN, WRITE_ACTIONS_REQUIRING_ACTIVE_AUTH, assertHashField, type JsonFieldType } from '../payload-contract';
import {
  BLOCKS_PER_DAY,
  COMMISSION_BPS,
  MAX_CAP_CREDITS_BASE_UNITS,
  MAX_EXIT_TAX_BPS,
  MAX_FACE_BASE_UNITS,
  MIN_CAP_CREDITS_BASE_UNITS,
  MIN_FACE_BASE_UNITS,
  TRADE_FEE_BPS
} from '../../contract-math';
import { VSC_CALL_ID, type CustomJsonOp } from '../op-builders';

// ======================================================================
// 1. Test doubles — both are injected through the REAL constructor.
// ======================================================================

/**
 * Chain-shaped fake of CreatorTokensGqlClient. A plain object cannot satisfy
 * the class type (it carries a `private gqlUrl`), so this SUBCLASSES the real
 * client and overrides only the two network methods — proving the harness
 * drives the genuine VscCreatorTokensDataSource read path, not a re-typed
 * stand-in. `state` holds LITERAL chain keys (hive:-prefixed); the client's
 * own key builders must reproduce those keys byte-for-byte or every read
 * returns null.
 */
class FakeGql extends CreatorTokensGqlClient {
  readonly state = new Map<string, string>();
  /** Every getStateByKeys batch, in order — lets an assertion inspect the EXACT keys the client built. */
  readonly queries: string[][] = [];
  head: number | null;

  constructor(head: number | null = 5_000_000) {
    super('e2e://fake-gql-never-called');
    this.head = head;
  }

  seed(key: string, value: string): this {
    this.state.set(key, value);
    return this;
  }

  /**
   * ★ MODEL THE CHAIN EXECUTING (2026-09-12). Every money write in the data
   * source now CONFIRMS — registerMarket polls kRegisteredAt for an ADVANCE,
   * the escrow rails poll the escrow record, the rest poll tx status — because
   * a Hive broadcast resolves at L1-accept, before the L2 contract has run.
   * This harness's broadcaster deliberately never transmits, so nothing ever
   * advanced and registerMarket (the FIRST call in the journey) threw
   * CREATOR_TOKENS_REGISTER_UNCONFIRMED, taking the whole fixture generation
   * with it. The stub has to answer the confirmation the way an executed chain
   * would, or the harness can only ever test the failure path.
   */
  advance(key: string, value: string): this {
    this.state.set(key, value);
    return this;
  }

  rawGet(key: string): string | null {
    const v = this.state.get(key);
    return v === undefined ? null : v;
  }

  override async getStateByKeys(_contractId: string, keys: string[]): Promise<Record<string, string | null>> {
    this.queries.push([...keys]);
    const out: Record<string, string | null> = {};
    for (const k of keys) out[k] = this.rawGet(k);
    return out;
  }

  /**
   * The matured-bucket read (F-C5) asks the node to hex-encode, and the base
   * class routes it through the same private readState that does a real fetch —
   * which in Node is an unparseable relative URL. Seeded values are plain
   * decimal here, so the stub answers with the LE-hex the decoder expects,
   * built from the same value the decimal read would give. An absent key stays
   * null, which decodes as "no matured bucket", the honest default.
   */
  override async getStateByKeysHex(_contractId: string, keys: string[]): Promise<Record<string, string | null>> {
    this.queries.push([...keys]);
    const out: Record<string, string | null> = {};
    for (const k of keys) {
      const raw = this.rawGet(k);
      if (raw === null) {
        out[k] = null;
        continue;
      }
      let n = BigInt(raw);
      let hex = '';
      for (let i = 0; i < 8; i++) {
        hex += (n & 0xffn).toString(16).padStart(2, '0');
        n >>= 8n;
      }
      out[k] = hex;
    }
    return out;
  }

  override async getHeadBlock(): Promise<number | null> {
    return this.head;
  }

  allQueriedKeys(): string[] {
    return this.queries.flat();
  }
}

interface CapturedOp {
  action: string;
  op: CustomJsonOp;
  /** The exact payload JSON string as embedded in op.json — the bytes the Go parser must accept. */
  payloadJson: string;
  payload: Record<string, unknown>;
}

/** Records every outgoing op; NEVER transmits. Returns a synthetic tx id. */
class CapturingBroadcaster {
  readonly ops: CapturedOp[] = [];

  /** Set by run() so a captured op can model the chain having executed it. */
  onExecuted: ((action: string) => void) | null = null;

  broadcast = async (op: CustomJsonOp): Promise<string> => {
    const body = JSON.parse(op.json) as { action: string; payload: Record<string, unknown> };
    this.ops.push({ action: body.action, op, payloadJson: JSON.stringify(body.payload), payload: body.payload });
    this.onExecuted?.(body.action);
    return `e2e-txid-${this.ops.length}`;
  };

  byAction(action: string): CapturedOp | undefined {
    return this.ops.find((o) => o.action === action);
  }
}

// ======================================================================
// 2. Independent "chain-side" key builders — LITERAL hive: strings,
//    mirroring core/keys.go, deliberately NOT reusing reads.ts's builders,
//    so seeding + reading are a genuine cross-check of the client's own
//    key derivation (C3). The acting account on-chain is always hive:<name>
//    (state_engine prefixes RequiredAuths[0]).
// ======================================================================

const chM = (creator: string, field: string): string => `m|hive:${creator}|${field}`;
const chBal = (creator: string, holder: string): string => `mb|hive:${creator}|hive:${holder}`;
const chEscrow = (creator: string, seq: number): string => `e|hive:${creator}|${seq}`;
// The offerings shop (core/keys.go's mko). Epoch-scoped: epoch 0 is the normal
// first incarnation, and an absent kOfferEpoch key reads as 0.
const chOfferPrice = (creator: string, epoch: number, id: number): string => `m|hive:${creator}|o|${epoch}|${id}|p`;
// ★ CURVE-PIVOT ADDITIONS (2026-07-24): acq (holdclock.go kAcqBlock) and the
// short TWAP observation ring (twap.go kObs/kObsIdx) — neither existed
// pre-pivot. Both are needed for the journey below: sell()/refund() price the
// K2/curve exit tax off the seller's OWN hold clock (unseeded reads as 0,
// i.e. maximally fresh/max tax — holdclock.go's own convention, not a bug),
// and ask() now settles via a REAL derived rate (RULING C deleted the PAR
// fallback), which needs a real observation ring with >= MinObsCount (8)
// samples spanning >= MinObsBlocks (1200) or SettlementRate refuses outright.
const chAcq = (creator: string, holder: string): string => `acq|hive:${creator}|hive:${holder}`;
const chObs = (creator: string, i: number): string => `tw|hive:${creator}|${i}`;
const chObsIdx = (creator: string): string => `tw|hive:${creator}|n`;
// keys.go kObsLong — the 7-day settlement ring. Seeding it is not optional:
// settlement is min(TWAP_short, TWAP_long, spot) and REFUSES when either arm
// cannot price (RULING C / F-C3), so a harness that seeds only the short ring
// can never reach a successful ask.
const chObsLong = (creator: string, i: number): string => `twl|hive:${creator}|${i}`;
const chObsLongIdx = (creator: string): string => `twl|hive:${creator}|n`;

const config: CreatorTokensConfig = {
  contractId: 'creator-tokens-e2e',
  netId: 'e2e-net',
  gqlUrl: 'e2e://unused',
  rcLimit: 30_000
};

const HEAD = 5_000_000;

/**
 * Seed a healthy ACTIVE market for `creator`, using LITERAL hive: chain keys.
 *
 * ★ CURVE-PIVOT REWRITE: `sup` is seeded NONZERO (50, an integer TOKEN
 * count — not the deleted PAR "credits" scale) rather than 0, because
 * settlement.go's SettlementRate refuses OUTRIGHT at supply === 0 ("no
 * supply: no token exists to settle in") — the journey below needs ask() to
 * actually settle. `res` is seeded as areaBaseUnits(50) — curve.go's R ===
 * Area(S) equality invariant — never a hand-picked number (this file's own
 * import of contract-math.ts's areaBaseUnits computes it, so this seed can
 * never silently drift from the real curve.go formula it mirrors). `bal` for
 * bob is seeded so sell()/refund() have real tokens to redeem (this harness
 * never actually executes a broadcast op — see CapturingBroadcaster — so a
 * prior "buy" in the same journey never mutates this map; every read in the
 * journey is against this SAME static seed).
 */
function seedActiveMarket(gql: FakeGql, creator: string): void {
  // ★ 50 -> 200 (2026-09-12). settlement.go's spend cap refuses an ask costing
  // more than 5% of supply, which at 50 tokens is 2 credits. The posted 2.5 HBD
  // face now settles at the WHOLE face rather than an 88% token leg (OWNER
  // RULING; the 12% is carved out of the credits inside the escrow), so it costs
  // ceil(2500/1200) = 3 and tripped the cap. 200 tokens allows 10 and leaves
  // every other guard clear: SpotRate(200) = 2680 is still above the 1200
  // marker, the C5 tripwire needs >= 457, and C2's depth ceiling is 182,670.
  const supplyTokens = 200;
  gql
    .seed(chM(creator, 'reg'), '4000000') // registeredAt > 0
    .seed(chM(creator, 'face'), '2500') // 2.5 HBD
    .seed(chM(creator, 'fsa'), '4000000')
    .seed(chM(creator, 'fan'), '2500') // band anchor -> [1.25, 5.0] HBD
    .seed(chM(creator, 'faa'), '4000000')
    .seed(chM(creator, 'cap'), '1000000') // 1,000,000 TOKENS (raw integer — curve.go MinCap/MaxCap bound this directly, no 3-decimal scaling)
    .seed(chM(creator, 'sup'), String(supplyTokens))
    .seed(chM(creator, 'res'), String(areaBaseUnits(supplyTokens)))
    .seed(chM(creator, 'pu'), '6000000') // paidUntil > head -> ACTIVE
    .seed(chBal(creator, 'bob'), '50') // bob holds 50 tokens
    .seed(chAcq(creator, 'bob'), '4712000'); // bob's hold clock: head(5,000,000) − 10 days (288,000 blocks) — partway through the 42-day exit-tax decay, so sell()'s quoted tax is neither 0% nor the 20% max
  // 8 short-ring observations (MinObsCount), 200 blocks apart, ending 600
  // blocks before head (well inside MaxStaleBlocks) — a flat 1200-base-units
  // rate, comfortably below SpotRate(50) so settlement's min() picks the
  // TWAP arm, not spot (an 'ok' status with a real, non-degenerate rate).
  for (let i = 0; i < 8; i++) {
    gql.seed(chObs(creator, i), `${4_998_000 + i * 200}|1200`);
  }
  gql.seed(chObsIdx(creator), '8');
  // 8 LONG-ring observations (LongMinObsCount) spaced 9,000 blocks apart — NOT
  // the 6,300 LongObsSpacing, which is the minimum GAP between samples and not
  // the window the arm needs: 8 samples at 6,300 span only 44,100 blocks and the
  // long arm refuses below LongMinObsBlocks (57,600) with `insufficient_span`.
  // 9,000 spans 63,000, clears it, and still ends 600 blocks before head.
  // Same flat 1200 rate as the short ring, so min(short, long, spot) resolves to
  // the marker either way and the ask settles at a rate this file can predict.
  for (let i = 0; i < 8; i++) {
    gql.seed(chObsLong(creator, i), `${4_936_400 + i * 9_000}|1200`);
  }
  gql.seed(chObsLongIdx(creator), '8');
  // kState/paused/rat(retired)/acq deliberately unseeded: absent -> not
  // CLOSED, not paused, never retired, and every holder's clock reads as
  // maximally fresh (holdclock.go's own zero-value convention).
}

// ======================================================================
// 3. Assertion plumbing.
// ======================================================================

let passes = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passes++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

async function expectReject(name: string, run: () => Promise<unknown>, mustInclude: string): Promise<void> {
  try {
    await run();
    check(name, false, `expected rejection containing "${mustInclude}", but it resolved`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(name, msg.includes(mustInclude), `rejected with "${msg}", expected to include "${mustInclude}"`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// ======================================================================
// 4. Drive the scripted journeys against the REAL data source.
// ======================================================================

async function run(): Promise<void> {
  const gql = new FakeGql(HEAD);
  const capture = new CapturingBroadcaster();
  seedActiveMarket(gql, 'alice');
  // Escrows the answer/reclaim journeys re-read after broadcast (literal keys).
  // ★ NINE fields (ask.go packEscrow):
  //   asker|credits|deadline|status|commissionCredits|acqBlock|offeringID|contentHash|answerHash
  // These seeds carried EIGHT (no offeringID) and the parser demands an exact
  // nine, so every escrow read returned null and the answer/decline/reclaim
  // confirmations could never see a status — the same class of silent staleness
  // the eight-field note below was written about, one field along.
  //
  // `credits` is a TOKEN COUNT (3 — what a 2.5 HBD face costs at the seeded
  // 1200 rate), not an HBD amount, and field 5 is the platform's slice OF those
  // credits (OWNER RULING 2026-09-12), not a separate HBD leg.
  gql.seed(chEscrow('alice', 0), 'hive:bob|3|5500000|ANSWERED|0|4900000|0|QmContentHash123|QmAnswerHash');
  gql.seed(chEscrow('alice', 1), 'hive:bob|3|100000|RECLAIMED|0|4900000|0|QmContentHash123|');
  // Seq 2 is PENDING and is what the journey DECLINES. It used to decline seq 0,
  // on the reasoning that the broadcaster never executes so only the OP was
  // being captured — true until decline grew its own confirmation, which now
  // reads seq 0 back as ANSWERED and refuses. A decline needs a PENDING escrow
  // of its own, and the capture flips it below exactly as the chain would.
  gql.seed(chEscrow('alice', 2), 'hive:bob|3|5500000|PENDING|0|4900000|0|QmContentHash123|');
  // One posted service, so the offering-targeted ask below prices against the
  // OFFERING's own price rather than kFace. 10.000 HBD in base units.
  //
  // ★ 200.000 -> 10.000 (2026-09-12). The WHOLE posted price is priced in tokens
  // now (OWNER RULING), not an 88% token leg, so a 200 HBD offering costs
  // ceil(200000/1200) = 167 credits and trips BOTH of settlement's C2 guards at
  // this fixture's supply: the depth ceiling (50% of area(200) = 182,670, which
  // the old 176,000 token leg squeaked under) and the 5%-of-supply spend cap
  // (10 credits). 10 HBD costs 9 credits and clears both with room.
  gql.seed(chOfferPrice('alice', 0, 1), '10000');

  // THE REAL DATA SOURCE — not the mock. Both deps injected via the real ctor.
  // The chain "executes" what the capture records: a register advances
  // kRegisteredAt (what registerMarket polls for), and every tx reads back
  // CONFIRMED (what awaitExecution polls for, via the injection point the data
  // source exposes precisely for a Node caller). Without these two the journey
  // cannot get past its first call — see FakeGql.advance's doc.
  capture.onExecuted = (action) => {
    // +1, NOT the head: the LONG TWAP ring drops every observation before
    // kRegisteredAt (twap.go askRateLong's epoch filter), so advancing this to
    // "now" would orphan the seeded price history and every ask would refuse
    // with insufficient_observations. An advance of one block is all
    // awaitRegisteredAdvance asks for, and it leaves the history intact.
    if (action === 'register') gql.advance(chM('alice', 'reg'), '4000001');
    if (action === 'decline') gql.advance(chEscrow('alice', 2), 'hive:bob|3|5500000|DECLINED|0|4900000|0|QmContentHash123|');
  };
  const ds = new VscCreatorTokensDataSource({
    config,
    gql,
    broadcaster: capture.broadcast,
    txStatusReader: async () => 'CONFIRMED'
  });

  section('Journey: register -> renew -> setFace -> setCap -> buy -> sell -> ask -> answer -> reclaim -> retire -> transfer -> decline -> the offerings shop');

  // ★ CURVE-PIVOT REWRITE (2026-07-24): prepay()/transferCredits() are GONE
  // (core/prepay.go deleted). buy()/sell() are the curve rails; retire() is
  // new (RULING D/K3). refund()/refundHolder() are the WIND-DOWN rail and
  // are deliberately NOT exercised in THIS journey — this harness's FakeGql
  // is 100% static (CapturingBroadcaster never executes an op, so no prior
  // call in this sequence ever mutates `gql`'s state), so `retire()` here
  // cannot actually flip THIS market into wind-down for a later refund() call
  // to observe. They get their own dedicated, pre-seeded-as-wound-down
  // section below ("wind-down rail") instead — testing them against a market
  // that is ACTUALLY frozen, not merely "retire() was called at some earlier
  // line".
  await ds.registerMarket({ creator: 'alice', faceHbd: 2.5, capTokens: 1000 });
  await ds.setFace({ creator: 'alice', newFaceHbd: 3.0 });
  await ds.setCap({ creator: 'alice', newCapTokens: 2000 });
  await ds.buy({ creator: 'alice', buyer: 'bob', tokens: 5 });
  await ds.sell({ creator: 'alice', seller: 'bob', tokens: 5 });
  await ds.ask({ creator: 'alice', asker: 'bob', contentHash: 'QmContentHash123', deadlineBlocks: 28_800, maxCreditsBaseUnits: 10_000 });
  await ds.answer({ creator: 'alice', seq: 0, answerHash: 'QmAnswerHash', deadlineBlock: 5_500_000 });
  await ds.reclaim({ creator: 'alice', seq: 1, asker: 'bob', deadlineBlock: 100_000 });
  await ds.retire({ creator: 'alice' });
  await ds.transferTokens({ creator: 'alice', from: 'bob', to: 'carol', tokens: 5 });

  // The anti-grief rail and the offerings shop (wired client-side 2026-07-28).
  // Driven HERE, through the real data source, specifically so their payloads
  // land in the golden fixture file and get parsed by the contract's OWN Go
  // parser below — the shop's `price`/`offeringId` are UNQUOTED numbers while
  // every other money field is a quoted string, which is exactly the kind of
  // asymmetry a hand-written assertion gets wrong and a real cross-check does
  // not. Decline uses seq 0, whose seeded escrow is ANSWERED — irrelevant
  // here: this harness's broadcaster never executes, so what is being captured
  // is the OP, and decline's only client-side gate is the answer window.
  // A SECOND ask, this one naming a shop offering, so BOTH wire shapes reach
  // the Go parser: offeringId omitted (the legacy face price) and offeringId
  // present as an UNQUOTED integer. Proving only the omitted form would leave
  // the entire shop's purchase path uncross-checked.
  await ds.ask({ creator: 'alice', asker: 'bob', contentHash: 'QmContentHash123', deadlineBlocks: 28_800, maxCreditsBaseUnits: 10_000, offeringId: 1 });
  await ds.decline({ creator: 'alice', seq: 2, deadlineBlock: 5_500_000 });
  // The buyer's rating — the only recourse against a creator who marks a job
  // delivered without delivering it, so its payload must be cross-checked like
  // any money op.
  await ds.rate({ creator: 'alice', rater: 'bob', seq: 0, score: 5 });
  await ds.createOffering({ creator: 'alice', title: '15-minute call', priceHbd: 200 });
  await ds.setOfferingPrice({ creator: 'alice', offeringId: 1, newPriceHbd: 250 });
  await ds.setOfferingTitle({ creator: 'alice', offeringId: 1, title: '20-minute call' });
  await ds.deleteOffering({ creator: 'alice', offeringId: 1 });
  // The creator's own trade-fee withdrawal. Driven here purely so its op
  // reaches the golden + auth-tier fixture file: it is a gated write
  // (main.go:1446-1449) whose auth tier was otherwise cross-checked by
  // nothing. Reads the accrued balance first (unseeded -> 0), then emits.
  await ds.claimTradeFees({ account: 'alice' });

  const expectedActions = [
    'register',
    'setFace',
    'setCap',
    'buy',
    'sell',
    'ask',
    'answer',
    'reclaim',
    'retire',
    'transfer',
    'decline',
    'rate',
    'createOffering',
    'setOfferingPrice',
    'setOfferingTitle',
    'deleteOffering',
    'claimTradeFees'
  ];
  // One op per action plus one: `ask` is driven twice, with and without an
  // offeringId (see above).
  eq(`journey captured all ${expectedActions.length} write actions (ask twice)`, capture.ops.length, expectedActions.length + 1);
  for (const a of expectedActions) check(`captured op for action "${a}"`, capture.byAction(a) !== undefined);

  // ------------------------------------------------------------------
  // C1 — client auth: every write is ACTIVE-signed, never posting-signed.
  // ------------------------------------------------------------------
  section('C1 (client auth) — every write carries active auth (required_auths), no posting auth');
  for (const { action, op } of capture.ops) {
    check(`${action}: required_auths non-empty (active auth)`, op.required_auths.length > 0, `required_auths=${JSON.stringify(op.required_auths)}`);
    check(`${action}: required_posting_auths empty (no posting-signed write)`, op.required_posting_auths.length === 0, `required_posting_auths=${JSON.stringify(op.required_posting_auths)}`);
    eq(`${action}: op id is vsc.call`, op.id, VSC_CALL_ID);
  }

  // ------------------------------------------------------------------
  // C1 (derived) — the auth tier is read OUT OF contract/main.go, never
  // restated here.
  //
  // The block above proves every captured op carries active auth. It does not
  // prove that active auth is what the CONTRACT actually demands — both sides
  // could drift together, and a hand-maintained list of "actions needing
  // active auth" is exactly what did drift: WRITE_ACTIONS_REQUIRING_ACTIVE_AUTH
  // sat at 18 entries while the client had grown to 24 write actions, so
  // assertAuthContract returned CLEAN for decline, rate and all four offerings
  // -shop writes (fixed 2026-07-29, see payload-contract.ts's own note).
  //
  // So this section derives the requirement from the contract's SOURCE, the
  // same idiom as creator-tokens/keeper/wire_test.go's
  // TestBuildOp_AuthTierMatchesWhatTheContractDemands: find each
  // `//go:wasmexport <name>` region in main.go and ask whether that region
  // calls requireActiveAuth(. Deliberately conditional, never hardcoded — if
  // a future change genuinely removes the gate from an entrypoint, this stops
  // demanding active auth for it rather than failing for the wrong reason.
  //
  // The wasm wrapper cannot be compiled or executed by any native toolchain
  // (it imports the TinyGo-only sdk), so a source-presence check is the only
  // guard available on this seam. Its Go-side counterpart, which re-derives
  // the same set and checks it against the fixtures this file writes, is
  // creator-tokens/contract/parse/auth_tier_crosscheck_test.go.
  // ------------------------------------------------------------------
  section('C1 (derived) — auth tier read out of contract/main.go, not restated');
  {
    const gated = gatedEntrypointsFromContractSource();
    check(
      'contract/main.go is readable and declares wasm entrypoints',
      gated !== null,
      `set CREATOR_TOKENS_CONTRACT_MAIN if the contract is not at ${DEFAULT_CONTRACT_MAIN}`
    );
    if (gated) {
      check('main.go declares a plausible number of entrypoints (>= 20)', gated.all.size >= 20, `found ${gated.all.size}`);

      // 1. Every action this client actually emitted must BE an entrypoint,
      //    and must be one the contract gates on active auth.
      for (const { action } of capture.ops) {
        check(`${action}: is a real //go:wasmexport in main.go`, gated.all.has(action));
        check(
          `${action}: contract gates it on requireActiveAuth — so the op must carry active auth`,
          gated.active.has(action),
          'if the contract genuinely dropped the gate, drop it from ACTION_PAYLOAD_SPECS too'
        );
      }

      // 2. The tripwire list must COVER every gated entrypoint a client can
      //    reach. This is the check that would have caught the six-action blind
      //    spot the moment the shop was added on chain.
      //
      // ★★★ "REACHABLE" IS DERIVED, NOT LISTED (2026-09-12). This used to
      // exclude exactly one name, `init`, and demand coverage of everything
      // else — which made it FAIL on five entrypoints the contract gates and
      // this client has never had a builder for: acceptOwnership, approve,
      // changeOwner, graduate and safeTransferFrom. Adding them to
      // ACTION_PAYLOAD_SPECS to silence it would have been worse than the
      // failure: the spec table is what every outgoing payload is validated
      // against, and inventing a shape for a write nobody builds is a
      // fabrication that the next reader would trust.
      //
      // So reachability is now MEASURED on the client's own source: an
      // entrypoint is reachable iff its name appears as a quoted action string
      // somewhere in this feature outside the test files. The moment a builder
      // for one of them is written, the string lands in the source, the
      // entrypoint becomes reachable, and this check demands its coverage —
      // which is exactly the tripwire the old hardcoded exclusion was
      // pretending to be.
      const clientActionNames = clientActionStringsFromSource();
      check('the client source scan found something to scan', clientActionNames !== null && clientActionNames.size >= 10,
        `${clientActionNames?.size ?? 0} quoted action names found under features/creator-tokens`);
      const covered = new Set(WRITE_ACTIONS_REQUIRING_ACTIVE_AUTH);
      // Reachable = the client has a payload spec for it (so a builder can be
      // called today), OR its name appears as a quoted action string in the
      // feature's source (so one is being wired). A spec-carrying action counts
      // as reachable even when its name never appears in quotes, because
      // ACTION_PAYLOAD_SPECS writes them as bare object keys — `pause: {…}`.
      const reachable = [...gated.active]
        .filter((a) => a !== 'init' && (covered.has(a) || clientActionNames === null || clientActionNames.has(a)))
        .sort();
      const unreachable = [...gated.active].filter((a) => a !== 'init' && !reachable.includes(a)).sort();
      const uncovered = reachable.filter((a) => !covered.has(a));
      check(
        'WRITE_ACTIONS_REQUIRING_ACTIVE_AUTH covers every active-gated entrypoint this client can reach',
        uncovered.length === 0,
        uncovered.length > 0
          ? `NOT covered: ${uncovered.join(', ')} — assertAuthContract silently returns clean for these, so the posting-auth tripwire is blind on them`
          : ''
      );
      // And the exclusion is stated rather than assumed: these are gated on
      // chain, have no builder here, and would become a failure above the day
      // one is written.
      check(
        `the entrypoints left out are genuinely unreachable from this client (${unreachable.join(', ') || 'none'})`,
        unreachable.every((a) => !covered.has(a)),
        'an action cannot be both unreachable and in the tripwire list'
      );

      // 3. And the reverse: nothing in the tripwire list may name an action
      //    the contract does not gate (a stale entry pointing at a deleted or
      //    downgraded entrypoint would be a false sense of coverage).
      const phantom = [...covered].filter((a) => !gated.active.has(a));
      check(
        'WRITE_ACTIONS_REQUIRING_ACTIVE_AUTH names no action main.go does not gate',
        phantom.length === 0,
        phantom.length > 0 ? `phantom entries: ${phantom.join(', ')}` : ''
      );
    }
  }

  // ------------------------------------------------------------------
  // Free-form commitment strings — bound DERIVED from core/params.go.
  //
  // contentHash and answerHash are the only fields on this contract a user
  // types directly, and core/ask.go refuses three shapes: empty, longer than
  // MaxHashLen, or containing '|'. None of the three was checked client-side
  // until 2026-07-29, so a creator pasting a long delivery link — exactly what
  // the answer box's own placeholder asks for — signed with their ACTIVE key,
  // paid resource credits, broadcast, and the escrow silently did not release.
  //
  // MAX_HASH_LEN is a TS mirror of a Go constant, which is the shape that
  // always drifts, so it is READ from core/params.go rather than trusted.
  // ------------------------------------------------------------------
  section('hash fields — MAX_HASH_LEN derived from core/params.go, and all three bounds enforced');
  {
    const declared = maxHashLenFromContractSource();
    check(
      'core/params.go is readable and declares MaxHashLen',
      declared !== null,
      `set CREATOR_TOKENS_CORE_PARAMS if the contract is not at ${DEFAULT_CORE_PARAMS}`
    );
    if (declared !== null) {
      eq('MAX_HASH_LEN matches core/params.go MaxHashLen', MAX_HASH_LEN, declared);
    }

    // ★★★ EVERY NUMERIC MIRROR, NOT JUST THE ONE THAT BIT US. MIN_FACE_BASE_UNITS
    // sat at 577 for a whole session after core/params.go reverted MinFace to
    // 508 (the commission gross-up was removed on 2026-09-12), so this client
    // refused a posted price in 508-576 that the chain would have accepted. It
    // failed CLOSED, which is the safe direction and exactly why nothing caught
    // it. Each pair below is read out of the Go source at run time; a mirror
    // that cannot be found in params.go is reported as unverified rather than
    // passed over.
    for (const [tsName, tsValue, goName] of [
      ['MIN_FACE_BASE_UNITS', MIN_FACE_BASE_UNITS, 'MinFace'],
      ['MAX_FACE_BASE_UNITS', MAX_FACE_BASE_UNITS, 'MaxFace'],
      ['TRADE_FEE_BPS', TRADE_FEE_BPS, 'TradeFeeBps'],
      ['MAX_EXIT_TAX_BPS', MAX_EXIT_TAX_BPS, 'MaxExitTaxBps'],
      ['COMMISSION_BPS', COMMISSION_BPS, 'CommissionBps'],
      ['BLOCKS_PER_DAY', BLOCKS_PER_DAY, 'BlocksPerDay'],
      ['MIN_CAP_CREDITS_BASE_UNITS', MIN_CAP_CREDITS_BASE_UNITS, 'MinCap'],
      ['MAX_CAP_CREDITS_BASE_UNITS', MAX_CAP_CREDITS_BASE_UNITS, 'MaxCap']
    ] as Array<[string, number, string]>) {
      const go = paramFromContractSource(goName);
      check(
        `${tsName} mirrors core/params.go ${goName}`,
        go !== null && go === tsValue,
        go === null ? `${goName} not found in params.go - mirror UNVERIFIED` : `client ${tsValue} vs contract ${go}`
      );
    }
    const tooLong = 'a'.repeat(MAX_HASH_LEN + 1);
    await expectReject('ask() rejects a contentHash over MaxHashLen before signing', () => ds.ask({ creator: 'alice', asker: 'bob', contentHash: tooLong, deadlineBlocks: 28_800, maxCreditsBaseUnits: 10_000 }), 'at most');
    // The pipe guard already lived at the data source (vsc-data-source.ts:1176,
    // :1264) before this section existed; op-builders now repeats it one layer
    // deeper, for any caller that reaches the builders directly. The LENGTH
    // bound is the one that was genuinely missing at every layer.
    await expectReject('ask() rejects a contentHash containing a pipe', () => ds.ask({ creator: 'alice', asker: 'bob', contentHash: 'ref|1', deadlineBlocks: 28_800, maxCreditsBaseUnits: 10_000 }), "must not contain '|'");
    await expectReject('answer() rejects an answerHash over MaxHashLen before signing', () => ds.answer({ creator: 'alice', seq: 0, answerHash: tooLong, deadlineBlock: 5_500_000 }), 'at most');
    await expectReject('answer() rejects an answerHash containing a pipe', () => ds.answer({ creator: 'alice', seq: 0, answerHash: 'sent|by email', deadlineBlock: 5_500_000 }), "must not contain '|'");
    // Exactly at the cap is LEGAL — core/ask_test.go:1297-1306 pins this on the
    // Go side, so an off-by-one here would reject what the chain accepts.
    let atCapOk = true;
    try {
      assertHashField('answerHash', 'a'.repeat(MAX_HASH_LEN));
    } catch {
      atCapOk = false;
    }
    check('a hash field of EXACTLY MaxHashLen is accepted (no off-by-one)', atCapOk);
  }

  // ------------------------------------------------------------------
  // Payload / serialization snapshot — field names + string-vs-number types,
  // asserted against ACTION_PAYLOAD_SPECS (the ground-truth contract), and
  // the exact JSON string printed for the snapshot record.
  // ------------------------------------------------------------------
  section('payload/serialization — exact JSON + field-name/type snapshot per action');
  for (const { action, payload, payloadJson } of capture.ops) {
    console.log(`  ${action}: ${payloadJson}`);
    const spec = ACTION_PAYLOAD_SPECS[action];
    check(`${action}: spec exists`, spec !== undefined);
    if (!spec) continue;
    // ★ CURVE-PIVOT FIX: the pivot's OPTIONAL fields (register.firstBuy,
    // sell.minNet, refund.minNet — ActionPayloadSpec's OptionalFieldSpec
    // shape, payload-contract.ts) may be a bare JsonFieldType string OR
    // { type, optional: true }. The pre-pivot version of this loop assumed
    // every spec value was a bare string and required an EXACT payload/spec
    // key-set match — both assumptions broke the instant any spec gained an
    // optional field: an absent optional key (the legal, common case — see
    // op-builders.ts's own "omit the key entirely to mean absent" doc) made
    // the exact-match `eq` below fail every time, and the per-field loop's
    // `kind === 'number'/'string'` comparison against an OptionalFieldSpec
    // OBJECT never matched either branch, mis-classifying it as moneyString
    // and asserting `typeof undefined === 'string'` — a guaranteed failure on
    // literally the first optional-field payload this harness ever captured.
    const specEntries = Object.entries(spec);
    const requiredKeys = specEntries.filter(([, rawKind]) => typeof rawKind === 'string' || rawKind.optional !== true).map(([k]) => k).sort();
    const allSpecKeys = new Set(specEntries.map(([k]) => k));
    const payloadKeys = Object.keys(payload).sort();
    for (const k of requiredKeys) check(`${action}: required key "${k}" present in payload`, payloadKeys.includes(k));
    for (const k of payloadKeys) check(`${action}: payload key "${k}" is declared in spec`, allSpecKeys.has(k));
    for (const [field, rawKind] of specEntries) {
      const optional = typeof rawKind !== 'string' && rawKind.optional === true;
      if (!(field in payload)) {
        // Legal for an optional field (main.go's own `if raw != ""` branch);
        // a MISSING required field already failed the requiredKeys check above.
        if (!optional) continue;
        continue;
      }
      const kind = typeof rawKind === 'string' ? rawKind : rawKind.type;
      const value = payload[field];
      if (kind === 'number') {
        check(`${action}.${field}: bare JSON number`, typeof value === 'number', `got ${typeof value} (${JSON.stringify(value)})`);
      } else if (kind === 'string') {
        check(`${action}.${field}: quoted JSON string`, typeof value === 'string', `got ${typeof value} (${JSON.stringify(value)})`);
      } else {
        // moneyString: quoted string that is a bare non-negative base-10 integer.
        const ok = typeof value === 'string' && /^[0-9]+$/.test(value);
        check(`${action}.${field}: quoted base-10 integer money string`, ok, `got ${typeof value} (${JSON.stringify(value)})`);
      }
    }
  }

  // ------------------------------------------------------------------
  // C3 — identity namespace: client builds hive:-prefixed keys.
  // ------------------------------------------------------------------
  section('C3 (namespace) — client key-builder produces hive:-prefixed keys; bare keys read null');
  eq('kRegisteredAt("alice") is hive:-prefixed', kRegisteredAt('alice'), 'm|hive:alice|reg');
  eq('kBal("alice","bob") is hive:-prefixed', kBal('alice', 'bob'), 'mb|hive:alice|hive:bob');
  eq('kEscrow("alice",7) is hive:-prefixed', kEscrow('alice', 7), 'e|hive:alice|7');
  eq('kSeq("alice") is hive:-prefixed', kSeq('alice'), 'm|hive:alice|seq');
  eq('toDid("alice") prefixes', toDid('alice'), 'hive:alice');
  eq('toDid already-prefixed is idempotent', toDid('hive:alice'), 'hive:alice');

  // Positive: a market seeded at literal m|hive:alice|reg is FOUND.
  {
    const g = new FakeGql(HEAD);
    seedActiveMarket(g, 'alice');
    const market = await ds2Read(g, 'alice');
    check('market at m|hive:alice|reg is found (fix holds)', market !== null && market.registeredAtBlock === 4_000_000, `market=${JSON.stringify(market && { reg: market.registeredAtBlock, phase: market.phase })}`);
    check('client queried the hive:-prefixed reg key', g.allQueriedKeys().includes('m|hive:alice|reg'));
    check('client did NOT query a bare reg key', !g.allQueriedKeys().includes('m|alice|reg'));
  }

  // Negative: a market that exists ONLY under the BARE key reads as null
  // ("never registered") — so a regression (bare-key client, or a bare-key
  // chain) is caught, never silently mis-read.
  {
    const gBare = new FakeGql(HEAD);
    gBare.seed('m|alice|reg', '4000000').seed('m|alice|face', '2500').seed('m|alice|pu', '6000000');
    const market = await ds2Read(gBare, 'alice');
    eq('bare-key-only market reads as null (regression caught)', market, null);
    check('bare key was seeded but never queried by the client', gBare.rawGet('m|alice|reg') === '4000000' && !gBare.allQueriedKeys().includes('m|alice|reg'));
  }

  // ------------------------------------------------------------------
  // dead broadcaster — a write with no broadcaster injected throws.
  // ------------------------------------------------------------------
  section('dead broadcaster — write with no broadcaster injected throws (guard documented)');
  {
    const g = new FakeGql(HEAD);
    seedActiveMarket(g, 'alice');
    const noBroadcaster = new VscCreatorTokensDataSource({ config, gql: g });
    await expectReject('registerMarket without broadcaster rejects', () => noBroadcaster.registerMarket({ creator: 'alice', faceHbd: 2.5, capTokens: 1000 }), 'no broadcaster wired');
    await expectReject('transferTokens without broadcaster rejects', () => noBroadcaster.transferTokens({ creator: 'alice', from: 'bob', to: 'carol', tokens: 5 }), 'no broadcaster wired');
  }

  // ------------------------------------------------------------------
  // Wind-down rail (refund.go/sell.go's rail switch) — refund()/refundHolder()
  // open ONLY once the market is actually winding down; sell()/refund() on
  // the WRONG rail both reject. Uses its OWN pre-seeded-as-FROZEN market: the
  // main journey's `ds`/`gql` above called retire() but this harness never
  // executes a broadcast (CapturingBroadcaster only records the op), so that
  // call could never have flipped `gql`'s own state — this section instead
  // seeds a market that IS ALREADY wound down, so refund()/refundHolder()
  // have a real rail to observe.
  // ------------------------------------------------------------------
  section('Wind-down rail — refund()/refundHolder() open once FROZEN; sell()/refund() reject on the wrong rail');
  const captureFrozen = new CapturingBroadcaster();
  {
    const gqlFrozen = new FakeGql(HEAD);
    const supplyTokens = 20;
    gqlFrozen
      .seed(chM('alice', 'reg'), '1000000')
      .seed(chM('alice', 'face'), '2000')
      .seed(chM('alice', 'fsa'), '1000000')
      .seed(chM('alice', 'cap'), '1000000')
      .seed(chM('alice', 'sup'), String(supplyTokens))
      .seed(chM('alice', 'res'), String(areaBaseUnits(supplyTokens)))
      // ★ RETIRED, not lapsed (2026-09-12). This seeded kPaidUntil far in the
      // past to reach a "natural" FROZEN. There is no subscription and no lapse
      // since the OWNER RULING (creator-tokens/core/params.go): the only road
      // into a wind-down is Retire, and kRetiredAt stores block+1 so a stored 0
      // can mean "never". 1,000,001 puts the retire at block 1,000,000, a long
      // way past its GraceBlocks notice by head 5,000,000.
      .seed(chM('alice', 'rat'), '1000001')
      .seed(chBal('alice', 'bob'), '20');
    const dsFrozen = new VscCreatorTokensDataSource({ config, gql: gqlFrozen, broadcaster: captureFrozen.broadcast, txStatusReader: async () => 'CONFIRMED' });

    await dsFrozen.refund({ creator: 'alice', holder: 'bob', tokens: 5 });
    check('refund() captured an op once the market is FROZEN', captureFrozen.byAction('refund') !== undefined);

    await dsFrozen.refundHolder({ creator: 'alice', holder: 'bob', caller: 'keeper' });
    check('refundHolder() captured an op once the market is FROZEN', captureFrozen.byAction('refundHolder') !== undefined);

    await expectReject('sell() rejects on the wind-down rail (FROZEN)', () => dsFrozen.sell({ creator: 'alice', seller: 'bob', tokens: 5 }), 'curve sell is closed while the market winds down');

    // The MAIN journey's market (`ds`/`gql`, seeded ACTIVE) never actually
    // wound down (see this section's own header note) — refund() there must
    // still reject, proving the two rails are genuinely gated on real chain
    // state, not merely on whichever write was called most recently client-side.
    await expectReject('refund() rejects while the market is ACTIVE (not winding down)', () => ds.refund({ creator: 'alice', holder: 'bob', tokens: 5 }), 'pro-rata refund opens only at wind-down');
  }

  // ------------------------------------------------------------------
  // RULING K3 — a RETIRED market closes BOTH new inflows AND the curve Sell
  // rail IMMEDIATELY, even during its still-nominally-OVERDUE 5-day notice
  // window (where naturalPhase alone would still read ACTIVE/OVERDUE and
  // canInflowOpen() would say "open"). This is the exact gap
  // contract-math.ts's canInflowOpen() cannot see on its own (it predates
  // RULING K3) — vsc-data-source.ts's buildMarket() ANDs retiredAtBlock ===
  // null on top of it; this section proves that AND is load-bearing.
  // ------------------------------------------------------------------
  section('RULING K3 — a retired market is neither buyable nor sellable during its OVERDUE notice');
  {
    const gqlRetired = new FakeGql(HEAD);
    seedActiveMarket(gqlRetired, 'alice'); // paidUntil far in the future -> naturalPhase alone reads ACTIVE
    // kRetiredAt stores block+1 (0 == never retired) — retired 1000 blocks
    // ago, well inside the 5-day (144,000-block) notice window.
    gqlRetired.seed(chM('alice', 'rat'), String(HEAD - 1_000 + 1));
    const dsRetired = new VscCreatorTokensDataSource({ config, gql: gqlRetired });

    const market = await dsRetired.readMarket('alice');
    check('retired market does NOT display as ACTIVE (Phase folds in the notice, market.go RULING D)', market !== null && market.phase === 'OVERDUE', `phase=${market?.phase}`);
    check('retired market reports the decoded retiredAtBlock', market !== null && market.retiredAtBlock === HEAD - 1_000, `retiredAtBlock=${market?.retiredAtBlock}`);
    check('retired market canBuy is false EVEN THOUGH phase reads only OVERDUE', market !== null && market.canBuy === false);
    check('retired market canAsk is false EVEN THOUGH phase reads only OVERDUE', market !== null && market.canAsk === false);

    await expectReject('quoteBuy() rejects on a retired (still-OVERDUE) market', () => dsRetired.quoteBuy('alice', 1), 'market inflow is not open');
    await expectReject(
      'quoteSell() rejects on a retired (still-OVERDUE) market — the CURVE rail is closed, not merely the inflow gate',
      () => dsRetired.quoteSell('alice', 'bob', 1),
      'curve sell is closed while the market winds down'
    );
  }

  // ------------------------------------------------------------------
  // Golden fixtures for the Go cross-check — write the captured payload JSON
  // strings + their spec-declared field kinds/expected values.
  // ------------------------------------------------------------------
  section('golden fixtures — write captured payloads for the Go contract/parse cross-check');
  // BOTH capture sets. refund/refundHolder are only reachable on a market
  // that is ALREADY wound down, so they are driven against their own
  // pre-seeded-FROZEN fixture above and their ops live in captureFrozen —
  // which used to be dropped on the floor here. golden_crosscheck_test.go's
  // own doc records the consequence: it deliberately excused refund and
  // refundHolder from its required-action list because 'neither currently
  // has a fixture'. They do now, and both are money paths.
  writeGoFixtures([...capture.ops, ...captureFrozen.ops]);
}

/** Construct a fresh data source over `g` (broadcaster not needed for reads) and readMarket. */
async function ds2Read(g: FakeGql, creator: string) {
  const ds = new VscCreatorTokensDataSource({ config, gql: g });
  return ds.readMarket(creator);
}

// ======================================================================
// 4b. Contract-source derivation — the auth tier is READ from main.go.
// ======================================================================

/**
 * Same absolute-path convention this file already uses for the fixture
 * output: the contract lives in a sibling repo directory, not inside the
 * frontend tree, so there is no relative path that is correct from both the
 * canon checkout and a developer's working copy. Override with
 * CREATOR_TOKENS_CONTRACT_MAIN.
 */
const DEFAULT_CONTRACT_MAIN = '/mnt/o/Lumen/creator-tokens/contract/main.go';

interface GatedEntrypoints {
  /** Every `//go:wasmexport <name>` in main.go. */
  all: Set<string>;
  /** The subset whose region calls requireActiveAuth(. */
  active: Set<string>;
}

/**
 * Parse main.go's `//go:wasmexport` directives and report which ones are
 * gated on requireActiveAuth. Returns null (rather than throwing) when the
 * contract source is not reachable, so the caller can report a NAMED
 * unverified check instead of the harness dying — a check that could not run
 * must never look like a check that passed.
 *
 * Region = from one `//go:wasmexport` directive to the next. That is exactly
 * how keeper/wire_test.go:122-132 slices it, and it is sound here for the
 * same reason: main.go declares each entrypoint's directive immediately above
 * its own func, and the auth gate is the third statement of every one of them.
 */
const DEFAULT_CORE_PARAMS = '/mnt/o/Lumen/creator-tokens/core/params.go';

/**
 * Read a `const <Name> <type> = N` integer out of core/params.go. Returns null
 * (never throws, never guesses) when the file is unreachable or the constant is
 * not declared in that exact shape, so the caller reports a named unverified
 * check rather than a silent pass.
 *
 * ★ GENERALISED 2026-09-12, AFTER A MIRROR DRIFTED THE OTHER WAY. Only
 * MaxHashLen was read here, and MIN_FACE_BASE_UNITS - a mirror of the same
 * file - sat at 577 for a whole session after params.go went back to 508,
 * refusing posted prices the chain would have taken. One constant being checked
 * and the rest being trusted is not a policy, it is an accident of which one
 * someone got burned by first.
 */
function paramFromContractSource(name: string): number | null {
  const path = process.env.CREATOR_TOKENS_CORE_PARAMS ?? resolve(DEFAULT_CORE_PARAMS);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  // Go writes big literals with underscores (`MaxFace int64 = 10_000_000`), so
  // the digit class has to admit them and they have to come back out before
  // Number() sees them. Reading 10_000_000 as "10" is exactly the kind of
  // half-working check that reports a drift that is not there and trains a
  // reader to ignore the row.
  const m = new RegExp(`^const\\s+${name}\\s+\\w+\\s*=\\s*([\\d_]+)`, 'm').exec(text);
  return m ? Number(m[1].replace(/_/g, '')) : null;
}

function maxHashLenFromContractSource(): number | null {
  return paramFromContractSource('MaxHashLen');
}

/**
 * Every quoted string in this feature's own source that names a contract
 * action, outside the test files. Used to decide whether an entrypoint the
 * contract gates is one this client can actually reach — see the C1 section.
 * Returns null if the feature directory cannot be read, in which case the
 * caller treats every entrypoint as reachable (the strict direction).
 */
function clientActionStringsFromSource(): Set<string> | null {
  const root = resolve(__dirname, '../../..');
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__e2e__' || entry.name === 'node_modules' || entry.name === 'mock') continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || entry.name.includes('.selftest.')) continue;
      const text = readFileSync(full, 'utf8');
      for (const m of text.matchAll(/['"`]([a-z][A-Za-z]{2,30})['"`]/g)) names.add(m[1]);
    }
  };
  try {
    walk(root);
  } catch {
    return null;
  }
  return names;
}

function gatedEntrypointsFromContractSource(): GatedEntrypoints | null {
  const path = process.env.CREATOR_TOKENS_CONTRACT_MAIN ?? resolve(DEFAULT_CONTRACT_MAIN);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const all = new Set<string>();
  const active = new Set<string>();
  const directive = /^\/\/go:wasmexport[ \t]+(\w+)[ \t]*$/gm;
  const marks: { name: string; at: number }[] = [];
  for (let m = directive.exec(text); m !== null; m = directive.exec(text)) {
    marks.push({ name: m[1], at: m.index });
    all.add(m[1]);
  }
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].at;
    const end = i + 1 < marks.length ? marks[i + 1].at : text.length;
    if (text.slice(start, end).includes('requireActiveAuth(')) active.add(marks[i].name);
  }
  return { all, active };
}

// ======================================================================
// 5. Golden fixtures writer — maps each captured payload to the Go
//    contract/parse assertions (Str/U64/BigDecimal), derived from the
//    ground-truth spec + the ACTUAL captured values.
// ======================================================================

type GoFieldKind = 'u64' | 'str' | 'money';

const SPEC_KIND_TO_GO: Record<JsonFieldType, GoFieldKind> = { number: 'u64', string: 'str', moneyString: 'money' };

interface GoFixtureField {
  name: string;
  kind: GoFieldKind;
  wantStr?: string; // for str/money
  wantU64?: number; // for u64
}

interface GoFixture {
  action: string;
  payload: string; // the exact JSON string the Go parser must accept
  fields: GoFixtureField[];
  /**
   * The op's ACTUAL Hive auth arrays, recorded so the Go side can re-derive
   * the requirement from contract/main.go and check it against what this
   * client really emitted — rather than either side restating it.
   * Consumed by contract/parse/auth_tier_crosscheck_test.go.
   */
  requiredAuths: string[];
  requiredPostingAuths: string[];
}

function writeGoFixtures(ops: CapturedOp[]): void {
  const fixtures: GoFixture[] = [];
  for (const { action, payload, payloadJson, op } of ops) {
    const spec = ACTION_PAYLOAD_SPECS[action];
    if (!spec) continue;
    const fields: GoFixtureField[] = [];
    for (const [name, rawKind] of Object.entries(spec)) {
      // A spec entry is either a bare JsonFieldType or an OptionalFieldSpec
      // ({ type, optional }) — the optional shape arrived with the curve
      // pivot (register.firstBuy, sell/refund.minNet).
      const kind = typeof rawKind === 'string' ? rawKind : rawKind.type;
      const goKind = SPEC_KIND_TO_GO[kind];
      // An OMITTED optional key must produce no fixture field at all —
      // String(undefined) would otherwise hand Go the literal "undefined".
      if (!(name in payload)) continue;
      const value = payload[name];
      if (goKind === 'u64') {
        fields.push({ name, kind: goKind, wantU64: typeof value === 'number' ? value : Number(value) });
      } else {
        fields.push({ name, kind: goKind, wantStr: String(value) });
      }
    }
    fixtures.push({
      action,
      payload: payloadJson,
      fields,
      requiredAuths: [...op.required_auths],
      requiredPostingAuths: [...op.required_posting_auths]
    });
  }

  // The contract repo moved (O:/CREATOR-TOKENS -> O:/Lumen/creator-tokens) and
  // this path was left pointing at the deleted folder, so the harness ran every
  // assertion green and then CRASHED on the write — meaning the Go golden
  // cross-check (contract/parse/golden_crosscheck_test.go) has been reading a
  // stale fixture file ever since, silently. Fixed 2026-07-28.
  const outPath = process.env.CREATOR_TOKENS_E2E_FIXTURES ?? resolve('/mnt/o/Lumen/creator-tokens/contract/parse/captured_payloads.json');
  const doc = {
    _comment: 'GENERATED by apps/blog/features/creator-tokens/lib/vsc/__e2e__/vsc-data-path.e2e.ts. The exact payload JSON strings the REAL frontend write path emits, plus each op\u2019s Hive auth arrays, for the Go cross-checks in contract/parse (golden_crosscheck_test.go and auth_tier_crosscheck_test.go). Regenerate by re-running the harness.',
    generatedAtUnixMs: Date.now(),
    fixtures
  };
  writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log(`  wrote ${fixtures.length} fixtures -> ${outPath}`);
}

// ======================================================================
// 6. Entry point.
// ======================================================================

run()
  .then(() => {
    console.log(`\n${'='.repeat(60)}`);
    if (failures.length === 0) {
      console.log(`ALL ${passes} ASSERTIONS PASSED`);
      process.exit(0);
    } else {
      console.log(`${passes} passed, ${failures.length} FAILED:`);
      for (const f of failures) console.log(`  - ${f}`);
      process.exit(1);
    }
  })
  .catch((err: unknown) => {
    console.error('\nHARNESS CRASHED (an unexpected throw in the data path):');
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
