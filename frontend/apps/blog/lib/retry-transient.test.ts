/**
 * `isTransient` cause-chain invariants - plain assertions, no test runner (this
 * repo has none; same style as lib/http-keepalive.test.ts).
 *
 * ★ THE SUBJECT LIVES IN `packages/transaction/lib/retry.ts`; the TEST stays
 * here because this app is where a runner exists, exactly as
 * `lib/render-timing.test.ts` does for `packages/ui`. `-r tsconfig-paths/register`
 * resolves the `@transaction/*` alias.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/retry-transient.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHY THIS EXISTS. `isTransient` read only the TOP-LEVEL error, and wax does not
 * surface a transport failure, it WRAPS it - the reason that actually carried
 * `ETIMEDOUT` on this box was an `AggregateError` two levels down from a
 * `WaxUnknownRequestError`. The consequence is not a missed retry, it is a WRONG
 * NUMBER: `getProfileInfo` is the retried call, `getAccountFull` swallows its
 * failure with `.catch(() => null)` into `follower_count: 0, reputation: 25`, and
 * an anonymous profile render is then held by the edge for up to 5 minutes. So
 * the two things asserted here are (1) a buried transport fault IS found, with a
 * negative control proving the old top-level-only read would have missed it, and
 * (2) nothing the chain walk newly reaches is allowed to defeat the exclusions
 * this module was built around - a Hivemind statement timeout is an ANSWER, and
 * retrying it costs a reader ~12.4s to learn nothing.
 */
import { isTransient } from '@transaction/lib/retry';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

/** An `Error` with a `cause`, without depending on the ES2022 options bag. */
function wrap(message: string, cause: unknown, extra: Record<string, unknown> = {}): Error {
  const error = new Error(message);
  Object.assign(error, { cause }, extra);
  return error;
}

/** The shape a reset pooled socket actually reaches us in. */
function econnreset(): Error {
  return wrap('read ECONNRESET', undefined, { code: 'ECONNRESET' });
}

// 1. THE REQUESTED CASE: ECONNRESET wrapped TWO levels deep, which is what a
//    stale keep-alive socket reset inside wax looks like.
const twoDeep = wrap('WaxError: request failed', wrap('TypeError: fetch failed', econnreset()));
check('ECONNRESET two levels deep is transient', isTransient(twoDeep) === true);

// 1b. NEGATIVE CONTROL: the outermost error on its own says nothing transport-
//     shaped, so this test is not passing by accident - a top-level-only read
//     (the behaviour before this fix) would have called it permanent.
const outerOnly = new Error('WaxError: request failed');
check(
  'negative control: the OUTER error alone is NOT transient (so the chain walk is what found it)',
  isTransient(outerOnly) === false
);

// 1c. One level deep, and the level that carries it holding the code only.
check('ECONNRESET one level deep is transient', isTransient(wrap('wrapped', econnreset())) === true);
check(
  'a code-only ECONNRESET with an unhelpful message is still transient',
  isTransient(wrap('something went wrong', wrap('', undefined, { code: 'ECONNRESET' }))) === true
);

// 2. AggregateError carries its reasons in `errors`, not in `cause` - the shape
//    node's connect path produces, and the one measured on this box.
const aggregate = Object.assign(new AggregateError([new Error('ETIMEDOUT connect')], 'all failed'), {});
check('AggregateError reasons are walked', isTransient(wrap('WaxUnknownRequestError', aggregate)) === true);
check(
  'an AggregateError whose reasons are all permanent is NOT transient',
  isTransient(new AggregateError([new Error('no such community')], 'all failed')) === false
);

// 3. wax reports its class as `type` while `name` stays the generic "WaxError",
//    so the matched text has to include it.
check(
  'wax `type` is part of the matched text',
  isTransient(wrap('deep', wrap('', undefined, { type: 'WaxRequestTimeoutError', message: 'Request timed out' }))) ===
    true
);

// 4. EXCLUSIONS WIN ACROSS THE WHOLE CHAIN. This is the regression the chain walk
//    could most easily introduce: a generic outer wrapper saying "fetch failed"
//    over a Hivemind statement timeout, which must stay NOT transient.
const statementTimeout = wrap(
  'TypeError: fetch failed',
  new Error('canceling statement due to statement timeout')
);
check('a buried statement timeout is NOT transient, even under a "fetch failed" wrapper', isTransient(statementTimeout) === false);
check(
  'the same exclusion still holds at the top level (unchanged behaviour)',
  isTransient(new Error('canceling statement due to statement timeout')) === false
);
check('SQLSTATE 57014 anywhere in the chain is NOT transient', isTransient(wrap('fetch failed', new Error('57014'))) === false);

// 5. HTTP STATUS still decides at the level that carries it, and 4xx still wins
//    over a transport-shaped word deeper down: a node that answered has answered.
check('a 503 is transient', isTransient(Object.assign(new Error('bad gateway'), { status: 503 })) === true);
check(
  'a 404 is NOT transient even with a transport-shaped cause below it',
  isTransient(Object.assign(wrap('not found', new Error('fetch failed')), { status: 404 })) === false
);
check(
  'a nested response.status 500 is transient',
  isTransient(wrap('outer', Object.assign(new Error('inner'), { response: { status: 500 } }))) === true
);

// 6. BOUNDED AND CYCLE-SAFE. A `cause` that points back at an ancestor must not
//    hang the render it is being classified inside.
const a = new Error('a');
const b = wrap('b', a);
Object.assign(a, { cause: b });
check('a cyclic cause chain terminates and is NOT transient', isTransient(a) === false);
let deep: unknown = econnreset();
for (let i = 0; i < 6; i += 1) deep = wrap(`layer ${i}`, deep);
check('the depth cap holds (7 layers deep is not searched, and does not throw)', isTransient(deep) === false);
let shallow: unknown = econnreset();
for (let i = 0; i < 4; i += 1) shallow = wrap(`layer ${i}`, shallow);
check('positive control for the cap: 5 layers deep IS still found', isTransient(shallow) === true);

// 7. THE EMPTY CASES, unchanged.
check('null is not transient', isTransient(null) === false);
check('undefined is not transient', isTransient(undefined) === false);
check('a plain string is matched as text', isTransient('socket hang up') === true);
check('a plain permanent string is not transient', isTransient('no such community') === false);
check('an empty object is not transient', isTransient({}) === false);

if (failures === 0) {
  console.log('\nretry-transient: ALL CHECKS PASSED');
  process.exit(0);
} else {
  console.error(`\nretry-transient: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
