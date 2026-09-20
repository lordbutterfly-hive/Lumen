/**
 * UNIT TESTS for `features/lite-auth/login/leave-login.ts` — the cap that stops
 * the sign-in door and a gated page from bouncing a reader between them, and
 * the gate that decides where `?next=` is allowed to point.
 *
 * Run by `pnpm --filter @hive/blog test:unit` under ts-node; own harness, same
 * shape as the other tests in this directory.
 *
 * ★★★ WHY THE CAP EXISTS (2026-09-19, production incident). Two readers signed
 * in with Keychain while sitting on `/login?next=<a page that needs an
 * account>`. Next's client-side Router Cache still held the `NEXT_REDIRECT` that
 * page had returned while they were signed out, so the login page's "already
 * signed in, leave" effect was answered from the cache with a bounce straight
 * back to `/login` — and round it went. Reproduced locally against the unfixed
 * build: 3,664 navigations and 1,831 `POST /api/lite/auth/google/challenge` in
 * fifteen seconds, ending on the branded 503 card.
 *
 * The document load in `leaveLoginFor` removes that specific cause. The cap is
 * what makes the NEXT cause of a client/server disagreement cost a reader two
 * page loads instead of a spinning tab. Three of the checks below exist because
 * an adversarial review broke the first version of it:
 *
 *   • the window used to SLIDE — the attempt was recorded before the cap was
 *     tested, so every refusal re-stamped the clock and a refused reader could
 *     never wait it out. The harder they tried, the longer they were locked out.
 *   • a sign-in the reader ASKED for was subject to the same cap, so a
 *     successful sign-in could silently navigate nowhere at all.
 *   • `BOUNCE_WINDOW_MS` was pinned by nothing: set it to zero or to four hours
 *     and every check still passed, because the fake clock never moved. It moves
 *     now.
 */
import {
  loginDestination,
  leaveLoginFor,
  bounceCountFor,
  recordBounce,
  clearBounce,
  clock,
  MAX_BOUNCES,
  BOUNCE_WINDOW_MS
} from '../../features/lite-auth/login/leave-login';

let checks = 0;
let failures = 0;
function ok(label: string, pass: boolean, detail = ''): void {
  checks++;
  if (pass) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── the fake browser ─────────────────────────────────────────────────────────
// `assign`/`replace` record instead of navigating, and a fresh window stands in
// for a fresh DOCUMENT — which is what a bounce produces, and the reason the
// in-flight guard lives on `window` rather than in module scope.
const ORIGIN = 'https://lumensocial.net';
let navigated: string[] = [];
let fakeTime = 1_000_000;
clock.now = () => fakeTime;

interface FakeStore {
  get(k: string): string | null;
  set(k: string, v: string): void;
  del(k: string): void;
}

function workingStore(map: Map<string, string>): FakeStore {
  return {
    get: (k) => (map.has(k) ? (map.get(k) as string) : null),
    set: (k, v) => {
      map.set(k, v);
    },
    del: (k) => {
      map.delete(k);
    }
  };
}

const throwingStore: FakeStore = {
  get() {
    throw new Error('storage disabled');
  },
  set() {
    throw new Error('storage disabled');
  },
  del() {
    throw new Error('storage disabled');
  }
};

/** One TAB: storage and cookies survive navigations, the window object does not. */
interface FakeTab {
  storage: FakeStore;
  cookies: Map<string, string>;
}

function newTab(storage?: FakeStore): FakeTab {
  return { storage: storage ?? workingStore(new Map()), cookies: new Map() };
}

function newDocument(search: string, tab: FakeTab): void {
  navigated = [];
  const cookieJar = tab.cookies;
  (globalThis as unknown as { window: unknown; document: unknown }).window = {
    location: {
      origin: ORIGIN,
      search,
      protocol: 'https:',
      assign: (url: string) => navigated.push(`assign:${url}`),
      replace: (url: string) => navigated.push(`replace:${url}`)
    },
    sessionStorage: {
      getItem: (k: string) => tab.storage.get(k),
      setItem: (k: string, v: string) => tab.storage.set(k, v),
      removeItem: (k: string) => tab.storage.del(k)
    }
  };
  const doc = {
    get cookie(): string {
      return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(value: string) {
      const [pair, ...attrs] = value.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const raw = pair.slice(eq + 1);
      const expired = attrs.some((a) => /max-age\s*=\s*0/i.test(a));
      if (expired || raw === '') cookieJar.delete(name);
      else cookieJar.set(name, raw);
    }
  };
  (globalThis as unknown as { document: unknown }).document = doc;
  (globalThis as unknown as { window: { document?: unknown } }).window.document = doc;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. WHERE `?next=` MAY POINT.
// ═══════════════════════════════════════════════════════════════════════
console.log('\nloginDestination: what ?next= is allowed to say');

function destFor(search: string): string {
  newDocument(search, newTab());
  return loginDestination();
}

ok('a plain path is honoured', destFor('?next=%2Fwallet') === '/wallet');
ok('a path with a query survives intact', destFor('?next=%2Fwallet%3Ftab%3Dmagi') === '/wallet?tab=magi');
ok('a profile path is honoured', destFor('?next=%2F%40lordbutterfly') === '/@lordbutterfly');
ok('no ?next= at all falls back to the feed', destFor('') === '/');
ok('an empty ?next= falls back to the feed', destFor('?next=') === '/');

console.log('\nloginDestination: and where it may NOT');
const hostile: Array<[string, string]> = [
  ['an absolute URL', 'https://evil.example/x'],
  ['a protocol-relative URL', '//evil.example'],
  ['a javascript: URL', 'javascript:alert(1)'],
  // ★ The two that `isInternalPath` used to accept. The URL parser rewrites "\"
  // to "/" and strips raw TAB/LF/CR, so both resolve to evil.example even
  // though they begin with a single slash.
  ['a backslash after the slash', '/\\evil.example'],
  ['a tab after the slash', '/\t/evil.example'],
  ['a newline after the slash', '/\n//evil.example'],
  ['a relative path', 'wallet'],
  ['a parent path', '../etc/passwd'],
  // ★ Same-origin but refused anyway: a nested chain gives every hop a
  // DIFFERENT destination string, which walks straight past a per-destination
  // cap, one full server render per link.
  ['the login page itself', '/login'],
  ['a nested login chain', '/login?next=%2Flogin%3Fnext%3D%252Fwallet'],
  // ★ Also same-origin and refused: `?next=` navigates a browser that has just
  // been handed a fresh session, and pointing that at an internal GET is a
  // category nobody needs.
  ['an API route', '/api/lite/publisher/health'],
  ['an API route with a query', '/api/users/me?x=1']
];
for (const [label, value] of hostile) {
  const got = destFor(`?next=${encodeURIComponent(value)}`);
  ok(`${label} is refused (-> feed)`, got === '/', `got ${JSON.stringify(got)}`);
}

// ═══════════════════════════════════════════════════════════════════════
// 2. THE CAP.
// ═══════════════════════════════════════════════════════════════════════
console.log('\nleaveLoginFor: one navigation per document, capped per tab');

{
  const tab = newTab();
  newDocument('?next=%2Fwallet', tab);
  const first = leaveLoginFor('/wallet');
  const second = leaveLoginFor('/wallet');
  ok('the first call navigates', first === true && navigated.length === 1);
  ok(
    'it REPLACES rather than pushes, so Back does not return to the door',
    navigated[0] === 'replace:/wallet',
    navigated[0]
  );
  ok(
    'a second caller in the SAME document does not navigate again',
    second === false && navigated.length === 1,
    JSON.stringify(navigated)
  );
}

{
  // A bounce is a new document each time, in the same tab.
  const tab = newTab();
  const navigatedOn: number[] = [];
  for (let doc = 1; doc <= 5; doc += 1) {
    newDocument('?next=%2Fwallet', tab);
    if (leaveLoginFor('/wallet')) navigatedOn.push(doc);
  }
  ok(
    `a bouncing tab is stopped after ${MAX_BOUNCES} attempts`,
    navigatedOn.length === MAX_BOUNCES,
    `navigated on documents ${JSON.stringify(navigatedOn)}`
  );
  ok(
    'and the attempts it did make were the FIRST ones, not a random pair',
    JSON.stringify(navigatedOn) === JSON.stringify([1, 2]),
    JSON.stringify(navigatedOn)
  );
}

console.log('\nleaveLoginFor: the window does not slide under a refused reader');

{
  // ★★★ THE REGRESSION THE ADVERSARIAL REVIEW FOUND. The first version recorded
  // the attempt BEFORE testing the cap, so each refusal re-stamped `at` and the
  // window never elapsed: a reader who kept trying was locked out for as long as
  // they kept trying.
  const tab = newTab();
  const start = fakeTime;
  newDocument('?next=%2Fwallet', tab);
  leaveLoginFor('/wallet');
  fakeTime += 1000;
  newDocument('?next=%2Fwallet', tab);
  leaveLoginFor('/wallet');

  // Now refuse them repeatedly, well inside the window.
  for (let i = 0; i < 5; i += 1) {
    fakeTime += 1000;
    newDocument('?next=%2Fwallet', tab);
    ok(`refused while inside the window (+${fakeTime - start}ms)`, leaveLoginFor('/wallet') === false);
  }

  // The window is measured from the last ALLOWED attempt, not from the refusals.
  fakeTime = start + 1000 + BOUNCE_WINDOW_MS + 1;
  newDocument('?next=%2Fwallet', tab);
  ok(
    'once the window has passed the reader is let through again',
    leaveLoginFor('/wallet') === true,
    `t=+${fakeTime - start}ms, window=${BOUNCE_WINDOW_MS}ms`
  );
}

{
  // NEGATIVE CONTROL for the window itself: just inside it, still refused. This
  // is what pins BOUNCE_WINDOW_MS — without it the constant could be any value.
  const tab = newTab();
  const start = fakeTime;
  newDocument('?next=%2Fwallet', tab);
  leaveLoginFor('/wallet');
  newDocument('?next=%2Fwallet', tab);
  leaveLoginFor('/wallet');
  fakeTime = start + BOUNCE_WINDOW_MS - 1;
  newDocument('?next=%2Fwallet', tab);
  ok('1ms before the window expires, still refused', leaveLoginFor('/wallet') === false);
  fakeTime = start + BOUNCE_WINDOW_MS + 1;
  newDocument('?next=%2Fwallet', tab);
  ok('1ms after it expires, allowed', leaveLoginFor('/wallet') === true);
}

console.log('\nleaveLoginFor: a sign-in the reader asked for is never refused');

{
  // ★★★ THE OTHER REGRESSION. A completed sign-in that silently goes nowhere
  // reads as "my account stopped working" — worse than any loop.
  const tab = newTab();
  for (let doc = 1; doc <= 3; doc += 1) {
    newDocument('?next=%2Fwallet', tab);
    leaveLoginFor('/wallet');
  }
  newDocument('?next=%2Fwallet', tab);
  ok('the automatic path is capped out', leaveLoginFor('/wallet') === false);
  newDocument('?next=%2Fwallet', tab);
  ok(
    'but a user-initiated sign-in still navigates',
    leaveLoginFor('/wallet', { userInitiated: true }) === true,
    JSON.stringify(navigated)
  );
  newDocument('?next=%2Fwallet', tab);
  ok('and it cleared the count, so the automatic path works again', leaveLoginFor('/wallet') === true);
}

console.log('\nthe cap counts destinations, and survives storage that throws');

{
  // The cap must count bounces to ONE destination, not "navigations in this
  // tab" — otherwise a reader who signs in, goes to their wallet, signs out and
  // signs back in for another page would be refused.
  const tab = newTab();
  const results: boolean[] = [];
  for (const dest of ['/wallet', '/profile', '/creators/launch', '/wallet/tokens']) {
    newDocument(`?next=${encodeURIComponent(dest)}`, tab);
    results.push(leaveLoginFor(dest));
  }
  ok('four different destinations in one tab are all allowed', results.every(Boolean), JSON.stringify(results));
}

{
  // ★ sessionStorage that throws must NOT switch the cap off. It falls back to a
  // cookie, because a client and a server that disagree keep disagreeing whether
  // or not storage works — and an uncapped disagreement behind a document load
  // is an unbounded stream of REAL origin hits, which is worse than the in-tab
  // loop this file exists to stop.
  const tab = newTab(throwingStore);
  const navigatedOn: number[] = [];
  for (let doc = 1; doc <= 5; doc += 1) {
    newDocument('?next=%2Fwallet', tab);
    if (leaveLoginFor('/wallet')) navigatedOn.push(doc);
  }
  ok(
    'with sessionStorage throwing, the cookie fallback still caps it',
    navigatedOn.length === MAX_BOUNCES,
    `navigated on ${JSON.stringify(navigatedOn)}; cookies ${JSON.stringify([...tab.cookies.keys()])}`
  );
  newDocument('?next=%2Fwallet', tab);
  ok('and a user-initiated sign-in is still allowed through it', leaveLoginFor('/wallet', { userInitiated: true }));
}

{
  // The primitives themselves.
  const tab = newTab();
  newDocument('', tab);
  ok('bounceCountFor starts at 0', bounceCountFor('/wallet') === 0);
  ok('recordBounce returns 1 for the first', recordBounce('/wallet') === 1);
  ok('and the count is then readable without recording', bounceCountFor('/wallet') === 1 && bounceCountFor('/wallet') === 1);
  ok('recordBounce increments', recordBounce('/wallet') === 2);
  ok('a different destination starts again at 0', bounceCountFor('/profile') === 0);
  clearBounce();
  ok('clearBounce forgets it', bounceCountFor('/wallet') === 0);
}

console.log(`\n${checks - failures}/${checks}`);
if (checks === 0) {
  console.error('FATAL: zero checks ran — that is a failure, not a pass.');
  process.exit(1);
}
process.exit(failures === 0 ? 0 : 1);
