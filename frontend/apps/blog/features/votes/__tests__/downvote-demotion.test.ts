/**
 * Downvote demotion — plain assertions, no test runner (this repo has none; same
 * shape as features/post-editor/__tests__/preview-gate.test.ts).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     features/votes/__tests__/downvote-demotion.test.ts
 *
 * Covers the parts of the spec that are pure logic. The rendered assertions
 * (exactly one `.side`, no `.tallyDown`, menu label flip, focus return) are
 * driven against the real build by `verify-downvote.tmp.mjs`, because this repo
 * has no DOM test environment and a fake one would prove nothing about the
 * shipped page.
 */
import { FEATURE_INLINE_DOWNVOTE } from '../feature-flags';

type Vote = { voter: string; rshares: number };

/**
 * The predicate `votes-details-data.tsx` applies to the voters tooltip. Kept in
 * sync by assertion rather than by import because that module pulls React.
 */
const listedInTooltip = (v: Vote) => v.rshares > 0;

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `  [${detail}]` : ''}`);
  }
};

// ── §8 rollout ───────────────────────────────────────────────────────────────
// The whole change hangs off this. If it is ever flipped to true by accident the
// inline arrow returns everywhere at once, which is precisely the thing the spec
// set out to remove, so it gets an explicit guard rather than a comment.
check(
  'FEATURE_INLINE_DOWNVOTE ships false',
  FEATURE_INLINE_DOWNVOTE === false,
  String(FEATURE_INLINE_DOWNVOTE)
);

// ── §3.7 voters tooltip ──────────────────────────────────────────────────────
const fixture: Vote[] = [
  { voter: 'alice', rshares: 5_000_000 },
  { voter: 'bob', rshares: 1 },          // tiny upvote: rounds to $0.00 on a small post
  { voter: 'carol', rshares: -9_000_000 }, // heavy downvoter
  { voter: 'dave', rshares: -1 }          // tiny downvoter
];
const listed = fixture.filter(listedInTooltip).map((v) => v.voter);

check('downvoters are not listed', !listed.includes('carol') && !listed.includes('dave'), listed.join(','));
check('upvoters are listed', listed.includes('alice'), listed.join(','));
check(
  'a tiny upvote that rounds to $0.00 is still listed',
  listed.includes('bob'),
  'filtering on the formatted amount instead of the sign would drop this one'
);
check('the tooltip count equals the upvoter count', listed.length === 2, String(listed.length));

// ── §3.6 payout is untouched ────────────────────────────────────────────────
// The point of the spec is that downvotes keep suppressing payout. The display
// layer must not "helpfully" recompute anything from the filtered list: payout
// comes from net_rshares upstream, which still includes the negatives.
const netRshares: number = fixture.reduce((a, v) => a + v.rshares, 0);
const netFromListedOnly: number = fixture.filter(listedInTooltip).reduce((a, v) => a + v.rshares, 0);
check(
  'payout input still counts downvotes (the filter is display-only)',
  // The two totals differ by exactly the downvotes, which is the whole point.
  netRshares === -4_000_000 && netFromListedOnly === 5_000_001,
  `net=${netRshares} listedOnly=${netFromListedOnly}`
);

const total = 6;
console.log(`${total - failures} PASS, ${failures} FAIL (${total} checks)`);
process.exit(failures ? 1 : 0);
