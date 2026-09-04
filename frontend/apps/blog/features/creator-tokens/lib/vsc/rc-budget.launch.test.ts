/**
 * checkLaunchRcBudget (the one-signature launch RC pre-check) tests. Run:
 *   pnpm --filter @hive/blog exec ts-node --compilerOptions \
 *     '{"module":"commonjs","moduleResolution":"node"}' features/creator-tokens/lib/vsc/rc-budget.launch.test.ts
 *
 * The launch is one ATOMIC transaction whose ops charge RC cumulatively, so the
 * gate must cover the SUM (register + N x createOffering) against available RC,
 * then that sum + the first-buy HBD against balance. These pin the boundaries:
 * 1/2/3 offers, exact-RC, exact-balance, off-by-one on each side, the first-buy
 * leg, and — the safety property — unknown power NEVER blocks (like Buy).
 */
import { checkLaunchRcBudget, describeLaunchRcBudget, rcLimitForAction } from './rc-budget';

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
// BALANCE boundary WITH the first-buy leg: balance must cover rcNeeded + firstBuy.
// (RC ample so only the balance condition is under test.)
// ─────────────────────────────────────────────────────────────────────────────
{
  const rcNeeded = need(1);
  const firstBuy = 40_000; // 40 HBD first-buy leg, base units
  const rcAmple = rcNeeded + 1_000_000;
  const exactBal = checkLaunchRcBudget({ offerCount: 1, availableRc: rcAmple, balanceBaseUnits: rcNeeded + firstBuy, firstBuyHbdBaseUnits: firstBuy });
  check('exact-balance (rcNeeded + firstBuy) -> ok', exactBal.ok && exactBal.blocker === 'none');

  const belowBal = checkLaunchRcBudget({ offerCount: 1, availableRc: rcAmple, balanceBaseUnits: rcNeeded + firstBuy - 1, firstBuyHbdBaseUnits: firstBuy });
  check('one below (rcNeeded + firstBuy) -> not-enough-balance', !belowBal.ok && belowBal.blocker === 'not-enough-balance');
  check('not-enough-balance shortfall is exactly the gap', belowBal.addBaseUnits === 1);

  // The first-buy leg genuinely moves the balance requirement: the SAME balance
  // that is enough with no first buy is short once a first buy is added.
  const enoughNoBuy = checkLaunchRcBudget({ offerCount: 1, availableRc: rcAmple, balanceBaseUnits: rcNeeded, firstBuyHbdBaseUnits: 0 });
  const shortWithBuy = checkLaunchRcBudget({ offerCount: 1, availableRc: rcAmple, balanceBaseUnits: rcNeeded, firstBuyHbdBaseUnits: firstBuy });
  check('balance == rcNeeded is ok with no first buy', enoughNoBuy.ok);
  check('same balance is short once a first buy is added', !shortWithBuy.ok && shortWithBuy.blocker === 'not-enough-balance');
  check('the added shortfall equals the first-buy leg', shortWithBuy.addBaseUnits === firstBuy);
}

// ─────────────────────────────────────────────────────────────────────────────
// RC is checked BEFORE balance (a launch short on both reports the RC blocker).
// ─────────────────────────────────────────────────────────────────────────────
{
  const both = checkLaunchRcBudget({ offerCount: 2, availableRc: 0, balanceBaseUnits: 0, firstBuyHbdBaseUnits: 10_000 });
  check('short on both -> not-enough-rc first', !both.ok && both.blocker === 'not-enough-rc');
}

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
