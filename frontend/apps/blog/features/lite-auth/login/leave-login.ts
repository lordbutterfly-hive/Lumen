import { isInternalPath } from '@ui/lib/sanitize-url';

/**
 * ★★★ WHERE A JUST-SIGNED-IN READER GOES, AND WHY IT IS A DOCUMENT LOAD
 * (2026-09-19, after a production incident).
 *
 * THE INCIDENT. Two readers signed in with Keychain while sitting on
 * `/login?next=<a page that needs an account>` — the ordinary path, because
 * clicking Wallet or Creators signed out sends you exactly there. Both tabs
 * then span: 503 and 231 `POST /api/lite/auth/google/challenge` in about three
 * minutes, 334 of them refused 429 by our own rate limiter, ending on the
 * branded 503 card (`app/global-error.tsx`, the ROOT error boundary). The
 * origin was healthy throughout — no restart, no 5xx on any document, and the
 * server logged `signed=yes` for those very requests. Reproduced locally
 * against the unfixed build: 3,664 navigations and 1,831 nonce POSTs in
 * FIFTEEN seconds.
 *
 * THE MECHANISM, measured in the access log rather than reasoned about:
 *
 *   1. Signed out, the reader clicks Wallet. `app/wallet/page.tsx` calls
 *      `redirect('/login?next=%2Fwallet')`, which the App Router delivers as a
 *      `NEXT_REDIRECT` flight payload — and Next CACHES that payload in the
 *      client-side Router Cache, keyed by URL, for 30s (5 minutes for a
 *      prefetched `<Link>`, which the left rail's rows are).
 *   2. The reader signs in. Nothing invalidates that cache: the Keychain path
 *      called `router.push()` with no `router.refresh()` beside it, so every
 *      cached entry in the tab is still the render made for "anon".
 *   3. The login page's "already signed in, leave the door" effect fires
 *      `router.replace('/wallet')` — and the router answers it FROM THE CACHE,
 *      replaying step 1's redirect without asking the server at all. Back on
 *      `/login`, the login form mounts again, the effect fires again, and the
 *      two bounce at frame rate. In the measured incident 35 seconds of looping
 *      produced ZERO requests for `/wallet`: not one iteration reached the
 *      origin, which is why nothing server-side ever recorded a fault.
 *   4. Each mount of the login form fetched a fresh single-use Google nonce.
 *      That is where the POSTs came from — the loop's exhaust, not its cause.
 *
 * SO THE IDENTITY CHANGED AND EVERY CACHED RENDER IN THE TAB IS WRONG. The
 * supported soft answer is `router.refresh()`, but it is a RACE here: it
 * schedules a refetch while the navigation that consumes the stale entry is
 * already in flight. A document load has no such race — it cannot replay a
 * cached flight payload, it re-asks the origin with the cookie the sign-in just
 * minted, and it starts the tab with an empty Router Cache. Sign-in happens
 * once per session and is the one moment a reader expects a page to load, so
 * that is the trade this makes.
 *
 * ★ AND IT IS BOUNDED, BUT ONLY FOR BOUNCES. `leaveLoginFor` caps how many
 * times a tab may be sent to the same destination by an EFFECT inside one short
 * window, so a client and a server that disagree about who is signed in cost a
 * reader two page loads instead of a spinning tab. A navigation the reader
 * ASKED for — they pressed a sign-in button — is never capped and clears the
 * count, because refusing to move somebody who just signed in is a worse
 * failure than the loop: it looks like their password stopped working.
 *
 * ★★ THE CAP IS PEEKED BEFORE IT IS RECORDED (adversarial review, 2026-09-19).
 * The first draft recorded the attempt and then tested the cap, so every
 * REFUSED attempt re-stamped the window's start. The window slid forward on
 * each retry and a refused reader could never wait it out — the more they
 * tried, the longer they were locked out. Read the count, decide, and only then
 * write.
 */

/** Session-scoped, so a reload keeps the count and a new tab starts clean. */
const BOUNCE_KEY = 'lumen:login-bounce';

/**
 * Same record, in a cookie, for the browsers where `sessionStorage` throws
 * (Safari private mode, a full quota, some embedded webviews). Without it the
 * cap silently switches OFF exactly where it is most needed: storage failing
 * does not stop a client and a server disagreeing, and an uncapped disagreement
 * with a document load behind it is an unbounded stream of REAL origin hits,
 * which is worse for us than the in-tab loop this file exists to stop.
 */
const BOUNCE_COOKIE = 'lumen_login_bounce';

/**
 * Long enough to cover a real sign-in round trip plus the destination's render,
 * short enough that a reader who comes back to `/login` later (a second
 * account, a sign-out and back in) is never refused their redirect.
 */
export const BOUNCE_WINDOW_MS = 15_000;

/**
 * One navigation for the normal case, one spare for a genuine transient (a
 * cookie that lands a beat late). The third attempt inside the window is the
 * signature of a loop, and it is refused.
 */
export const MAX_BOUNCES = 2;

/**
 * The clock, as a swappable seam. `BOUNCE_WINDOW_MS` is the number the whole
 * safety argument rests on, and a test that cannot move time cannot check it —
 * the first version of the unit test passed just as happily with the window set
 * to zero or to four hours. Production never touches this.
 */
export const clock = { now: (): number => Date.now() };

interface BounceRecord {
  dest: string;
  at: number;
  n: number;
}

interface LeavingWindow extends Window {
  /**
   * ★ ONE NAVIGATION PER DOCUMENT, so the cap counts BOUNCES and not CALLERS.
   *
   * Two things legitimately want to leave the door at the same moment: the
   * sign-in control that just succeeded, and the page's own "you are signed in,
   * you should not be looking at a sign-in form" effect. Both are correct and
   * neither can be deleted (the effect also covers a session minted in another
   * tab). Without this, one ordinary sign-in would spend both allowed bounces
   * before anything had bounced at all.
   *
   * It lives on `window` rather than in module scope BECAUSE the thing it
   * describes is a property of this document: a bounce is a new document, and a
   * new document must be allowed its own attempt. A module-level variable
   * happens to behave the same way in a browser but not in a test process, and
   * a guard that cannot be tested is a guard nobody checks.
   */
  __lumenLeavingFor?: string;
}

function readCookie(name: string): string | null {
  try {
    const prefix = `${name}=`;
    for (const part of document.cookie.split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith(prefix)) return decodeURIComponent(trimmed.slice(prefix.length));
    }
  } catch {
    /* no document, or cookies disabled */
  }
  return null;
}

function writeCookie(name: string, value: string | null): void {
  try {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie =
      value === null
        ? `${name}=; path=/; max-age=0; SameSite=Lax${secure}`
        : `${name}=${encodeURIComponent(value)}; path=/; max-age=${Math.ceil(
            BOUNCE_WINDOW_MS / 1000
          )}; SameSite=Lax${secure}`;
  } catch {
    /* cookies disabled — then nothing can remember, see the cap's own doc */
  }
}

function readRaw(): string | null {
  try {
    const stored = window.sessionStorage.getItem(BOUNCE_KEY);
    if (stored !== null) return stored;
  } catch {
    /* fall through to the cookie */
  }
  return readCookie(BOUNCE_COOKIE);
}

function writeRaw(value: string | null): void {
  let stored = false;
  try {
    if (value === null) window.sessionStorage.removeItem(BOUNCE_KEY);
    else window.sessionStorage.setItem(BOUNCE_KEY, value);
    stored = true;
  } catch {
    /* fall through to the cookie */
  }
  if (!stored) writeCookie(BOUNCE_COOKIE, value);
}

function readBounce(): BounceRecord | null {
  const raw = readRaw();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BounceRecord>;
    if (typeof parsed?.dest !== 'string' || typeof parsed?.at !== 'number' || typeof parsed?.n !== 'number') {
      return null;
    }
    return { dest: parsed.dest, at: parsed.at, n: parsed.n };
  } catch {
    // Something else wrote this key. Treated as "no history", which costs one
    // redirect, never a loop.
    return null;
  }
}

/**
 * How many times this tab has ALREADY been sent to `dest` inside the window.
 * Reads only — see the peek-before-record note in this file's header.
 */
export function bounceCountFor(dest: string): number {
  const prev = readBounce();
  if (!prev || prev.dest !== dest) return 0;
  return clock.now() - prev.at < BOUNCE_WINDOW_MS ? prev.n : 0;
}

/** Record one attempt for `dest` and return the new count (1 for the first). */
export function recordBounce(dest: string): number {
  const n = bounceCountFor(dest) + 1;
  writeRaw(JSON.stringify({ dest, at: clock.now(), n } satisfies BounceRecord));
  return n;
}

/** Forget the count — the reader asked for this, so nothing is bouncing. */
export function clearBounce(): void {
  writeRaw(null);
  writeCookie(BOUNCE_COOKIE, null);
}

/**
 * ★★★ `?next=` WAS WRITTEN BUT NEVER READ (2026-08-10), and it now has TWO
 * readers, so it lives here rather than in either of them.
 *
 * `/profile` has redirected signed-out readers to `/login?next=/profile` since
 * it was built, and `/wallet`, `/wallet/tokens`, `/creators/launch` and
 * `/creators/studio` do the same. The login page honoured it; the Keychain row
 * did not — it navigated to the feed and the reader had to remember for
 * themselves what they had been trying to open.
 *
 * ★ `isInternalPath` IS THE GATE, AND IT IS NOT ENOUGH ON ITS OWN. Without it
 * this is an open redirect: anyone can hand a victim
 * `/login?next=https://evil.example` and the sign-in page would send them there
 * the moment their session was minted. But a leading `/` does not keep a
 * navigation on this origin either — the URL parser rewrites `\` to `/` and
 * strips raw TAB/LF/CR, so `/\evil.example` resolved off-site until
 * `isInternalPath` was hardened on the same day as this file. So this does the
 * parser's own work as well: resolve, compare origins, and hand back the
 * PARSER's same-origin path rather than the raw input, so the validator and the
 * navigation can never disagree about what was approved.
 *
 * ★ AND TWO DESTINATIONS ARE REFUSED EVEN WHEN THEY ARE ON THIS ORIGIN
 * (adversarial review, 2026-09-19):
 *   • `/login` itself, because the cap is keyed on the destination and
 *     `?next=/login?next=/login?next=/wallet` is a different destination at
 *     every hop — a chain that walks straight past a per-destination cap, one
 *     full server render per link, chosen entirely by whoever sends the URL.
 *   • anything under `/api/`, because `?next=` navigates a browser that has
 *     just been handed a fresh session, and pointing that at an arbitrary
 *     internal GET is a category nobody needs. No legitimate `?next=` is an
 *     API route.
 *
 * ★ WHY IT READS `window.location` AND NOT `useSearchParams()`. That hook forces
 * the page that uses it to be client-rendered or wrapped in `<Suspense>`, and
 * this value is never rendered — it is only read at the moment a redirect
 * happens. A plain function keeps the login page's rendering unchanged.
 */
export function loginDestination(): string {
  if (typeof window === 'undefined') return '/';
  const next = new URLSearchParams(window.location.search).get('next') ?? '';
  if (!next || !isInternalPath(next)) return '/';

  try {
    const resolved = new URL(next, window.location.origin);
    if (resolved.origin !== window.location.origin) return '/';
    const path = resolved.pathname;
    if (path === '/login' || path.startsWith('/login/')) return '/';
    if (path.startsWith('/api/')) return '/';
    return `${path}${resolved.search}${resolved.hash}`;
  } catch {
    return '/';
  }
}

/**
 * `basePath` is configured (`next.config.js` reads `NEXT_PUBLIC_BASE_PATH`) and
 * production runs at the root, so this is empty today. It matters anyway:
 * `router.replace('/wallet')` prepends the base path and `location.replace`
 * does not, so leaving this out would make a base-path deployment 404 on the
 * one route off the sign-in page.
 */
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

/**
 * Leave the sign-in door for `dest` with a DOCUMENT load. Returns true if it
 * navigated.
 *
 * `userInitiated` marks a navigation the reader asked for by pressing a sign-in
 * control. Those are never capped and they clear the count: a completed sign-in
 * that silently goes nowhere is a worse outcome than any loop, because it looks
 * to the reader like their account stopped working. Only the page's automatic
 * "you are already signed in" effect is subject to the cap, which is the one
 * that can fire again and again without anybody asking it to.
 *
 * `replace`, not `assign`: the sign-in door is not a place Back should return
 * to. `assign` pushes, which both strands the reader on a form they have
 * already passed AND lets a Back press spend one of their two bounces.
 */
export function leaveLoginFor(dest: string, { userInitiated = false }: { userInitiated?: boolean } = {}): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as LeavingWindow;
  if (w.__lumenLeavingFor === dest) return false;

  if (userInitiated) {
    clearBounce();
  } else if (bounceCountFor(dest) >= MAX_BOUNCES) {
    return false;
  } else {
    recordBounce(dest);
  }

  w.__lumenLeavingFor = dest;
  window.location.replace(`${BASE_PATH}${dest}`);
  return true;
}
