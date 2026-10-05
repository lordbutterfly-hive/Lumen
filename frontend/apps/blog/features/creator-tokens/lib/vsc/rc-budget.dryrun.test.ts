/**
 * sizeRcLimitFromDryRun (rc_limit from a dry run of the exact call, 2026-10-05). Run:
 *   pnpm --filter @hive/blog exec ts-node --compilerOptions \
 *     '{"module":"commonjs","moduleResolution":"node"}' features/creator-tokens/lib/vsc/rc-budget.dryrun.test.ts
 *
 * Anchored on the mainnet failure that prompted it: a transfer declared 2,497
 * (the old 1,997 row x 1.25) and used 2,529, so it ran out of gas and moved
 * nothing. And on the lots term measured the same day: 3 lots to a wallet DID
 * used 7,221.
 */
import { NODE_MIN_RC_LIMIT, RC_SAFETY_MARGIN, rcLimitForAction, sizeRcLimitFromDryRun } from './rc-budget';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  // eslint-disable-next-line no-console
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  cond ? pass++ : fail++;
}

// The reported failure: declared 2,497, used 2,529, plenty of credit (28,027).
const reported = sizeRcLimitFromDryRun({ declared: 2_497, rcUsed: 2_529, availableRc: 28_027 });
check('the reported transfer is raised above what it uses', reported.kind === 'raise' && reported.rcLimit >= 2_529);
check('raised with the 25% margin', reported.kind === 'raise' && reported.rcLimit === Math.ceil(2_529 * RC_SAFETY_MARGIN));

// The new transfer row already clears a one-lot transfer to a Hive name.
check('the transfer row covers the reported one-lot transfer', rcLimitForAction('transfer') >= Math.ceil(2_529 * RC_SAFETY_MARGIN));
check('a one-lot transfer under the new row is kept', sizeRcLimitFromDryRun({ declared: rcLimitForAction('transfer'), rcUsed: 2_529, availableRc: 28_027 }).kind === 'keep');

// Three lots to a wallet DID: 7,221, beyond any fixed row.
const threeLots = sizeRcLimitFromDryRun({ declared: rcLimitForAction('transfer'), rcUsed: 7_221, availableRc: 28_027 });
check('three lots to a wallet DID are raised', threeLots.kind === 'raise' && threeLots.rcLimit === Math.ceil(7_221 * RC_SAFETY_MARGIN));

// Never declare more than the account has.
const tight = sizeRcLimitFromDryRun({ declared: 2_497, rcUsed: 2_529, availableRc: 2_800 });
check('capped at the available credit when the margin does not fit', tight.kind === 'raise' && tight.rcLimit === 2_800);
const exact = sizeRcLimitFromDryRun({ declared: 2_497, rcUsed: 2_529, availableRc: 2_529 });
check('exactly enough credit still sends', exact.kind === 'raise' && exact.rcLimit === 2_529);

// Cannot cover the call at all: stop before signing, name what to add.
const shortOf = sizeRcLimitFromDryRun({ declared: 2_497, rcUsed: 2_529, availableRc: 2_528 });
check('one credit short is refused before signing', shortOf.kind === 'short');
check('and names the amount to add for the margined limit', shortOf.kind === 'short' && shortOf.addBaseUnits === Math.ceil(2_529 * RC_SAFETY_MARGIN) - 2_528);

// Credit unknown: keep a limit that covers the cost, raise one that does not.
check('unknown credit, declared covers the cost: kept', sizeRcLimitFromDryRun({ declared: 3_000, rcUsed: 2_529, availableRc: null }).kind === 'keep');
const unknownRaise = sizeRcLimitFromDryRun({ declared: 2_497, rcUsed: 2_529, availableRc: null });
check('unknown credit, declared below the cost: raised', unknownRaise.kind === 'raise' && unknownRaise.rcLimit === Math.ceil(2_529 * RC_SAFETY_MARGIN));

// A cheap call never drops below the node's floor or below what was declared.
check('a cheap call is kept at its declared limit', sizeRcLimitFromDryRun({ declared: 178, rcUsed: 100, availableRc: 10_000 }).kind === 'keep');
const tiny = sizeRcLimitFromDryRun({ declared: 50, rcUsed: 10, availableRc: 10_000 });
check('the node floor still applies', tiny.kind === 'raise' && tiny.rcLimit === NODE_MIN_RC_LIMIT);

// eslint-disable-next-line no-console
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
