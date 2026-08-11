// This file is a wrapper with defaults to be used in both API routes
// and `getServerSideProps` functions.
import type { SessionOptions } from 'iron-session';
import env from '@beam-australia/react-env';

export const cookieNamePrefix = `${env('APP_NAME') || `app`}_`;

/**
 * F-L38 (2026-08-11): server-enforced maximum age for a full-Hive session,
 * independent of the cookie's own Max-Age/Expires (deliberately absent, see
 * the `maxAge: undefined` comment below) and independent of iron-session's
 * seal `ttl` (forced to 0 by that same setting — same comment, byte-level
 * proof). Without SOME expiry, a leaked Hive cookie STRING authenticates
 * forever, bounded by nothing.
 *
 * 14 days, matching two existing numbers rather than inventing a third:
 * (a) it is exactly what `fourteenDaysInSeconds` gave every Hive session
 * before J6 — iron-session's own default `ttl` — so this restores the
 * ORIGINAL bound instead of picking a new one; (b) `liteConfig.sessionTtlDays`
 * (apps/blog/lib/lite/config.ts) is the same 14, for the same "oidc.ts
 * convention" reason (spec §A.5). One number for "how long a session may
 * live" across both account tiers.
 *
 * Configurable, matching this codebase's convention for every other tunable
 * TTL/rate value (see `LITE_*` knobs in apps/blog/lib/lite/config.ts): how
 * long a leaked cookie stays dangerous vs. how often an active user is asked
 * to sign in again is an operator judgment call, not something this
 * file should lock in unilaterally.
 *
 * ★ ENFORCEMENT LIVES IN `apps/blog/lib/lite/http/session.ts`'s
 * `getLiteSession()`, NOT here — this module only holds cookie/session
 * CONFIG, never per-request logic, and that split is kept. See that file, and
 * the long comment on `hiveSessionIssuedAt` in
 * `packages/smart-signer/types/common.ts`, for why enforcement could only be
 * wired in there and not at every place a Hive session is issued or read —
 * this job's ownership did not extend to `login.ts` or the other
 * `getIronSession(req, res, sessionOptions)` call sites, which is a real,
 * stated gap, not an oversight.
 */
const rawHiveSessionTtlDays = Number(process.env.HIVE_SESSION_TTL_DAYS);
export const HIVE_SESSION_TTL_DAYS =
  Number.isFinite(rawHiveSessionTtlDays) && rawHiveSessionTtlDays > 0 ? rawHiveSessionTtlDays : 14;
export const HIVE_SESSION_TTL_MS = HIVE_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

export const sessionOptions: SessionOptions = {
  password: process.env.DENSER_SERVER_SECRET_COOKIE_PASSWORD as string,
  cookieName: `${cookieNamePrefix}session`,
  // secure: true should be used in production (HTTPS) but can't be used
  // in development (HTTP)
  cookieOptions: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    // J6 (2026-08-11): "no maxAge key" here used to LOOK like a session cookie
    // but was not one. iron-session fills in a maxAge for you when the key is
    // absent — `getSessionConfig` in node_modules/iron-session/dist/index.js:
    // `else { options.cookieOptions.maxAge = computeCookieMaxAge(options.ttl) }`
    // — and `options.ttl` defaults to iron-session's own 14-day
    // `fourteenDaysInSeconds` when this object doesn't set `ttl` (it never
    // did). Confirmed live: running this exact object through the installed
    // iron-session (v8.0.4) emitted `Set-Cookie: ...; Max-Age=1209540; ...`
    // for a fresh login — a ~14-day PERSISTENT cookie, which is why closing
    // and reopening the browser kept the owner signed in.
    //
    // `maxAge: undefined` is iron-session's own documented recipe for a real
    // session cookie (dist/index.d.ts: "If you want to use 'session cookies'
    // ... you need to pass cookieOptions: { maxAge: undefined }"), and it
    // works — no Expires/Max-Age is emitted, verified live.
    //
    // TRADE-OFF, verified by reading BOTH libraries, not assumed: the same
    // `getSessionConfig` branch that honors `maxAge: undefined` also forces
    // `options.ttl = 0` — unconditionally, regardless of any `ttl` this
    // object might set. `ttl` is what iron-session hands to iron-webcrypto's
    // `seal()`, which embeds the expiry INSIDE the sealed cookie value itself
    // (node_modules/.pnpm/iron-webcrypto@1.2.1/.../dist/index.js:233 —
    // `const expiration = opts.ttl ? now + opts.ttl : "";`). With ttl=0 that
    // line embeds NO expiration at all, and `unseal()`'s expiry check
    // (same file, line ~266: `if (expiration) {...}`) never fires. So a
    // session cookie in this library version has no seal-side expiry either
    // — there is no configuration of iron-session 8.0.4 that gives both a
    // true session cookie AND an independent server-side ttl. A stolen COOKIE
    // VALUE (not the browser session) will keep working until the user signs
    // out; closing the browser is what now actually ends the session, per
    // the owner's explicit ask, but it is the only backstop for this path.
    // A real fix for the stolen-cookie-value case needs its own
    // application-level expiry (e.g. an issued-at stamp checked by every
    // reader, the way lite sessions already do revocation via
    // `sessionEpoch`/`sessionId` in apps/blog/lib/lite/http/session.ts) —
    // out of scope for J6: it would need changes in every route that reads
    // this cookie, none of which that job owned.
    //
    // F-L38 (2026-08-11) adds exactly that stamp — `hiveSessionIssuedAt`,
    // see `IronSessionData` in packages/smart-signer/types/common.ts — but
    // it is CHECKED, not written, in every route: it is only ever persisted
    // by `getLiteSession()` in apps/blog/lib/lite/http/session.ts, the one
    // Hive-session-touching call site this later job owned. `login.ts` (the
    // actual issuance point) and the OAuth/consent/chat-token handlers still
    // call `getIronSession(req, res, sessionOptions)` directly and were out
    // of THIS job's ownership too — see the long comment in that file for
    // exactly what that gap does and does not cover.
    maxAge: undefined,
  },
};
