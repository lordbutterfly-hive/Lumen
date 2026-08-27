/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * THE /creators RANKING CONTROLS vs AN EMPTY DELIVERY CORPUS.
 *
 * Run:
 *   cd apps/blog && npx tsx features/creator-tokens/market/discovery-ranking.selftest.ts
 *
 * WHAT THIS PROVES, AND WHY IT WOULD HAVE CAUGHT THE DEFECT.
 *
 * `/creators` opened on the "Most reliable" tab — `useState<Sort>('reliable')`
 * — and offered "Fastest" and an "Answers" filter beside it. All four read the
 * same nullable delivery columns of `lumen_ct_discovery`, and on the live build
 * every one of those columns is null for every creator. So the default tab
 * ranked nothing while telling the reader it ranked by reliability, and
 * "Answers" filtered to zero rows and blanked the grid.
 *
 * THE FIXTURE IS THE LIVE INDEX, not a convenient invention. Read from
 * https://indexer.testnet.magi.milohpr.com/v1/graphql on 2026-08-27: 13 rows,
 * every one `answered_count: 0, missed_count: 0, declined_count: 0,
 * completion_pct: null, median_response_blocks: null, avg_rating: null,
 * rating_count: 0`. Confirmed in the rendered DOM, which printed "No deliveries
 * yet" 26 times (13 cards + 13 New-here tiles) and "completion rate" zero times,
 * with the sort tab "Most reliable" carrying aria-pressed="true".
 *
 * VACUOUS-PASS GUARD. Section 0 asserts the fixture is genuinely empty of
 * delivery data before anything else runs. A fixture that accidentally grew a
 * record would make every assertion below pass for the wrong reason.
 */

import { hasDeliveryCorpus, resolveDiscoveryControls, type DiscoverySort } from './discovery-ranking';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

type Row = { completionPct: number | null };

/** The live index, verbatim in the only field any of these controls consult. */
const LIVE_ROWS: Row[] = Array.from({ length: 13 }, () => ({ completionPct: null }));

/** The same index once one creator has actually delivered. */
const WITH_RECORD: Row[] = [...LIVE_ROWS.slice(0, 12), { completionPct: 80 }];

// ── 0. THE FIXTURE REALLY IS THE DEFECT'S CONDITION.
check('fixture: the live index carries 13 creators', LIVE_ROWS.length === 13);
check(
  'fixture: not one of them has a delivery record',
  LIVE_ROWS.every((r) => r.completionPct === null),
  'if this fails, every assertion below is testing a case that does not exist'
);
check('fixture: the with-record corpus has exactly one', WITH_RECORD.filter((r) => r.completionPct !== null).length === 1);

// ── 1. THE CORPUS TEST ITSELF.
check('an all-null index has no corpus', hasDeliveryCorpus(LIVE_ROWS) === false);
check('one record is enough to have a corpus', hasDeliveryCorpus(WITH_RECORD) === true);
check('an EMPTY list has no corpus', hasDeliveryCorpus([]) === false, 'zero rows must not read as "rankable"');

// ── 2. THE DEFECT. On the live corpus the page must not present a ranking.
//       These are the assertions that FAIL on the pre-fix code, where `sort`
//       was seeded to 'reliable' unconditionally and the tabs always rendered.
{
  const c = resolveDiscoveryControls(LIVE_ROWS, 'reliable', false);
  check('live corpus: the ranking controls are NOT offered', c.rankingAvailable === false);
  check(
    'live corpus: the default ordering is not "reliable"',
    c.sort !== 'reliable',
    'landing on "Most reliable" is itself the claim — it tells the reader this order means something'
  );
  check('live corpus: the default ordering is "new", which is chain-derived and current', c.sort === 'new');
}

// ── 3. THE ANSWERS FILTER COULD ONLY EVER BLANK THE PAGE.
{
  const c = resolveDiscoveryControls(LIVE_ROWS, 'reliable', true);
  check(
    'live corpus: a requested answers-only filter is NOT applied',
    c.answersOnly === false,
    'applying it filters to completionPct !== null, i.e. to zero of thirteen live markets'
  );
  // Prove the harm the suppression prevents, using the view's own predicate.
  const wouldRemain = LIVE_ROWS.filter((r) => r.completionPct !== null).length;
  check('…and the filter it suppresses really would have emptied the grid', wouldRemain === 0);
}

// ── 4. EVERY REQUESTED SORT IS OVERRIDDEN WHILE THERE IS NOTHING TO RANK —
//       not just the default. A reader who clicks "Fastest" is re-sorting the
//       same nulls.
for (const requested of ['reliable', 'fastest', 'new'] as DiscoverySort[]) {
  check(
    `live corpus: a requested "${requested}" resolves to "new"`,
    resolveDiscoveryControls(LIVE_ROWS, requested, false).sort === 'new'
  );
}

// ── 5. THE CONTROLS COME BACK ON THEIR OWN. Derived from the rows, so there is
//       no flag anyone has to remember to flip — and crucially the default
//       returns to 'reliable', the branch that leaves the INDEXER's SQL order
//       verbatim. The standing rule that the indexer owns the ranking is not
//       disturbed by this fix.
{
  const c = resolveDiscoveryControls(WITH_RECORD, 'reliable', false);
  check('with a record: the controls are offered again', c.rankingAvailable === true);
  check('with a record: the default returns to the indexer’s own order', c.sort === 'reliable');
}
check(
  'with a record: every requested sort is honoured verbatim',
  (['reliable', 'fastest', 'new'] as DiscoverySort[]).every(
    (s) => resolveDiscoveryControls(WITH_RECORD, s, false).sort === s
  )
);
check(
  'with a record: the answers filter is honoured again',
  resolveDiscoveryControls(WITH_RECORD, 'reliable', true).answersOnly === true
);

// ── 6. AN EMPTY LIST IS NOT A CORPUS EITHER. A failed or empty read must not
//       re-enable a ranking — same "absence is not a fact" rule the rest of
//       this feature follows.
{
  const c = resolveDiscoveryControls([], 'reliable', true);
  check('empty list: controls stay off', c.rankingAvailable === false);
  check('empty list: filter stays off', c.answersOnly === false);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
