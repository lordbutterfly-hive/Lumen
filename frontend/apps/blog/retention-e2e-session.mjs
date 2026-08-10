/**
 * Shared logged-in-session helper for the retention E2E fan-out (2026-08-09).
 *
 * The retention surfaces (Today card, nudge, left-rail showcase, own-profile voice)
 * are ALL gated on `user.isLoggedIn`, so none of them can be verified signed out.
 * This seeds a session the same two-sided way `playwright/tests/support/fixture-auth/
 * seeder.ts` does, because seeding only the cookie leaves the CLIENT anonymous:
 *
 *   - the iron-session cookie satisfies the server (`/api/users/me`)
 *   - `localStorage['user']` satisfies the client (`useUserCore` hydrates from it
 *     via `initialData` with `refetchOnMount: false`)
 *
 * PREREQUISITE, already done: the dev server on :3000 was restarted with
 *   REACT_APP_APP_NAME=blog
 *   DENSER_SERVER_SECRET_COOKIE_PASSWORD=<the FIXTURE password below>
 * so the cookie this seals actually validates. Proven: /api/users/me -> 200
 * {"isLoggedIn":true,"username":"gtg",...}. Do NOT restart the dev server; you will
 * lose that config and every session will silently go anonymous.
 *
 * Run scripts from /home/clauderfly/hive-blog-rebuild/apps/blog so `playwright` and
 * `iron-session` resolve. Only CHROMIUM is installed.
 */
import { chromium } from 'playwright';
import { sealData } from 'iron-session';

export const COOKIE_PASSWORD = 'fixture-tests-dummy-cookie-password-not-a-secret';
export const COOKIE_NAME = 'blog_session';
export const BASE = 'http://localhost:3000';

/**
 * Cold routes on this dev server compile on demand and can take 30-250s. Every wait
 * in a retention test needs to be generous or you will report a false negative — a
 * component that renders `null` while its query is in flight looks identical to a
 * component that is broken.
 */
export const COLD_NAV_MS = 300_000;
export const SETTLE_MS = 120_000;

/**
 * @param {object} over  overrides, e.g. { username: 'lordbutterfly' } or
 *                       { account_tier: 'lite' }
 */
export async function loggedInPage(over = {}) {
  const user = {
    isLoggedIn: true,
    username: 'gtg',
    avatarUrl: '',
    loginType: 'hbauth',
    authorizationCategory: 'posting',
    account_tier: 'full',
    strict: false,
    ...over
  };

  // ★ A LITE SESSION IS NOTHING WITHOUT `userId` (found 2026-08-09 by the lite-path
  // agent, which hit a bare `{"error":"unauthorized"}` despite `isLoggedIn: true`).
  //
  // `requireLiteUser` (lib/lite/http/actor.ts) keys off `sessionUser.userId`, not the
  // username — a real lite session always carries it (`buildLiteSessionUser` in
  // lib/lite/session/lite-session.ts) because a lite account's identity IS the ULID;
  // its handle is display only. So seeding a lite tier without one produces a session
  // the SERVER accepts for `/api/users/me` and REJECTS for every `/api/lite/*` route,
  // which reads as "the lite retention route is broken" when it is the fixture that is.
  //
  // Callers may still pass their own `userId`; this only fills the gap. Find real ones
  // with:
  //   docker exec lumen-b12-pg psql -U qa -d lite \
  //     -c "SELECT user_id, username FROM lumen_user LIMIT 5;"
  if (user.account_tier === 'lite' && !user.userId) {
    throw new Error(
      'seeding a lite session requires a userId (the ULID from lumen_user.user_id) — ' +
        'without it every /api/lite/* route 401s while /api/users/me still says logged in'
    );
  }
  const sealed = await sealData({ user }, { password: COOKIE_PASSWORD });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([
    {
      name: COOKIE_NAME,
      value: sealed,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax'
    }
  ]);
  await ctx.addInitScript(
    ([u]) => {
      try {
        window.localStorage.setItem('user', u);
      } catch {}
    },
    [JSON.stringify(user)]
  );
  const page = await ctx.newPage();
  return { browser, ctx, page, user };
}

/**
 * A genuinely ANONYMOUS page — no cookie, no localStorage seed.
 *
 * ★ USE THIS INSTEAD OF `loggedInPage({ isLoggedIn: false })` (found 2026-08-09 by the
 * /ranks agent). "Logged in" is derived from the PRESENCE of a valid sealed session, not
 * from the `isLoggedIn` field inside it — so passing `isLoggedIn: false` still seals a
 * cookie, and the server still answers `isLoggedIn: true`. An agent testing the
 * signed-out branch that way is silently testing the signed-in one.
 */
export async function anonPage() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  return { browser, ctx, page };
}

/** Assert the session really took. Call this FIRST or a failure is unattributable. */
export async function assertLoggedIn(page) {
  const r = await page.request.get(`${BASE}/api/users/me`);
  const body = await r.json().catch(() => ({}));
  if (!body.isLoggedIn) {
    throw new Error(`session did not take: ${r.status()} ${JSON.stringify(body).slice(0, 120)}`);
  }
  return body;
}

/** Visible text of a testid, or null when absent. Trimmed and whitespace-collapsed. */
export async function textOf(page, testid, timeout = 20_000) {
  const l = page.locator(`[data-testid="${testid}"]`).first();
  try {
    await l.waitFor({ state: 'visible', timeout });
  } catch {
    return null;
  }
  return (await l.innerText()).replace(/\s+/g, ' ').trim();
}
