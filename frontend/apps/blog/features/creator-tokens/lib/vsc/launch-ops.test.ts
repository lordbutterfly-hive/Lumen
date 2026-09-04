/**
 * launch-ops (the one-signature launch bundle) tests. Run:
 *   pnpm --filter @hive/blog exec ts-node --compilerOptions \
 *     '{"module":"commonjs","moduleResolution":"node"}' features/creator-tokens/lib/vsc/launch-ops.test.ts
 *
 * These are the SECURITY tests for the launch bundle (build map §SECURITY):
 *   - the ops come out in order [register, offering1, offering2, ...];
 *   - the broadcast list matches the disclosed/configured launch 1:1 — no extra,
 *     injected, reordered or mutated op;
 *   - the first-buy HBD leg rides ONLY register, and is never duplicated onto an
 *     offering;
 *   - each op keeps its own rc_limit (register's vs createOffering's);
 *   - a bad offering (title/price the contract would reject) throws BEFORE
 *     anything could be broadcast (so it can never revert the atomic tx after a
 *     signature);
 *   - a mixed-signer bundle is refused (one Hive tx carries one signature).
 *
 * buildLaunchOps is exactly what vsc-data-source.ts's launchMarket broadcasts, so
 * asserting its output here IS asserting what gets signed and sent.
 */
import { buildLaunchOps, buildLaunchRegisterOp } from './launch-ops';
import { VSC_CALL_ID, type CustomJsonOp } from './op-builders';
import { rcLimitForAction } from './rc-budget';
import { humanToBaseUnits } from '../contract-math';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  // eslint-disable-next-line no-console
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  cond ? pass++ : fail++;
}
function throws(name: string, fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(name, threw);
}

const NET = 'vsc-mainnet';
const CONTRACT = 'vsc1CreatorTokensTest';
const CREATOR = 'hive:alice';

interface Body {
  net_id: string;
  contract_id: string;
  action: string;
  payload: Record<string, unknown>;
  rc_limit: number;
  intents: Array<{ type: string; args: Record<string, unknown> }>;
}
const body = (op: CustomJsonOp): Body => JSON.parse(op.json) as Body;

// ─────────────────────────────────────────────────────────────────────────────
// A configured launch: register (face $1, first buy 5 tokens) + 3 offerings.
// ─────────────────────────────────────────────────────────────────────────────
const configured = {
  netId: NET,
  contractId: CONTRACT,
  register: { creator: CREATOR, faceHbd: 1.0, capTokens: 1_000_000_000, firstBuyTokens: 5 },
  offerings: [
    { creator: CREATOR, title: 'One hour call', priceHbd: 5 },
    { creator: CREATOR, title: 'Portfolio review', priceHbd: 25 },
    { creator: CREATOR, title: 'Shoutout', priceHbd: 2.5 }
  ]
};

const ops = buildLaunchOps(configured);

// --- op order + count: [register, offering1, offering2, offering3] ---
check('bundle has exactly 1 register + N offerings (no extra/injected op)', ops.length === 1 + configured.offerings.length);
check('op 0 is register', body(ops[0]).action === 'register');
check('op 1 is createOffering', body(ops[1]).action === 'createOffering');
check('op 2 is createOffering', body(ops[2]).action === 'createOffering');
check('op 3 is createOffering', body(ops[3]).action === 'createOffering');

// --- disclosed == broadcast 1:1: offerings in the SAME order, titles/prices unmutated ---
check('offering op 1 title matches configured, in order', body(ops[1]).payload.title === 'One hour call');
check('offering op 2 title matches configured, in order', body(ops[2]).payload.title === 'Portfolio review');
check('offering op 3 title matches configured, in order', body(ops[3]).payload.title === 'Shoutout');
check('offering op 1 price is the configured price in base units', body(ops[1]).payload.price === humanToBaseUnits(5));
check('offering op 2 price is the configured price in base units', body(ops[2]).payload.price === humanToBaseUnits(25));
check('offering op 3 price is the configured price in base units', body(ops[3]).payload.price === humanToBaseUnits(2.5));

// --- register payload carries the disclosed face/cap/first-buy, nothing else injected ---
check('register face is the disclosed face in base units', body(ops[0]).payload.face === humanToBaseUnits(1.0));
check('register cap is the disclosed cap (raw token count, not base units)', body(ops[0]).payload.cap === 1_000_000_000);
check('register firstBuy is the disclosed first-buy token count (quoted string)', body(ops[0]).payload.firstBuy === '5');
check(
  'register payload has ONLY face/cap/firstBuy (no injected key)',
  JSON.stringify(Object.keys(body(ops[0]).payload).sort()) === JSON.stringify(['cap', 'face', 'firstBuy'])
);

// --- FIRST-BUY IS ON REGISTER ONLY, never duplicated onto an offering ---
const registerIntents = body(ops[0]).intents;
check('register carries the first-buy HBD leg (one transfer.allow intent)', registerIntents.length === 1 && registerIntents[0].type === 'transfer.allow');
check('register first-buy intent is an HBD leg', registerIntents[0]?.args?.token === 'hbd');
check('offering op 1 carries NO intent (first-buy not duplicated)', body(ops[1]).intents.length === 0);
check('offering op 2 carries NO intent', body(ops[2]).intents.length === 0);
check('offering op 3 carries NO intent', body(ops[3]).intents.length === 0);
check('no offering payload carries a firstBuy field', configured.offerings.every((_, i) => !('firstBuy' in body(ops[i + 1]).payload)));

// --- per-op rc_limit preserved (register's vs createOffering's) ---
check('register op declares register rc_limit', body(ops[0]).rc_limit === rcLimitForAction('register'));
check('offering op 1 declares createOffering rc_limit', body(ops[1]).rc_limit === rcLimitForAction('createOffering'));
check('offering op 2 declares createOffering rc_limit', body(ops[2]).rc_limit === rcLimitForAction('createOffering'));
check('register and offering rc_limits differ (each op keeps its own)', body(ops[0]).rc_limit !== body(ops[1]).rc_limit);

// --- every op is one active-authority vsc.call signed by the creator, no posting auth ---
check('every op has id vsc.call', ops.every((o) => o.id === VSC_CALL_ID));
check('every op requires the creator active authority', ops.every((o) => o.required_auths.length === 1 && o.required_auths[0] === CREATOR));
check('no op carries posting authority', ops.every((o) => o.required_posting_auths.length === 0));
check('every op targets the configured net + contract', ops.every((o) => body(o).net_id === NET && body(o).contract_id === CONTRACT));

// --- a plain registration (no first buy) has NO intent on register ---
const noFirstBuy = buildLaunchOps({
  netId: NET,
  contractId: CONTRACT,
  register: { creator: CREATOR, faceHbd: 1.0, capTokens: 1_000_000_000 },
  offerings: [{ creator: CREATOR, title: 'One hour call', priceHbd: 5 }]
});
check('register with no first buy carries NO intent', body(noFirstBuy[0]).intents.length === 0);
check('register with no first buy omits the firstBuy key', !('firstBuy' in body(noFirstBuy[0]).payload));

// --- rcLimit override applies to every op equally ---
const overridden = buildLaunchOps({ ...configured, rcLimit: 12345 });
check('rcLimit override is applied to every op', overridden.every((o) => body(o).rc_limit === 12345));

// --- buildLaunchRegisterOp reports the derived figures ---
const reg = buildLaunchRegisterOp({ netId: NET, contractId: CONTRACT, register: configured.register });
check('buildLaunchRegisterOp reports faceBaseUnits', reg.faceBaseUnits === humanToBaseUnits(1.0));
check('buildLaunchRegisterOp reports firstBuyTokens', reg.firstBuyTokens === 5);
check('buildLaunchRegisterOp reports a positive first-buy total due', reg.firstBuyTotalDueBaseUnits > 0);

// ─────────────────────────────────────────────────────────────────────────────
// NEGATIVE: a doomed op must throw BEFORE anything could be broadcast.
// ─────────────────────────────────────────────────────────────────────────────
throws('BLOCK an offering title with a comma (contract would reject -> would revert the whole launch)', () =>
  buildLaunchOps({
    netId: NET,
    contractId: CONTRACT,
    register: { creator: CREATOR, faceHbd: 1.0, capTokens: 1_000_000_000 },
    offerings: [
      { creator: CREATOR, title: 'ok title', priceHbd: 5 },
      { creator: CREATOR, title: 'Copy edit, 1k words', priceHbd: 5 } // comma -> validOfferTitle refuses
    ]
  })
);
throws('BLOCK an offering with a non-positive price', () =>
  buildLaunchOps({
    netId: NET,
    contractId: CONTRACT,
    register: { creator: CREATOR, faceHbd: 1.0, capTokens: 1_000_000_000 },
    offerings: [{ creator: CREATOR, title: 'free thing', priceHbd: 0 }]
  })
);
throws('BLOCK a mixed-signer bundle (one Hive tx = one signature)', () =>
  buildLaunchOps({
    netId: NET,
    contractId: CONTRACT,
    register: { creator: CREATOR, faceHbd: 1.0, capTokens: 1_000_000_000 },
    offerings: [{ creator: 'hive:mallory', title: 'ok title', priceHbd: 5 }]
  })
);
throws('BLOCK a register with no creator', () =>
  buildLaunchOps({
    netId: NET,
    contractId: CONTRACT,
    register: { creator: '', faceHbd: 1.0, capTokens: 1_000_000_000 },
    offerings: [{ creator: '', title: 'ok title', priceHbd: 5 }]
  })
);
throws('BLOCK a face out of range', () =>
  buildLaunchOps({
    netId: NET,
    contractId: CONTRACT,
    register: { creator: CREATOR, faceHbd: 0.0001, capTokens: 1_000_000_000 },
    offerings: [{ creator: CREATOR, title: 'ok title', priceHbd: 5 }]
  })
);
throws('BLOCK a first buy that exceeds the cap', () =>
  buildLaunchOps({
    netId: NET,
    contractId: CONTRACT,
    register: { creator: CREATOR, faceHbd: 1.0, capTokens: 10, firstBuyTokens: 11 },
    offerings: [{ creator: CREATOR, title: 'ok title', priceHbd: 5 }]
  })
);

// eslint-disable-next-line no-console
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
