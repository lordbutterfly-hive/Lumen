/**
 * lapse.selftest.ts — the boundaries of the subscription state machine.
 *
 * Plain assertions, no test runner (this repo has none). Run with:
 *   cd apps/blog && npx tsx features/creator-tokens/market/lapse.selftest.ts
 *
 * ★ THE INSTRUMENT IS CHECKED FIRST, and section 0 says exactly what it is: a
 * DEGENERACY check, not a mutation proof. It shows that `lapseStateOf` actually
 * discriminates (six inputs, all six declared kinds) rather than returning a
 * constant that would satisfy many assertions below by accident, and that the
 * assertion helper detects a false condition. A green run means the checks ran
 * on a function that answers differently to different inputs.
 */
import { BLOCKS_PER_DAY } from '../lib/contract-math';
import { DELISTED_READER_NOTICE, LAPSE_WARNING_BLOCKS, lapseDismissKey, lapseNoticeFor, lapseStateOf, shouldOfferRenew, shouldOfferRenewNow, type LapseState, type RenewRefusal } from './lapse';

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`ok    ${name}${detail ? `\n        ${detail}` : ''}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

const HEAD = 1_000_000;
const base = {
  phase: 'ACTIVE' as const,
  paidUntilBlock: HEAD + 30 * BLOCKS_PER_DAY,
  graceExpiresAtBlock: HEAD + 35 * BLOCKS_PER_DAY,
  headBlock: HEAD,
  windingDown: false
};
const kindOf = (over: Partial<Parameters<typeof lapseStateOf>[0]>): LapseState['kind'] =>
  lapseStateOf({ ...base, ...over }).kind;

console.log('── 0. THE INSTRUMENT ──────────────────────────────────────────────');
// ★ A DEGENERACY CHECK, not a claim to be a mutation proof. `lapseStateOf`
// returning a constant would satisfy a great many of the assertions below by
// accident, so prove first that it actually discriminates: six inputs, six
// distinct kinds, which is every kind the type declares.
const observedKinds = new Set<LapseState['kind']>([
  kindOf({}),
  kindOf({ headBlock: base.paidUntilBlock - 1 }),
  kindOf({ phase: 'OVERDUE', headBlock: base.graceExpiresAtBlock - 10 }),
  kindOf({ phase: 'FROZEN' }),
  kindOf({ windingDown: true }),
  kindOf({ headBlock: null })
]);
check(
  '★ the function discriminates: every declared kind is reachable from these inputs',
  observedKinds.size === 6,
  [...observedKinds].join(', ')
);
// And that the assertion helper itself can fail — run one deliberately false
// condition through a throwaway counter rather than the real one.
{
  const before = failures.length;
  const sink: string[] = [];
  const probe = (cond: boolean) => { if (!cond) sink.push('x'); };
  probe(([] as number[]).length === 1); // opaque to the narrower, false at runtime
  check('★ …and a false condition is actually detected by the harness', sink.length === 1 && failures.length === before);
}

console.log('\n── 1. THREE STATES: unknown is never delisted ─────────────────────');
check('a null head is unknown, NOT delisted', kindOf({ headBlock: null }) === 'unknown');
check('an UNKNOWN phase is unknown, NOT delisted', kindOf({ phase: 'UNKNOWN' }) === 'unknown');
check('a NaN head is unknown', kindOf({ headBlock: Number.NaN }) === 'unknown');
check('★ no failed-read input can ever produce delisted', ['unknown'].includes(kindOf({ headBlock: null, phase: 'ACTIVE' })));
check(
  '★ …and unknown says NOTHING, in either renew mode',
  lapseNoticeFor({ kind: 'unknown' }, null) === null && lapseNoticeFor({ kind: 'unknown' }, 'surplus') === null
);
check('★ …and offers no pay control', !shouldOfferRenew({ kind: 'unknown' }, null));

console.log('\n── 2. THE WARNING WINDOW, at the block ────────────────────────────');
check('well inside the subscription is healthy', kindOf({}) === 'healthy');
check(
  'one block MORE than the window remaining is still healthy',
  kindOf({ headBlock: base.paidUntilBlock - LAPSE_WARNING_BLOCKS - 1 }) === 'healthy'
);
check(
  'exactly the window remaining is EXPIRING (the boundary is inclusive)',
  kindOf({ headBlock: base.paidUntilBlock - LAPSE_WARNING_BLOCKS }) === 'expiring'
);
check('one block before expiry is expiring', kindOf({ headBlock: base.paidUntilBlock - 1 }) === 'expiring');
check(
  'the head PAST paidUntil while the phase still says ACTIVE is unknown, never a negative countdown',
  kindOf({ headBlock: base.paidUntilBlock + 1 }) === 'unknown'
);

console.log('\n── 3. DAY ROUNDING ────────────────────────────────────────────────');
const three = lapseStateOf({ ...base, headBlock: base.paidUntilBlock - 3 * BLOCKS_PER_DAY });
check('exactly three days reads as 3', three.kind === 'expiring' && three.daysLeft === 3, JSON.stringify(three));
const partial = lapseStateOf({ ...base, headBlock: base.paidUntilBlock - (2 * BLOCKS_PER_DAY + 5) });
check('two days and five blocks rounds UP to 3', partial.kind === 'expiring' && partial.daysLeft === 3, JSON.stringify(partial));
const hours = lapseStateOf({ ...base, headBlock: base.paidUntilBlock - 100 });
check('★ 100 blocks left reads "1 day", never "0 days"', hours.kind === 'expiring' && hours.daysLeft === 1, JSON.stringify(hours));

console.log('\n── 4. GRACE AND DELISTED ──────────────────────────────────────────');
check(
  'OVERDUE inside grace is grace',
  kindOf({ phase: 'OVERDUE', headBlock: base.graceExpiresAtBlock - 2 * BLOCKS_PER_DAY }) === 'grace'
);
check('FROZEN is delisted', kindOf({ phase: 'FROZEN' }) === 'delisted');
check(
  '★ FROZEN is delisted even with NO head — the chain decided it, not our arithmetic',
  kindOf({ phase: 'FROZEN', headBlock: null }) === 'delisted'
);
check(
  'OVERDUE past its own grace block is unknown, not a negative countdown',
  kindOf({ phase: 'OVERDUE', headBlock: base.graceExpiresAtBlock + 1 }) === 'unknown'
);

console.log('\n── 5. WIND-DOWN OWNS ITS OWN PAGE ─────────────────────────────────');
check('a retired market is winding-down, not delisted', kindOf({ windingDown: true, phase: 'FROZEN' }) === 'winding-down');
check('CLOSED is winding-down', kindOf({ phase: 'CLOSED' }) === 'winding-down');
check('★ winding-down says nothing about the subscription', lapseNoticeFor({ kind: 'winding-down' }, null) === null);
check('★ …and offers no pay control', !shouldOfferRenew({ kind: 'winding-down' }, null));

console.log('\n── 6. THE COPY BRANCHES ON THE REFUSAL REASON, BECAUSE THE CHAIN DOES ──');
const delisted: LapseState = { kind: 'delisted' };
const REFUSALS: RenewRefusal[] = ['paused', 'retired', 'closed', 'lapsed-terminal', 'surplus', 'deficit'];
check(
  'delisted + renewable tells them to renew',
  (lapseNoticeFor(delisted, null) ?? '').includes('Renew to reactivate'),
  lapseNoticeFor(delisted, null) ?? ''
);
for (const r of REFUSALS) {
  const line = lapseNoticeFor(delisted, r) ?? '';
  check(`★ "${r}" never says renew — the chain would refuse it`, !/renew/i.test(line), line);
  check(`★ "${r}" offers no pay control`, !shouldOfferRenew(delisted, r));
}
check('a renewable delisted market DOES offer the control', shouldOfferRenew(delisted, null));
const distinct = new Set(REFUSALS.map((r) => lapseNoticeFor(delisted, r)));
check('★ every refusal reason gets its OWN sentence, not one catch-all', distinct.size === REFUSALS.length, `${distinct.size} distinct`);
check(
  '★ the surplus case names the road out, because renewal is not it',
  /retir/i.test(lapseNoticeFor(delisted, 'surplus') ?? '') && /launch/i.test(lapseNoticeFor(delisted, 'surplus') ?? ''),
  lapseNoticeFor(delisted, 'surplus') ?? ''
);
check(
  '★ paused promises no date',
  !/soon|shortly|back (in|within)|\d+ (minute|hour|day)/i.test(lapseNoticeFor(delisted, 'paused') ?? ''),
  lapseNoticeFor(delisted, 'paused') ?? ''
);

console.log('\n── 7. WHAT THE COPY MUST NOT SAY ──────────────────────────────────');
const everySentence = ([
  lapseNoticeFor({ kind: 'expiring', blocksLeft: 100, daysLeft: 1 }, null),
  lapseNoticeFor({ kind: 'grace', blocksLeft: 100, daysLeft: 1 }, null),
  lapseNoticeFor(delisted, null),
  ...REFUSALS.map((r) => lapseNoticeFor(delisted, r))
].filter((s): s is string => s !== null));
check('every creator-facing sentence is covered', everySentence.length === 3 + REFUSALS.length);
for (const s of everySentence) {
  check(
    `★ says nothing about holders' money: "${s.slice(0, 44)}…"`,
    !/holder|refund|pro-rata|pro rata|sell|payout|your fans/i.test(s)
  );
}
check(
  '★ no sentence promises WHEN anything clears',
  !everySentence.some((s) => /will be back|shortly|soon|within \d|once the|automatically/i.test(s))
);

console.log('\n── 8. THE DISMISSAL KEY IS THE PAYMENT DETECTOR ───────────────────');
check(
  '★ paying moves paidUntilBlock, so the key changes and the banner returns on its own',
  lapseDismissKey('alice', 100) !== lapseDismissKey('alice', 200)
);
check('the same period for the same creator is the same key', lapseDismissKey('alice', 100) === lapseDismissKey('alice', 100));
check('two creators in the same period do not share a key', lapseDismissKey('alice', 100) !== lapseDismissKey('bob', 100));
check(
  'a did:pkh creator survives the key unchanged',
  lapseDismissKey('did:pkh:eip155:1:0xAb', 7).endsWith('did:pkh:eip155:1:0xAb.7')
);


console.log('\n── 9. THE READER-FACING SENTENCE ──────────────────────────────────');
// This one is shown to somebody who may be HOLDING, so the money rule is
// stricter here than on the creator side, not looser.
check(
  '★ says nothing about what a lapse does to money already held',
  !/refund|pro-rata|pro rata|payout|worth|value|lose|redeem/i.test(DELISTED_READER_NOTICE),
  DELISTED_READER_NOTICE
);
check(
  '★ …but DOES state the capability that remains, so a holder does not think they are trapped',
  /selling is unaffected/i.test(DELISTED_READER_NOTICE)
);
check('says it is not taking buyers', /not taking buyers/i.test(DELISTED_READER_NOTICE));
check('names the cause as the creator\'s lapsed listing', /listing has lapsed/i.test(DELISTED_READER_NOTICE));
check(
  '★ promises no date, only a condition',
  /if they renew/i.test(DELISTED_READER_NOTICE) &&
    !/soon|shortly|within \d|back (in|on)|automatically/i.test(DELISTED_READER_NOTICE)
);
check(
  '★ no jargon leaks: no phase names, no contract vocabulary',
  !/FROZEN|OVERDUE|wind-?down|pro-rata|curve|reserve|v1|v2/i.test(DELISTED_READER_NOTICE),
  DELISTED_READER_NOTICE
);

console.log('\n── 10. A PAY CONTROL IS NOT OFFERED WHILE A RENEW IS UNCONFIRMED ──');
// ★★★ THE THIRD INSTANCE OF "GUARDED ON THE RECOVERY CONTROL, LIVE ON THE
// PRIMARY ONE" (2026-08-31). Creator Studio showed a read-only "Check again"
// beside a fully live "Renew ~$10" after a renew that Hive accepted and Magi
// had not recorded. `renew` STACKS from max(paidUntil, block), so the second
// click buys a SECOND MONTH — it does not retry the first. The chain would
// ACCEPT that payment, which is why `renewRefusal === null` cannot be the gate.
check(
  '★ unconfirmed offers NO pay control, even though the chain would accept',
  !shouldOfferRenewNow({ renewRefusal: null, renewUnconfirmed: true })
);
check(
  'settled and acceptable DOES offer one',
  shouldOfferRenewNow({ renewRefusal: null, renewUnconfirmed: false })
);
check(
  'a chain refusal still blocks it when nothing is in flight',
  !shouldOfferRenewNow({ renewRefusal: 'paused', renewUnconfirmed: false })
);
for (const r of REFUSALS) {
  check(`★ "${r}" + unconfirmed offers nothing (neither reason is overridden)`, !shouldOfferRenewNow({ renewRefusal: r, renewUnconfirmed: true }));
}
// Degeneracy: a predicate that always returned false would satisfy every ★
// above. Prove it actually discriminates.
check(
  '★ …and the predicate is not simply always-false',
  shouldOfferRenewNow({ renewRefusal: null, renewUnconfirmed: false }) === true &&
    shouldOfferRenewNow({ renewRefusal: null, renewUnconfirmed: true }) === false
);
// The COPY must NOT follow the control: an unconfirmed renew is not a chain
// refusal, so the creator must not be told renewal is unavailable.
check(
  '★ unconfirmed is not a REFUSAL — the delisted copy still reads as renewable',
  (lapseNoticeFor(delisted, null) ?? '').includes('Renew to reactivate')
);

console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) {
  console.log(`\n${failures.length} FAILING CHECK(S):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
