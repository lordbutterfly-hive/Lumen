/**
 * A REAL, POPULATED, SIGNED-IN SESSION FOR TESTERS — without handing anyone a key.
 *
 * ★ WHY THIS EXISTS (owner ruling, 2026-08-08: "if they need an account give
 * them the hbd-temp account").
 *
 * Every tester until now signed up a brand-new lite account and browsed as a
 * person with no history: no follows, no feed, no wallet, no posts, no
 * notifications. Almost every screen they judged was an EMPTY STATE, and an
 * empty state looks correct no matter how broken the populated one is. That is
 * the single biggest reason testers kept reporting "clean" on pages the owner
 * broke in seconds.
 *
 * Lumen's only full-Hive sign-in is Hive Keychain, a browser extension that a
 * headless tester cannot use. So instead of shipping a posting key around (which
 * would leak it into transcripts, logs and screenshots forever), this mints the
 * same iron-session cookie the server itself issues, sealed with the running
 * server's own secret, and hands back a Playwright storageState.
 *
 * WHAT THIS SESSION CAN DO: everything the SERVER decides — the real feed of a
 * real account, its follows, profile, wallet reads, Lumen-local votes/follows,
 * and every lite write that goes through the publisher.
 *
 * WHAT IT CANNOT DO: sign a Hive transaction in the browser. Chain signing needs
 * the key in the extension, which this deliberately does not have. If a flow
 * fails asking for Keychain, that is the boundary — report it as untestable, do
 * not report it as broken.
 */

import { sealData } from 'iron-session';
import { readFileSync } from 'node:fs';

/**
 * ★★★ READ THE FILE THE SERVER ACTUALLY RUNS ON (fixed 2026-08-09).
 *
 * This pointed at `.env.blog`, whose
 * `DENSER_SERVER_SECRET_COOKIE_PASSWORD` is the checked-in placeholder
 * `CHANGE_ME_GENERATE_UNIQUE_SECRET` — 32 characters, which is exactly
 * iron-session's minimum, so it seals happily and never errors. The running
 * server takes its secret from `apps/blog/.env.local` (49 characters, real).
 *
 * Two different keys means the cookie this mints CANNOT open on the server. It
 * does not fail: `getIronSession` just yields an empty session, `/api/users/me`
 * answers `isLoggedIn:false`, and the tester browses the LOGGED-OUT product
 * while their harness tells them they are signed in as a populated account.
 *
 * So the feature built on 2026-08-08 to stop testers judging empty states has
 * never once worked, and silently recreated the exact problem it was written to
 * solve. Three testers hit it independently on 2026-08-09 and each had to
 * diagnose it by hashing `/proc/<pid>/environ`. The file's own comment above
 * already warns about this failure shape for `APP_NAME` — the same trap, one
 * variable over.
 */
const ENV_FILES = [
  '/home/clauderfly/hive-blog-rebuild/apps/blog/.env.local',
  '/home/clauderfly/hive-blog-rebuild/.env.blog'
];

/** Read one variable out of the env files without printing the file or the value. */
function envValue(name) {
  for (const file of ENV_FILES) {
    let contents;
    try {
      contents = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const line = contents.split('\n').find((l) => l.startsWith(`${name}=`));
    if (line) return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  throw new Error(`${name} not set in any of: ${ENV_FILES.join(', ')}`);
}

/**
 * @param {string} username Hive account to appear as. Default `hbd-temp` — the
 *   shared frontend account, which has real history to look at.
 * @returns Playwright storageState object; pass to browser.newContext({ storageState }).
 */
export async function signedInStorageState(username = 'hbd-temp') {
  const password = envValue('DENSER_SERVER_SECRET_COOKIE_PASSWORD');
  // The cookie is named `${APP_NAME}_session` (see smart-signer/lib/session.ts,
  // which builds the prefix from react-env's `APP_NAME`). react-env exposes it
  // under the REACT_APP_ prefix, so that is the variable to read — reading
  // `APP_NAME` instead silently falls back to "app" and mints a cookie the
  // server never looks at, which fails as a SILENT signed-out session.
  const appName = envValue('REACT_APP_APP_NAME');

  // Same shape the real login handler stores. `loginType: 'keychain'` is what a
  // full Hive account signs in as; the browser never needs the key for reads.
  const user = {
    isLoggedIn: true,
    username,
    avatarUrl: `https://images.hive.blog/u/${username}/avatar`,
    loginType: 'keychain',
    authenticateOnBackend: false,
    account_tier: 'full'
  };

  const sealed = await sealData({ user }, { password, ttl: 60 * 60 * 24 * 14 });

  // ★★ THE COOKIE NAME WAS ALSO WRONG (2026-08-09) — a SECOND, independent
  // cause of the same silent-anonymous session.
  //
  // `smart-signer/lib/session.ts` builds the name as
  // `${env('APP_NAME') || 'app'}_session`, where `env` is react-env. Server-side
  // that lookup comes back empty, so the running server falls back to `app_` —
  // confirmed live: its own Set-Cookie headers read `app_login_challenge`.
  // This helper instead read `REACT_APP_APP_NAME`, which is defined (as `blog`)
  // only in `.env.blog`, and so minted `blog_session`: a cookie the server never
  // reads, which fails as a signed-out session with no error. Note the existing
  // comment above asserts the opposite mapping — it was measured wrong.
  //
  // Rather than re-derive that and risk being wrong a third time, try the real
  // candidates and keep whichever the SERVER actually accepts. The server is the
  // authority on its own cookie name; guessing is what broke this twice.
  const candidates = [...new Set(['app', appName].filter(Boolean))].map((n) => `${n}_session`);
  const cookieName = await resolveCookieName(candidates, sealed, username);

  // ★★★ PROVE IT BEFORE HANDING IT OVER (2026-08-09).
  //
  // A cookie that does not open is INDISTINGUISHABLE from being signed out:
  // 200s all the way down, plausible content, no error. That is precisely how
  // this helper shipped broken and stayed broken — every tester who used it
  // reported on the logged-out product under a "signed in as hbd-temp" label,
  // and a page that is merely EMPTY looks correct however broken its populated
  // version is.
  //
  // `_honesty.md` rule 8: a check with nothing to inspect must FAIL. The same
  // applies to a session with nobody in it. Ask the server who this is, and
  // refuse to return a session it does not recognise.

  return {
    cookies: [
      {
        name: cookieName,
        value: sealed,
        domain: 'localhost',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax'
      }
    ],
    origins: []
  };
}

/**
 * Ask the running server to identify the sealed cookie, and throw a diagnosis —
 * not a bare failure — if it will not.
 */
async function resolveCookieName(candidates, sealed, username) {
  const base = process.env.QA_BASE || 'https://localhost:3443';
  let last = null;
  for (const name of candidates) {
    let body;
    try {
      const res = await fetch(`${base}/api/users/me`, { headers: { cookie: `${name}=${sealed}` } });
      body = await res.json();
    } catch (error) {
      throw new Error(
        `qa/harness/session.mjs: could not reach ${base}/api/users/me to verify the session ` +
          `(${String(error).slice(0, 120)}). Is the app running, and are you invoking node with ` +
          `NODE_EXTRA_CA_CERTS=$HOME/hive-blog-rebuild/.tls/cert.pem?`
      );
    }
    if (body?.isLoggedIn && body.username === username) return name;
    last = body;
  }

  throw new Error(
    `qa/harness/session.mjs: the server REFUSED this session — /api/users/me answered ` +
      `isLoggedIn=${last?.isLoggedIn} username="${last?.username ?? ''}" (wanted "${username}"), ` +
      `for every candidate cookie name tried: ${candidates.join(', ')}.\n` +
      `\nDo NOT test with this: you would be driving the LOGGED-OUT product while believing ` +
      `you are signed in, which is how this helper silently produced false "clean" reports.\n` +
      `\nAlmost always the cookie was sealed with a different ` +
      `DENSER_SERVER_SECRET_COOKIE_PASSWORD than the running server uses. Compare the value in ` +
      `apps/blog/.env.local (what \`pnpm start\` loads) against .env.blog — on 2026-08-09 the ` +
      `latter still held the literal placeholder CHANGE_ME_GENERATE_UNIQUE_SECRET. Report this ` +
      `to the coordinator as an ENVIRONMENT blocker, not as a product defect.`
  );
}
