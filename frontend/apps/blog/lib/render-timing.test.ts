/**
 * `renderTimer` invariants - plain assertions, no test runner (this repo has
 * none; same style as lib/feed/__tests__/topic-warm-select.test.ts). The log
 * sink is INJECTED rather than mocked, so nothing here depends on pino's level
 * or stream.
 *
 * RUN IT (`-r tsconfig-paths/register` because the module logs through the
 * `@ui/*` path alias):
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/render-timing.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHY THIS EXISTS: an instrument has exactly two ways to be worse than no
 * instrument - being on when it is supposed to be off (cost and log spam on
 * every production render), and taking part in the render it is supposed to be
 * watching (a throw from a log line failing a page). Both are asserted here.
 */
import { renderTimer, renderTimingEnabled } from './render-timing';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

const ON = { LUMEN_RENDER_TIMING: 'yes' };

// ---- OFF (the default) ----------------------------------------------------
{
  const lines: string[] = [];
  const timer = renderTimer('profile-posts', (line) => lines.push(line), {});
  timer.mark('session');
  timer.mark('posts');
  timer.done({ user: 'bozz', race: 'lost' });
  check('OFF: no env var means not one log line', lines.length === 0);
}
for (const value of ['no', 'YES', 'Yes', 'true', '1', '']) {
  const lines: string[] = [];
  const timer = renderTimer('x', (line) => lines.push(line), { LUMEN_RENDER_TIMING: value });
  timer.mark('a');
  timer.done();
  check(`OFF: LUMEN_RENDER_TIMING=${JSON.stringify(value)} does not enable it`, lines.length === 0);
}
check('OFF: renderTimingEnabled agrees', !renderTimingEnabled({}) && !renderTimingEnabled({ LUMEN_RENDER_TIMING: 'no' }));
check('ON: renderTimingEnabled agrees', renderTimingEnabled(ON));

// ---- ON: exactly one line, carrying every stage ---------------------------
const lines: string[] = [];
const timer = renderTimer('profile-posts', (line) => lines.push(line), ON);
timer.mark('session');
timer.mark('posts');
timer.mark('attach');
timer.mark('block');
timer.mark('merge');
timer.mark('trim');
timer.done({ user: 'bozz', anon: 'true', budget: 3500, race: 'won', seed: 'miss', count: 20 });

check(`ON: exactly ONE line (got ${lines.length})`, lines.length === 1);
const line = lines[0] ?? '';
check('ON: line is prefixed render-timing: <label>', line.startsWith('render-timing: profile-posts '));
for (const stage of ['session', 'posts', 'attach', 'block', 'merge', 'trim']) {
  check(`ON: line carries stage ${stage}`, new RegExp(`\\b${stage}=\\d+ms\\b`).test(line));
}
check('ON: line carries a total', /\btotal=\d+ms$/.test(line));
for (const extra of ['user=bozz', 'anon=true', 'budget=3500', 'race=won', 'seed=miss', 'count=20']) {
  check(`ON: line carries extra ${extra}`, line.includes(extra));
}
check(
  'ON: extras come before the stages (the line reads as identity then timings)',
  line.indexOf('user=bozz') < line.indexOf('session=')
);
// Exact tail: the stages appear in the order they were marked, each once, with
// `total` last. Matched as a whole rather than by indexOf, because a substring
// search would happily find a stage's name inside an extra instead.
check(
  'ON: the stages appear in mark order, once each, with total last',
  / session=\d+ms posts=\d+ms attach=\d+ms block=\d+ms merge=\d+ms trim=\d+ms total=\d+ms$/.test(line)
);
// REGRESSION GUARD for the extras/stage name collision that made the first
// version of the check above pass on the wrong `posts=`: no extra key may reuse
// a stage name, so every stage name appears exactly once in the whole line.
for (const stage of ['session', 'posts', 'attach', 'block', 'merge', 'trim', 'total']) {
  const hits = line.split(`${stage}=`).length - 1;
  check(`ON: the key ${stage}= appears exactly once (no extra shadows a stage; got ${hits})`, hits === 1);
}
// Monotonic source: no stage and no total may be negative (the Date.now() bug
// warm-server-caches.ts documents printed `-140ms`).
const durations = Array.from(line.matchAll(/=(-?\d+)ms/g)).map((m) => Number(m[1]));
check(`ON: no negative duration (got ${durations.join(',')})`, durations.length > 0 && durations.every((d) => d >= 0));

// DEGENERACY CHECK: a timer that always prints 0ms would pass every assertion
// above while measuring nothing. Burn real wall time between two marks (busy
// loop, not a sleep, so the durations are this process's own) and require the
// stage to see it.
{
  const timed: string[] = [];
  const t = renderTimer('slow', (l) => timed.push(l), ON);
  const until = Date.now() + 25;
  while (Date.now() < until) {
    /* burn ~25ms */
  }
  t.mark('slow-stage');
  t.done();
  const ms = Number(/slow-stage=(\d+)ms/.exec(timed[0] ?? '')?.[1] ?? -1);
  check(`the timer measures real elapsed time (slow-stage=${ms}ms, expected >= 15)`, ms >= 15);
}

// `done()` with no extras at all still emits a usable line.
{
  const bare: string[] = [];
  const t = renderTimer('profile-layout', (l) => bare.push(l), ON);
  t.mark('valid');
  t.done();
  check('ON: done() with no extras still emits one line with the stage and total',
    bare.length === 1 && /^render-timing: profile-layout valid=\d+ms total=\d+ms$/.test(bare[0]));
}

// ---- IT MUST NEVER PARTICIPATE -------------------------------------------
{
  let threw = false;
  try {
    const t = renderTimer('boom', () => {
      throw new Error('sink exploded');
    }, ON);
    t.mark('a');
    t.done({ user: 'x' });
  } catch {
    threw = true;
  }
  check('a throwing log sink can never reach the render', !threw);
}
{
  let threw = false;
  try {
    const t = renderTimer('off-boom', () => {
      throw new Error('sink exploded');
    }, {});
    t.mark('a');
    t.done();
  } catch {
    threw = true;
  }
  check('the OFF timer calls the sink at all times: never', !threw);
}

// ---- NEGATIVE CONTROL ----------------------------------------------------
// Prove the ON assertions above are not vacuous: the SAME calls with the flag
// off produce nothing, so "line contains every stage" is really testing the
// flag, not a string that would exist either way.
{
  const control: string[] = [];
  const t = renderTimer('profile-posts', (l) => control.push(l), { LUMEN_RENDER_TIMING: 'nope' });
  t.mark('session');
  t.mark('posts');
  t.done({ user: 'bozz' });
  check('negative control: identical calls with the flag off log nothing', control.length === 0);
}

if (failures === 0) {
  console.log('\nrender-timing: ALL CHECKS PASSED');
  process.exit(0);
} else {
  console.error(`\nrender-timing: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
