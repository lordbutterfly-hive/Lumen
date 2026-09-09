/**
 * checkLaunchRcBudget (the one-signature launch RC pre-check) tests. Run:
 *   pnpm --filter @hive/blog exec ts-node --compilerOptions \
 *     '{"module":"commonjs","moduleResolution":"node"}' features/creator-tokens/lib/vsc/rc-budget.launch.test.ts
 *
 * The launch is one ATOMIC transaction whose ops charge RC cumulatively, so the
 * gate must cover the SUM (register + N x createOffering) against the credit
 * left after the first buy, then the first-buy HBD against balance (2026-09-09:
 * the balance is no longer asked to back the reservation, the node reserves
 * against credit, which for a Hive account includes 10,000 free). These pin the
 * boundaries: 1/2/3 offers, exact credit, exact first-buy balance, off-by-one on
 * each side, the first-buy leg, the reported Hive-account case, and, the safety
 * property, unknown power NEVER blocks (like Buy).
 */
import { HIVE_FREE_RC_BASE_UNITS, checkLaunchRcBudget, describeLaunchRcBudget, launchHbdToHold, rcLimitForAction } from './rc-budget';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  // eslint-disable-next-line no-console
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  cond ? pass++ : fail++;
}

const REG = rcLimitForAction('register');
const OFFER = rcLimitForAction('createOffering');
const need = (n: number) => REG + Math.max(1, n) * OFFER;

// ─────────────────────────────────────────────────────────────────────────────
// UNKNOWN POWER NEVER BLOCKS (the safety property — like Buy).
// ─────────────────────────────────────────────────────────────────────────────
check('null availableRc -> ok (unknown never blocks)', checkLaunchRcBudget({ offerCount: 2, availableRc: null, balanceBaseUnits: 5, firstBuyHbdBaseUnits: 0 }).ok);
check('null balance -> ok (unknown never blocks)', checkLaunchRcBudget({ offerCount: 2, availableRc: 5, balanceBaseUnits: null, firstBuyHbdBaseUnits: 0 }).ok);
check('both null -> ok', checkLaunchRcBudget({ offerCount: 3, availableRc: null, balanceBaseUnits: null }).ok);
check('both null -> blocker none', checkLaunchRcBudget({ offerCount: 3, availableRc: null, balanceBaseUnits: null }).blocker === 'none');

// ─────────────────────────────────────────────────────────────────────────────
// rcNeeded scales with the offer count (1 / 2 / 3), and register is always added.
// ─────────────────────────────────────────────────────────────────────────────
check('1 offer rcNeeded = register + 1 x offering', checkLaunchRcBudget({ offerCount: 1, availableRc: 0, balanceBaseUnits: 0 }).rcLimit === REG + OFFER);
check('2 offers rcNeeded = register + 2 x offering', checkLaunchRcBudget({ offerCount: 2, availableRc: 0, balanceBaseUnits: 0 }).rcLimit === REG + 2 * OFFER);
check('3 offers rcNeeded = register + 3 x offering', checkLaunchRcBudget({ offerCount: 3, availableRc: 0, balanceBaseUnits: 0 }).rcLimit === REG + 3 * OFFER);
check('0 offers is floored to 1 (a launch always carries at least one offering)', checkLaunchRcBudget({ offerCount: 0, availableRc: 0, balanceBaseUnits: 0 }).rcLimit === REG + OFFER);

// ─────────────────────────────────────────────────────────────────────────────
// EXACT-RC boundary: availableRc === rcNeeded passes; one below fails on RC.
// (balance ample so only the RC condition is under test.)
// ─────────────────────────────────────────────────────────────────────────────
{
  const rcNeeded = need(2);
  const ample = rcNeeded + 1_000_000;
  const exact = checkLaunchRcBudget({ offerCount: 2, availableRc: rcNeeded, balanceBaseUnits: ample, firstBuyHbdBaseUnits: 0 });
  check('exact-RC (availableRc === rcNeeded) -> ok', exact.ok && exact.blocker === 'none');

  const below = checkLaunchRcBudget({ offerCount: 2, availableRc: rcNeeded - 1, balanceBaseUnits: ample, firstBuyHbdBaseUnits: 0 });
  check('one below rcNeeded -> not-enough-rc', !below.ok && below.blocker === 'not-enough-rc');
  check('not-enough-rc shortfall is exactly the gap', below.addBaseUnits === 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FIRST-BUY LEG: credit must cover rcNeeded AFTER the first buy leaves the
// balance, and the balance must cover the first buy itself. The balance is NOT
// asked to back the reservation (that is what credit is for).
// ─────────────────────────────────────────────────────────────────────────────
{
  const rcNeeded = need(1);
  const firstBuy = 40_000; // 40 HBD first-buy leg, base units
  const exactCredit = checkLaunchRcBudget({ offerCount: 1, availableRc: rcNeeded + firstBuy, balanceBaseUnits: firstBuy, firstBuyHbdBaseUnits: firstBuy });
  check('exact credit (rcNeeded + firstBuy) with balance == firstBuy -> ok', exactCredit.ok && exactCredit.blocker === 'none');

  const belowCredit = checkLaunchRcBudget({ offerCount: 1, availableRc: rcNeeded + firstBuy - 1, balanceBaseUnits: firstBuy, firstBuyHbdBaseUnits: firstBuy });
  check('one credit below (rcNeeded + firstBuy) -> not-enough-rc', !belowCredit.ok && belowCredit.blocker === 'not-enough-rc');
  check('not-enough-rc shortfall with a first buy is exactly the gap', belowCredit.addBaseUnits === 1);

  const rcAmple = rcNeeded + 1_000_000;
  const belowBal = checkLaunchRcBudget({ offerCount: 1, availableRc: rcAmple, balanceBaseUnits: firstBuy - 1, firstBuyHbdBaseUnits: firstBuy });
  check('balance one below the first buy -> not-enough-balance', !belowBal.ok && belowBal.blocker === 'not-enough-balance');
  check('not-enough-balance shortfall is exactly the gap', belowBal.addBaseUnits === 1);

  // The first-buy leg genuinely moves the balance requirement: a balance that is
  // enough with no first buy is short once a first buy bigger than it is added.
  const enoughNoBuy = checkLaunchRcBudget({ offerCount: 1, availableRc: rcAmple, balanceBaseUnits: 1_000, firstBuyHbdBaseUnits: 0 });
  const shortWithBuy = checkLaunchRcBudget({ offerCount: 1, availableRc: rcAmple, balanceBaseUnits: 1_000, firstBuyHbdBaseUnits: firstBuy });
  check('a small balance is ok with no first buy', enoughNoBuy.ok);
  check('the same balance is short once a first buy is added', !shortWithBuy.ok && shortWithBuy.blocker === 'not-enough-balance');
  check('the shortfall equals the first buy minus the balance', shortWithBuy.addBaseUnits === firstBuy - 1_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE REPORTED CASE (2026-09-09): a Hive account holding 9.121 HBD on Magi with
// 17,351 credits (balance + 10,000 free, 1,770 frozen) launching one offer with
// no first buy. The chain reserves 16,941; the old gate demanded the HBD balance
// alone cover it and said "7.820 HBD short".
// ─────────────────────────────────────────────────────────────────────────────
{
  const reported = checkLaunchRcBudget({ offerCount: 1, availableRc: 17_351, balanceBaseUnits: 9_121, firstBuyHbdBaseUnits: 0 });
  check('reported Hive account (17,351 credits, 9.121 HBD, no first buy) -> ok', reported.ok && reported.blocker === 'none');
  check('reported case reserves register + 1 offering', reported.rcLimit === need(1));
  const walletDid = checkLaunchRcBudget({ offerCount: 1, availableRc: 9_121, balanceBaseUnits: 9_121, firstBuyHbdBaseUnits: 0 });
  check('a wallet DID with the same 9.121 HBD (no free credits) -> not-enough-rc', !walletDid.ok && walletDid.blocker === 'not-enough-rc');
}

// ─────────────────────────────────────────────────────────────────────────────
// RC is checked BEFORE balance (a launch short on both reports the RC blocker).
// ─────────────────────────────────────────────────────────────────────────────
{
  const both = checkLaunchRcBudget({ offerCount: 2, availableRc: 0, balanceBaseUnits: 0, firstBuyHbdBaseUnits: 10_000 });
  check('short on both -> not-enough-rc first', !both.ok && both.blocker === 'not-enough-rc');
}

// ─────────────────────────────────────────────────────────────────────────────
// launchHbdToHold: the number told to a creator BEFORE the strike. Same sum the
// gate reserves, less the free credit a Hive account gets, never negative.
// ─────────────────────────────────────────────────────────────────────────────
check('free credit constant matches the node (10,000)', HIVE_FREE_RC_BASE_UNITS === 10_000);
check('Hive, 1 offer, no first buy = need(1) - free', launchHbdToHold({ offerCount: 1, hiveAccount: true }) === need(1) - HIVE_FREE_RC_BASE_UNITS);
check('Hive, 2 offers = need(2) - free', launchHbdToHold({ offerCount: 2, hiveAccount: true }) === need(2) - HIVE_FREE_RC_BASE_UNITS);
check('Hive, 1 offer + 5 HBD first buy = need(1) + 5,000 - free', launchHbdToHold({ offerCount: 1, firstBuyHbdBaseUnits: 5_000, hiveAccount: true }) === need(1) + 5_000 - HIVE_FREE_RC_BASE_UNITS);
check('wallet DID, 1 offer = need(1) (no free credit)', launchHbdToHold({ offerCount: 1, hiveAccount: false }) === need(1));
check('0 offers floors to 1', launchHbdToHold({ offerCount: 0, hiveAccount: true }) === need(1) - HIVE_FREE_RC_BASE_UNITS);
check('the hold figure is what the gate accepts at exactly that balance (Hive, 2 offers)', checkLaunchRcBudget({ offerCount: 2, availableRc: launchHbdToHold({ offerCount: 2, hiveAccount: true }) + HIVE_FREE_RC_BASE_UNITS, balanceBaseUnits: launchHbdToHold({ offerCount: 2, hiveAccount: true }), firstBuyHbdBaseUnits: 0 }).ok);
check('one base unit under the hold figure is refused (Hive, 2 offers)', !checkLaunchRcBudget({ offerCount: 2, availableRc: launchHbdToHold({ offerCount: 2, hiveAccount: true }) + HIVE_FREE_RC_BASE_UNITS - 1, balanceBaseUnits: 0, firstBuyHbdBaseUnits: 0 }).ok);
check('the warning leads with the amount to add', /^Add [0-9.]+ HBD to your Magi balance/.test(describeLaunchRcBudget(checkLaunchRcBudget({ offerCount: 2, availableRc: 18_452, balanceBaseUnits: 8_452, firstBuyHbdBaseUnits: 0 })) ?? ''));

// ─────────────────────────────────────────────────────────────────────────────
// describeLaunchRcBudget: a remedy on a block, nothing when ok.
// ─────────────────────────────────────────────────────────────────────────────
check('describeLaunchRcBudget is null when ok', describeLaunchRcBudget({ ok: true, rcLimit: 1, blocker: 'none', addBaseUnits: 0 }) === null);
check(
  'describeLaunchRcBudget names an HBD amount on a shortfall',
  /\bHBD\b/.test(describeLaunchRcBudget({ ok: false, rcLimit: need(1), blocker: 'not-enough-rc', addBaseUnits: 12_345 }) ?? '')
);

// eslint-disable-next-line no-console
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
