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

const config: CreatorTokensConfig = {
  contractId: 'creator-tokens-e2e',
  netId: 'e2e-net',
  gqlUrl: 'e2e://unused',
  rcLimit: 30_000
};

const HEAD = 5_000_000;

/** Seed a healthy ACTIVE market for `creator`, using LITERAL hive: chain keys. */
function seedActiveMarket(gql: FakeGql, creator: string): void {
  gql
    .seed(chM(creator, 'reg'), '4000000') // registeredAt > 0
    .seed(chM(creator, 'face'), '2500') // 2.5 HBD
    .seed(chM(creator, 'fsa'), '4000000')
    .seed(chM(creator, 'fan'), '2500') // band anchor -> [1.25, 5.0] HBD
    .seed(chM(creator, 'faa'), '4000000')
    .seed(chM(creator, 'cap'), '1000000') // 1000 credits
    .seed(chM(creator, 'sup'), '0')
    .seed(chM(creator, 'res'), '0')
    .seed(chM(creator, 'pu'), '6000000'); // paidUntil > head -> ACTIVE
  // kState/paused deliberately unseeded: absent -> not CLOSED, not paused.
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
  gql.seed(chEscrow('alice', 0), 'hive:bob|2500|5500000|ANSWERED|300|QmContentHash123|QmAnswerHash');
  gql.seed(chEscrow('alice', 1), 'hive:bob|2500|100000|RECLAIMED|300|QmContentHash123|');

  // THE REAL DATA SOURCE — not the mock. Both deps injected via the real ctor.
  const ds = new VscCreatorTokensDataSource({ config, gql, broadcaster: capture.broadcast });

  section('Journey: register -> renew -> setFace -> setCap -> prepay -> ask -> answer -> reclaim -> refund -> refundHolder -> transfer');

  await ds.registerMarket({ creator: 'alice', faceHbd: 2.5, capCredits: 1000 });
  await ds.renewSubscription({ creator: 'alice', caller: 'alice', periods: 1 });
  await ds.setFace({ creator: 'alice', newFaceHbd: 3.0 });
  await ds.setCap({ creator: 'alice', newCapCredits: 2000 });
  await ds.prepay({ creator: 'alice', holder: 'bob', hbdAmount: 5 });
  await ds.ask({ creator: 'alice', asker: 'bob', contentHash: 'QmContentHash123', deadlineBlocks: 28_800, maxCreditsBaseUnits: 10_000 });
  await ds.answer({ creator: 'alice', seq: 0, answerHash: 'QmAnswerHash', deadlineBlock: 5_500_000 });
  await ds.reclaim({ creator: 'alice', seq: 1, asker: 'bob', deadlineBlock: 100_000 });
  await ds.refund({ creator: 'alice', holder: 'bob', credits: 1.5 });
  await ds.refundHolder({ creator: 'alice', holder: 'bob', caller: 'keeper' });
  await ds.transferCredits({ creator: 'alice', from: 'bob', to: 'carol', amount: 0.5 });

  const expectedActions = ['register', 'renew', 'setFace', 'setCap', 'prepay', 'ask', 'answer', 'reclaim', 'refund', 'refundHolder', 'transfer'];
  eq('journey captured all 11 write actions', capture.ops.length, expectedActions.length);
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
    const specKeys = Object.keys(spec).sort();
    const payloadKeys = Object.keys(payload).sort();
    eq(`${action}: field names exactly match spec`, payloadKeys.join(','), specKeys.join(','));
    for (const [field, kind] of Object.entries(spec)) {
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
    await expectReject('registerMarket without broadcaster rejects', () => noBroadcaster.registerMarket({ creator: 'alice', faceHbd: 2.5, capCredits: 1000 }), 'no broadcaster wired');
    await expectReject('transferCredits without broadcaster rejects', () => noBroadcaster.transferCredits({ creator: 'alice', from: 'bob', to: 'carol', amount: 0.5 }), 'no broadcaster wired');
  }

  // ------------------------------------------------------------------
  // H5 — PAR fallback: empty observation ring -> ask settles at PAR (does
  // NOT throw), and the maxCredits cap is STILL enforced.
  // ------------------------------------------------------------------
  section('H5 (PAR) — empty obs ring settles at PAR; maxCredits cap still enforced');
  {
    const g = new FakeGql(HEAD);
    const cap2 = new CapturingBroadcaster();
    seedActiveMarket(g, 'alice'); // obs ring deliberately absent (tw|hive:alice|n unseeded -> 0 observations)
    const dsPar = new VscCreatorTokensDataSource({ config, gql: g, broadcaster: cap2.broadcast });

    const quote = await dsPar.readQuote('alice');
    // AskRate refuses (0 observations); SettlementRate falls back to PAR, so a
    // price is STILL produced rather than a null that would brick ask().
    eq('quote oracleStatus reflects PAR fallback (insufficient_observations)', quote.oracleStatus, 'insufficient_observations');
    eq('quote still priced at PAR (creditsRequiredBaseUnits = face base units)', quote.creditsRequiredBaseUnits, 2500);
    check('quote.rate is non-null (PAR, not a bricking null)', quote.rate !== null, `rate=${JSON.stringify(quote.rate)}`);

    // ask() must NOT throw on the empty ring — it settles at PAR and broadcasts.
    let askThrew = false;
    try {
      await dsPar.ask({ creator: 'alice', asker: 'bob', contentHash: 'QmH5', deadlineBlocks: 28_800, maxCreditsBaseUnits: 10_000 });
    } catch {
      askThrew = true;
    }
    check('ask() with empty obs ring settles at PAR and does NOT throw', !askThrew);
    check('ask() at PAR actually broadcast an op', cap2.byAction('ask') !== undefined);

    // The "obvious fix must not disarm the maxCredits cap": a cap below the PAR
    // settlement price (2500) must still hard-block the ask.
    await expectReject('maxCredits cap still enforced at PAR (cap < settlement price)', () => dsPar.ask({ creator: 'alice', asker: 'bob', contentHash: 'QmH5b', deadlineBlocks: 28_800, maxCreditsBaseUnits: 2_000 }), 'exceeds maxCreditsBaseUnits');
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
    for (const [name, kind] of Object.entries(spec)) {
      const goKind = SPEC_KIND_TO_GO[kind];
      const value = payload[name];
      if (goKind === 'u64') {
        fields.push({ name, kind: goKind, wantU64: typeof value === 'number' ? value : Number(value) });
      } else {
        fields.push({ name, kind: goKind, wantStr: String(value) });
      }
    }
    fixtures.push({ action, payload: payloadJson, fields });
  }

  const outPath = process.env.CREATOR_TOKENS_E2E_FIXTURES ?? resolve('/mnt/o/CREATOR-TOKENS/contract/parse/captured_payloads.json');
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
