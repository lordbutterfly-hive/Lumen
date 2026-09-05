/**
 * `httpKeepAliveSettings` / `httpKeepAliveLogLine` invariants - plain
 * assertions, no test runner (this repo has none; same style as
 * lib/feed/posts-prefetch-budget.test.ts). No `@ui/*` import here, so no
 * `tsconfig-paths` register is needed.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/http-keepalive.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHY THIS EXISTS. The subject is read exactly once, at boot, in a file
 * (`instrumentation.ts`) read once at boot, where every way it
 * can be wrong is a way that is invisible until production:
 *   (a) the flag defaulting ON, which would silently change every outbound Hive
 *       call on a box nobody meant to move, and destroy the A/B by making both
 *       arms the same arm;
 *   (b) a malformed number reaching `new Agent(...)`. MEASURED against undici
 *       6.28.1 rather than assumed: `NaN`/`Infinity` do NOT throw, they are
 *       ERASED to `null` by `Agent`'s `JSON.parse(JSON.stringify(...))` clone and
 *       silently replaced by undici's own defaults (so the boot line would report
 *       a number the dispatcher is not using, and the A/B would measure the
 *       control against itself); a NEGATIVE value throws nothing at boot and then
 *       fails the FIRST REQUEST with `TypeError: fetch failed` /
 *       `cause: invalid connections`, from inside a render, where
 *       `getAccountFull` swallows it into follower 0 / reputation 25;
 *   (c) `keepAliveMaxTimeout` landing BELOW undici's own 600_000 default, which
 *       would SHORTEN socket reuse against any upstream that advertises a long
 *       `Keep-Alive: timeout=` - the flag would then help some origins and hurt
 *       others at the same time and the measurement would mean nothing;
 *   (d) the two knobs crossing wires, which makes an on-box A/B unreadable.
 */
import {
  httpKeepAliveSettings,
  httpKeepAliveLogLine,
  HTTP_KEEPALIVE_TIMEOUT_MS,
  HTTP_KEEPALIVE_CONNECTIONS,
  HTTP_KEEPALIVE_MAX_TIMEOUT_FLOOR_MS
} from './http-keepalive';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

const EMPTY: Record<string, string | undefined> = {};
const ON: Record<string, string | undefined> = { LUMEN_HTTP_KEEPALIVE: 'yes' };

// 1. THE FLAG IS OFF UNLESS IT IS EXACTLY 'yes'. This is the whole safety story:
//    off means the process keeps Node's own default agent and today's behaviour.
check('unset flag is off', httpKeepAliveSettings(EMPTY).enabled === false);
for (const almost of ['', ' ', 'no', 'YES', 'Yes', 'true', '1', 'on', 'yes ', ' yes']) {
  check(
    `flag ${JSON.stringify(almost)} is NOT on (only exactly 'yes' arms it)`,
    httpKeepAliveSettings({ LUMEN_HTTP_KEEPALIVE: almost }).enabled === false
  );
}
check("flag 'yes' is on", httpKeepAliveSettings(ON).enabled === true);

// 2. THE DEFAULTS ARE THE MEASURED ONES, ASSERTED AS LITERALS. Comparing a
//    constant to itself passes for ANY value of the constant, which is no test
//    at all - the numbers here are the reviewed decision, so a mutation of any
//    of them has to turn this file red.
check('constant: keepAliveTimeout default is exactly 50_000', HTTP_KEEPALIVE_TIMEOUT_MS === 50_000);
check('constant: connections default is exactly 64', HTTP_KEEPALIVE_CONNECTIONS === 64);
check(
  "constant: keepAliveMaxTimeout floor is exactly 600_000 (undici's own default, client.js)",
  HTTP_KEEPALIVE_MAX_TIMEOUT_FLOOR_MS === 600_000
);
check('the settings actually carry that timeout', httpKeepAliveSettings(ON).keepAliveTimeout === 50_000);
check('the settings actually carry that connection cap', httpKeepAliveSettings(ON).connections === 64);
check('default pipelining is 1 (never > 1: every Hive call is a POST)', httpKeepAliveSettings(ON).pipelining === 1);
check(
  "50_000 stays clear of api.hive.blog's ~75s idle close",
  HTTP_KEEPALIVE_TIMEOUT_MS < 75_000 && httpKeepAliveSettings(ON).keepAliveTimeout < 75_000
);
check(
  "50_000 is longer than undici's own 4000ms no-hint default (the change is a change)",
  HTTP_KEEPALIVE_TIMEOUT_MS > 4_000
);
check(
  "the connection cap is well above one worker's realistic in-flight burst (>= 32), " +
    'because wax uses ONE origin at a time so this caps ALL Hive concurrency',
  HTTP_KEEPALIVE_CONNECTIONS >= 32
);

// 3. `keepAliveMaxTimeout` MAY ONLY GO UP. undici applies it as
//    `min(serverHint - threshold, keepAliveMaxTimeout)`, so anything below its
//    600_000 default would shorten reuse on hint-sending origins - the flag
//    would help and hurt at the same time. See (c) in the header.
check(
  "default keepAliveMaxTimeout is exactly 600_000 (undici's own floor)",
  httpKeepAliveSettings(ON).keepAliveMaxTimeout === 600_000
);
check(
  'a SHORT timeout override still cannot pull the max below 600_000',
  httpKeepAliveSettings({ ...ON, LUMEN_HTTP_KEEPALIVE_TIMEOUT_MS: '5000' }).keepAliveMaxTimeout === 600_000
);
check(
  'a timeout override ABOVE the floor raises the max with it (max is never < timeout)',
  httpKeepAliveSettings({ ...ON, LUMEN_HTTP_KEEPALIVE_TIMEOUT_MS: '900000' }).keepAliveMaxTimeout === 900_000
);
check(
  'keepAliveMaxTimeout >= keepAliveTimeout for every override tried',
  ['1', '5000', '50000', '600000', '900000', 'abc', ''].every((v) => {
    const s = httpKeepAliveSettings({ ...ON, LUMEN_HTTP_KEEPALIVE_TIMEOUT_MS: v });
    return s.keepAliveMaxTimeout >= s.keepAliveTimeout;
  })
);

// 4. THE TWO KNOBS ARE INDEPENDENT - neither may reach the other's value, or an
//    on-box A/B cannot attribute a change to the knob that was moved.
check(
  'the CONNECTIONS override cannot reach the timeout',
  httpKeepAliveSettings({ ...ON, LUMEN_HTTP_KEEPALIVE_CONNECTIONS: '99' }).keepAliveTimeout ===
    HTTP_KEEPALIVE_TIMEOUT_MS
);
check(
  'the TIMEOUT override cannot reach connections',
  httpKeepAliveSettings({ ...ON, LUMEN_HTTP_KEEPALIVE_TIMEOUT_MS: '9000' }).connections ===
    HTTP_KEEPALIVE_CONNECTIONS
);
check(
  'both set at once: each knob gets its own value',
  (() => {
    const s = httpKeepAliveSettings({
      ...ON,
      LUMEN_HTTP_KEEPALIVE_TIMEOUT_MS: '9000',
      LUMEN_HTTP_KEEPALIVE_CONNECTIONS: '4'
    });
    return s.keepAliveTimeout === 9_000 && s.connections === 4;
  })()
);

// 5. EVERY MALFORMED OVERRIDE FALLS BACK, never to NaN/0/negative/fractional.
//    Neither of the two things undici actually does with a bad value is
//    survivable: NaN/Infinity are erased to undici's own default (the boot line
//    then lies about the arm), and a negative value fails the first REQUEST from
//    inside a render. See (b) in this file's header.
for (const bad of ['', '   ', 'abc', 'NaN', '0', '-1', '1e', 'Infinity', '-Infinity', '50000ms', 'null', '16,']) {
  const s = httpKeepAliveSettings({
    ...ON,
    LUMEN_HTTP_KEEPALIVE_TIMEOUT_MS: bad,
    LUMEN_HTTP_KEEPALIVE_CONNECTIONS: bad
  });
  check(
    `malformed ${JSON.stringify(bad)} falls back to ${HTTP_KEEPALIVE_TIMEOUT_MS}/${HTTP_KEEPALIVE_CONNECTIONS} (got ${s.keepAliveTimeout}/${s.connections})`,
    s.keepAliveTimeout === HTTP_KEEPALIVE_TIMEOUT_MS && s.connections === HTTP_KEEPALIVE_CONNECTIONS
  );
}
check(
  'a fractional connections is floored to a whole socket count',
  httpKeepAliveSettings({ ...ON, LUMEN_HTTP_KEEPALIVE_CONNECTIONS: '8.9' }).connections === 8
);
check(
  'an unset override falls back on both knobs',
  (() => {
    const s = httpKeepAliveSettings({
      ...ON,
      LUMEN_HTTP_KEEPALIVE_TIMEOUT_MS: undefined,
      LUMEN_HTTP_KEEPALIVE_CONNECTIONS: undefined
    });
    return s.keepAliveTimeout === HTTP_KEEPALIVE_TIMEOUT_MS && s.connections === HTTP_KEEPALIVE_CONNECTIONS;
  })()
);

// 6. EVERY RESULT IS AN OPTION BAG undici WILL ACCEPT: finite, positive, whole.
//    undici validates each of these and THROWS rather than ignoring a bad one.
const everySettings = ['', 'abc', '0', '-5', '1', '8.9', '50000', '900000', undefined].flatMap((v) => [
  httpKeepAliveSettings({ ...ON, LUMEN_HTTP_KEEPALIVE_TIMEOUT_MS: v }),
  httpKeepAliveSettings({ ...ON, LUMEN_HTTP_KEEPALIVE_CONNECTIONS: v }),
  httpKeepAliveSettings({ LUMEN_HTTP_KEEPALIVE_TIMEOUT_MS: v, LUMEN_HTTP_KEEPALIVE_CONNECTIONS: v })
]);
check(
  'every setting undici validates is finite, positive and whole',
  everySettings.every(
    (s) =>
      Number.isInteger(s.keepAliveTimeout) &&
      s.keepAliveTimeout > 0 &&
      Number.isInteger(s.keepAliveMaxTimeout) &&
      s.keepAliveMaxTimeout > 0 &&
      Number.isInteger(s.connections) &&
      s.connections > 0 &&
      s.pipelining === 1
  )
);

// 7. NEGATIVE CONTROL: prove check 5 is not vacuous - a bare Number() of those
//    values really would have reached undici, and in one of the two damaging
//    shapes. Split by shape so the control names the actual harm rather than a
//    generic "unusable".
check(
  'negative control: NaN/Infinity shapes exist (undici ERASES these to its own default)',
  ['abc', 'NaN', 'Infinity', '-Infinity', '50000ms'].every((bad) => !Number.isFinite(Number(bad)))
);
check(
  'negative control: <= 0 shapes exist (undici accepts these, then fails the FIRST REQUEST). ' +
    "Note '' and '   ' land HERE, not above: Number('') is 0, not NaN",
  ['', '   ', '0', '-1', '-5'].every((bad) => {
    const naive = Number(bad);
    return Number.isFinite(naive) && naive <= 0;
  })
);
check(
  'negative control: the guard is what separates them - every one of those is rejected here',
  ['', '   ', 'abc', 'NaN', 'Infinity', '50000ms', '0', '-1', '-5'].every(
    (bad) =>
      httpKeepAliveSettings({ ...ON, LUMEN_HTTP_KEEPALIVE_TIMEOUT_MS: bad }).keepAliveTimeout === 50_000 &&
      httpKeepAliveSettings({ ...ON, LUMEN_HTTP_KEEPALIVE_CONNECTIONS: bad }).connections === 64
  )
);

// 8. THE BOOT LINE. An operator must be able to read the arm out of the log
//    without inferring it from behaviour, and both lines must be greppable by
//    the same `render-timing:` prefix as the per-render stages.
const offLine = httpKeepAliveLogLine(httpKeepAliveSettings(EMPTY));
const onLine = httpKeepAliveLogLine(httpKeepAliveSettings(ON));
check('the off line says off', offLine.startsWith('render-timing: http-keepalive off'));
check('the on line says on', onLine.startsWith('render-timing: http-keepalive on '));
check('the off line names the variable that turns it on', offLine.includes('LUMEN_HTTP_KEEPALIVE=yes'));
check(
  'the on line prints every value actually handed to the Agent, as literals',
  onLine ===
    'render-timing: http-keepalive on keepAliveTimeout=50000ms keepAliveMaxTimeout=600000ms ' +
      'connections=64 pipelining=1'
);
check(
  'the on line prints OVERRIDDEN values, not the constants',
  (() => {
    const line = httpKeepAliveLogLine(
      httpKeepAliveSettings({
        ...ON,
        LUMEN_HTTP_KEEPALIVE_TIMEOUT_MS: '9000',
        LUMEN_HTTP_KEEPALIVE_CONNECTIONS: '4'
      })
    );
    return (
      line.includes('keepAliveTimeout=9000ms') &&
      line.includes('connections=4') &&
      !line.includes('keepAliveTimeout=50000ms') &&
      !line.includes('connections=64')
    );
  })()
);
check('a note is appended when one is given', httpKeepAliveLogLine(httpKeepAliveSettings(ON), '(x)').endsWith(' (x)'));
check('no note leaves no trailing space', !onLine.endsWith(' '));
check(
  'off and on lines are distinguishable by a single grep',
  offLine !== onLine && offLine.includes(' off ') && onLine.includes(' on ')
);

if (failures === 0) {
  console.log('\nhttp-keepalive: ALL CHECKS PASSED');
  process.exit(0);
} else {
  console.error(`\nhttp-keepalive: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
