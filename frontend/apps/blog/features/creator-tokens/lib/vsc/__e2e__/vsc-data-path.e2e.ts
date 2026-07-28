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

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { CreatorTokensConfig } from '../../creator-tokens-data-source';
import { VscCreatorTokensDataSource } from '../../vsc-data-source';
import { areaBaseUnits } from '../../contract-math';
import { CreatorTokensGqlClient, kBal, kEscrow, kRegisteredAt, kSeq, toDid } from '../reads';
import { ACTION_PAYLOAD_SPECS, type JsonFieldType } from '../payload-contract';
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

  broadcast = async (op: CustomJsonOp): Promise<string> => {
    const body = JSON.parse(op.json) as { action: string; payload: Record<string, unknown> };
    this.ops.push({ action: body.action, op, payloadJson: JSON.stringify(body.payload), payload: body.payload });
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
const chBal = (creator: string, holder: string): string => `bal|hive:${creator}|hive:${holder}`;
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
  const supplyTokens = 50;
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
  // ★ EIGHT fields (ask.go packEscrow, verified at source 2026-07-24):
  //   asker|credits|deadline|status|commissionHbd|acqBlock|contentHash|answerHash
  // These seeds carried the OLD seven-field layout (no acqBlock), which the
  // seven-field parser accepted by silently shifting contentHash into
  // answerHash. The parser now demands eight, so a stale seed fails to parse
  // outright — which is exactly the loud failure the old layout never gave.
  gql.seed(chEscrow('alice', 0), 'hive:bob|2500|5500000|ANSWERED|300|4900000|QmContentHash123|QmAnswerHash');
  gql.seed(chEscrow('alice', 1), 'hive:bob|2500|100000|RECLAIMED|300|4900000|QmContentHash123|');
  // One posted service, so the offering-targeted ask below prices against the
  // OFFERING's own price rather than kFace. 200.000 HBD in base units.
  gql.seed(chOfferPrice('alice', 0, 1), '200000');

  // THE REAL DATA SOURCE — not the mock. Both deps injected via the real ctor.
  const ds = new VscCreatorTokensDataSource({ config, gql, broadcaster: capture.broadcast });

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
  await ds.renewSubscription({ creator: 'alice', caller: 'alice', periods: 1 });
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
  await ds.decline({ creator: 'alice', seq: 0, deadlineBlock: 5_500_000 });
  // The buyer's rating — the only recourse against a creator who marks a job
  // delivered without delivering it, so its payload must be cross-checked like
  // any money op.
  await ds.rate({ creator: 'alice', rater: 'bob', seq: 0, score: 5 });
  await ds.createOffering({ creator: 'alice', title: '15-minute call', priceHbd: 200 });
  await ds.setOfferingPrice({ creator: 'alice', offeringId: 1, newPriceHbd: 250 });
  await ds.setOfferingTitle({ creator: 'alice', offeringId: 1, title: '20-minute call' });
  await ds.deleteOffering({ creator: 'alice', offeringId: 1 });

  const expectedActions = [
    'register',
    'renew',
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
    'deleteOffering'
  ];
  // 17 ops for 16 distinct actions: `ask` is driven twice, with and without an
  // offeringId (see above).
  eq('journey captured all 16 write actions (ask twice)', capture.ops.length, expectedActions.length + 1);
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
  eq('kBal("alice","bob") is hive:-prefixed', kBal('alice', 'bob'), 'bal|hive:alice|hive:bob');
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
  {
    const gqlFrozen = new FakeGql(HEAD);
    const captureFrozen = new CapturingBroadcaster();
    const supplyTokens = 20;
    gqlFrozen
      .seed(chM('alice', 'reg'), '1000000')
      .seed(chM('alice', 'face'), '2000')
      .seed(chM('alice', 'fsa'), '1000000')
      .seed(chM('alice', 'cap'), '1000000')
      .seed(chM('alice', 'sup'), String(supplyTokens))
      .seed(chM('alice', 'res'), String(areaBaseUnits(supplyTokens)))
      .seed(chM('alice', 'pu'), '2000000') // paidUntil(2,000,000) + GraceBlocks(144,000) << head(5,000,000) -> naturally FROZEN, not via Retire
      .seed(chBal('alice', 'bob'), '20');
    const dsFrozen = new VscCreatorTokensDataSource({ config, gql: gqlFrozen, broadcaster: captureFrozen.broadcast });

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
  writeGoFixtures(capture.ops);
}

/** Construct a fresh data source over `g` (broadcaster not needed for reads) and readMarket. */
async function ds2Read(g: FakeGql, creator: string) {
  const ds = new VscCreatorTokensDataSource({ config, gql: g });
  return ds.readMarket(creator);
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
}

function writeGoFixtures(ops: CapturedOp[]): void {
  const fixtures: GoFixture[] = [];
  for (const { action, payload, payloadJson } of ops) {
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
    fixtures.push({ action, payload: payloadJson, fields });
  }

  // The contract repo moved (O:/CREATOR-TOKENS -> O:/Lumen/creator-tokens) and
  // this path was left pointing at the deleted folder, so the harness ran every
  // assertion green and then CRASHED on the write — meaning the Go golden
  // cross-check (contract/parse/golden_crosscheck_test.go) has been reading a
  // stale fixture file ever since, silently. Fixed 2026-07-28.
  const outPath = process.env.CREATOR_TOKENS_E2E_FIXTURES ?? resolve('/mnt/o/Lumen/creator-tokens/contract/parse/captured_payloads.json');
  const doc = {
    _comment: 'GENERATED by apps/blog/features/creator-tokens/lib/vsc/__e2e__/vsc-data-path.e2e.ts. The exact payload JSON strings the REAL frontend write path emits, for the Go contract/parse golden cross-check (golden_crosscheck_test.go). Regenerate by re-running the harness.',
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
