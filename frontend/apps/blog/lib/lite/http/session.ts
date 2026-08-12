import { cookies } from 'next/headers';
import { getIronSession, IronSession } from 'iron-session';
import { sessionOptions } from '@smart-signer/lib/session';
import { applyHiveSessionTtl } from '@smart-signer/lib/get-session';
import { IronSessionData } from '@smart-signer/types/common';
import { liteConfig } from '../config';
// NOTE (F-L37, 2026-08-11): `liteConfig.sessionTtlDays` is imported again.
// J6 made it mechanically dead (see the long comment inside getLiteSession()
// for why) by making the cookie a true browser-session cookie, which as a
// side effect strips iron-session's own seal-level expiry. This file now
// enforces the TTL itself, independent of iron-session — see getLiteSession().
//
// F-L38 (2026-08-11, same day): the SAME iron-session mechanism strips the
// expiry from a full-HIVE session cookie too — that regression was never
// lite-specific, F-L37 just fixed the tier that happened to be under active
// development. `getLiteSession()` now enforces a Hive-session TTL as well,
// scoped so it never interferes with the lite check above. See both blocks
// inside getLiteSession() and the long comment on `hiveSessionIssuedAt` in
// packages/smart-signer/types/common.ts for why the two are enforced
// differently (Hive is live production traffic; lite, as of this date, is
// not — see liteConfig.enabled).

/**
 * App Router iron-session access for lite-account routes. Reuses the app's
 * existing `sessionOptions` (same encrypted cookie), so a lite session and a
 * full-Hive session are indistinguishable at the cookie layer — only the
 * `account_tier` field differs. Server-side only; call inside route handlers.
 */

// F-L3: augment the SHARED IronSessionData INTERFACE (legally, from our tree —
// `User` is a `type` alias and cannot be declaration-merged) so `sessionEpoch`
// is a typed SIBLING of `session.user`, never `session.user.sessionEpoch`
// (ts2353 on the alias). Stamped at issue (auth-service.issueSession) and
// compared against the DB row on every acting request (checkLiteActorById).
declare module '@smart-signer/types/common' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface IronSessionData {
    sessionEpoch?: number;
    /**
     * WHICH DEVICE this cookie is, so a sign-out can revoke one session instead of
     * the account. Random per issue, stamped alongside the epoch and never read as
     * input from anywhere but the cookie itself; a listed id is refused
     * (repositories/session-revocation-repository.ts).
     *
     * Optional forever: cookies issued before this existed carry none, and for
     * those the epoch check stands alone exactly as it did — deploying per-device
     * revocation must not sign anybody out.
     */
    sessionId?: string;
    /**
     * F-L37 (2026-08-11): epoch-ms timestamp, stamped the instant a session
     * becomes authenticated (the `set` trap at the bottom of getLiteSession()
     * below), independent of iron-session's own seal `ttl`.
     *
     * Why this has to exist at all: making the cookie a true browser-session
     * cookie (F-L3 revised, J6) forces iron-session's seal ttl to 0, which
     * means iron-webcrypto embeds NO expiry in the sealed cookie VALUE any
     * more — see the long comment in getLiteSession() for the byte-level
     * proof. Without an expiry we track ourselves, a leaked cookie STRING
     * (independent of the browser session that issued it) would stay valid
     * forever, bounded only by session_epoch / per-device revocation, neither
     * of which fires on the mere passage of time.
     *
     * Optional, and MUST stay optional: every cookie sealed before this field
     * existed carries none. See the LEGACY POLICY comment in getLiteSession()
     * for how that case is handled — a deliberate choice, not an oversight.
     */
    sessionIssuedAt?: number;
  }
}

export async function getLiteSession(): Promise<IronSession<IronSessionData>> {
  // F-L3 (revised, J6, 2026-08-11): this used to wire `sessionTtlDays` into a
  // real cookie maxAge — a genuine, persistent ~14-day cookie that survived
  // closing the browser. The owner's report ("closing the browser must sign
  // you out") is exactly that: this cookie was outliving the browser session
  // by design, which is the bug for J6.
  //
  // `maxAge: undefined` is iron-session's documented way to emit a real
  // session cookie (no Expires/Max-Age at all) — verified against the
  // installed iron-session 8.0.4 source and live output, see the long
  // comment in packages/smart-signer/lib/session.ts for the exact lines.
  //
  // OBSERVABLE BEHAVIOUR CHANGE, stated plainly: a lite session no longer
  // survives a closed-and-reopened browser at all, whereas before it could
  // survive up to `sessionTtlDays` (14) days. That is the deliberate,
  // requested trade.
  //
  // WHAT F-L3 CANNOT KEEP, and why: the same iron-session branch that grants
  // `maxAge: undefined` also forces its internal seal `ttl` to 0 (see the
  // sibling comment for the exact source lines), which means the sealed
  // cookie VALUE itself no longer carries any expiry either — iron-webcrypto
  // embeds no expiration timestamp when ttl is falsy, so `sessionTtlDays`
  // can no longer be mechanically enforced via cookie maxAge OR seal ttl in
  // this library.
  //
  // F-L37 (2026-08-11) replaces that lost enforcement with an
  // application-level one, entirely below, and it does NOT need a check
  // added to every caller individually — one check here, inside the shared
  // accessor, is inherited by every caller for free.
  //
  // ★ CORRECTED (2026-08-11, later the same day). The previous revision of
  // this comment claimed the caller list was closed: "every
  // apps/blog/app/api/lite/* route, the two permlink page/layout readers,
  // and auth-service.ts's own issueSession/resolveLogin/completeSignup" —
  // and used that claim to justify applying the lite TTL/expiry policy to
  // every session this function returns. THAT CLAIM WAS FALSE, and it is
  // exactly what hid the bug fixed today: this function is also called by
  // `apps/blog/app/api/retention/goal/route.ts` and
  // `apps/blog/app/api/feed/for-you/route.ts` (twice) — both outside
  // `app/api/lite/*`, both reading `session.user` for FULL-HIVE users too —
  // so the lite-only expiry policy was blanking `session.user` for every
  // Hive session on those two routes (no `sessionIssuedAt`, ever, since a
  // Hive login writes via `login.ts`, not through here). Re-grepped just
  // now (`grep -rn getLiteSession`, repo-wide) to get the real list instead
  // of estimating it:
  //
  //   - every `apps/blog/app/api/lite/*` route (unaffected by today's fix:
  //     lite-tier sessions get exactly the same policy as before).
  //   - `apps/blog/app/api/retention/goal/route.ts` — reads
  //     `user.userId || user.username` for ANY logged-in user, lite or Hive
  //     (see that file's `actorKey()`). This is the bug: FIXED by scoping
  //     the TTL check to `isLite` below, so a Hive session now passes
  //     through untouched by the lite policy.
  //   - `apps/blog/app/api/feed/for-you/route.ts` — twice: once for the
  //     block-list actor, once for `viewer`/`chainObserver` resolution. Same
  //     bug, same fix.
  //   - `apps/blog/app/api/account/upgrade/route.ts` — twice, but reads only
  //     `session.user?.userId`, which is always `undefined` for a Hive
  //     session regardless of any TTL policy — genuinely lite-scoped in
  //     effect, not by construction. Unaffected either way.
  //   - `apps/blog/app/[param]/[p2]/[permlink]/page.tsx` and `layout.tsx` —
  //     the two Server Component readers, each reading only
  //     `session.user?.userId` — same reasoning as upgrade/route.ts above:
  //     harmless for a Hive session either way, and these are also the two
  //     call sites that CANNOT persist a cookie write (Next.js forbids
  //     `cookies().set(...)` outside a Server Action/Route Handler), which
  //     is why the Hive-TTL backfill below is wrapped in try/catch.
  //   - `apps/blog/lib/lite/auth/auth-service.ts` — `issueSession`,
  //     `resolveLogin`, `completeSignup`. Always assigns a lite-shaped
  //     `session.user` (`account_tier: 'lite'`); never touches a Hive
  //     session.
  //
  // The lesson, stated so it does not repeat: "every route under one
  // directory" is not the same claim as "every caller of this function",
  // and a shared accessor's blast radius has to be re-verified by grep, not
  // re-asserted from memory, every time its policy changes.
  //
  // CLONE the shared options (never mutate the packages export) so the
  // full-Hive session cookie config object identity is untouched — only lite
  // routes flow through getLiteSession. This adds no DB read: getLiteSession
  // is called PRE-AUTH by completeSignup before any user row exists, so it
  // must stay a pure cookie accessor — still true below, the added logic is
  // pure in-memory cookie-payload bookkeeping (plus, for the Hive backfill
  // below, a best-effort cookie WRITE — see that block for why it is safe).
  const opts = {
    ...sessionOptions,
    cookieOptions: {
      ...sessionOptions.cookieOptions,
      maxAge: undefined
    }
  };
  const session = await getIronSession<IronSessionData>(cookies(), opts);

  // ══════════════════════════════════════════════════════════════════════
  // THE DISCRIMINATOR — which TTL policy below applies, if either.
  //
  // `getLiteSession()` is NOT lite-only (see the corrected caller-list
  // comment at the top of this function): a full-Hive login
  // (packages/smart-signer/lib/api-handlers/auth/login.ts) never calls this
  // function to WRITE its session, but plenty of routes call it to READ
  // whatever cookie is present, Hive or lite — retention/goal, feed/for-you,
  // and the permlink page/layout among them. F-L37's original mistake (bug
  // fixed today) was applying the LITE expiry policy to every session this
  // function saw, Hive included, which silently signed Hive users out of
  // every route that reads `session.user` through here.
  //
  // `account_tier === 'lite'` is the discriminator, matching the ONE other
  // place in the codebase that already makes this exact distinction
  // (apps/blog/lib/auth-utils.ts's `getObserver()`: "account_tier !== 'lite'"
  // gates whether a session's username is a real Hive account). Reusing it
  // rather than inventing a second test keeps the two in lockstep by
  // construction.
  //
  // ★ WHY A CLIENT CANNOT SPOOF THIS FIELD. `account_tier` lives INSIDE the
  // sealed cookie payload — the same authenticated-encrypted blob as `user`
  // itself, not a separate readable cookie or header. iron-webcrypto seals
  // with AES-256-CBC and then computes a SEPARATE SHA-256 HMAC over the
  // entire ciphertext (node_modules/.pnpm/iron-webcrypto@1.2.1/.../dist/
  // index.js:220-238 `seal()`); unsealing recomputes that HMAC and compares
  // it in constant time before decrypting anything (same file, :283-287
  // `fixedTimeComparison(...)` / `throw new Error("Bad hmac value")`).
  // Flipping a single byte anywhere in the sealed string — including
  // whatever byte encodes `account_tier` — makes the HMAC not match, and
  // iron-session's own `unsealData` (node_modules/.pnpm/iron-session@8.0.4/
  // .../dist/index.js:91-96) specifically catches that "Bad hmac value"
  // message and returns `{}`: an EMPTY session, i.e. signed out, never a
  // session with a client-chosen tier. Forging a tampered-but-valid seal
  // requires `DENSER_SERVER_SECRET_COOKIE_PASSWORD`, which never reaches the
  // client. So `account_tier` is exactly as trustworthy as `session.user`
  // itself — both are decided once, server-side, at issue.
  const isLite = session.user?.account_tier === 'lite';

  // ---- LITE TTL (F-L37, 2026-08-11 — RESCOPED today to fix the bug above) ----
  if (session.user && isLite) {
    const ttlMs = liteConfig.sessionTtlDays * 24 * 60 * 60 * 1000;
    // LEGACY POLICY, decided deliberately (not an oversight): a session with
    // NO `sessionIssuedAt` — i.e. every single lite cookie live right now,
    // all minted earlier today under J6's maxAge:undefined change, before
    // this stamp existed — is treated as EXPIRED, the same as one that is
    // genuinely too old. The alternative (grandfather no-stamp cookies in as
    // valid) would leave every cookie already live, and any already leaked,
    // exactly as immortal as they are right now — it would not close the
    // hole this fix exists to close, only stop it from getting worse. The
    // cost is real but small: lite accounts are still gated dark
    // (`liteConfig.enabled`, spec) pending infra/legal sign-off, so this is
    // presently dev/QA traffic, not production users — everyone with a live
    // lite session gets signed out once on this deploy and re-authenticates
    // (one wallet signature / Google prompt) to receive a stamped cookie.
    // Chosen to match this codebase's own established fail-closed precedent
    // (LS-2, F-L30, ECON-1: ambiguous/missing state is treated as the unsafe
    // state, never the safe one).
    //
    // ★ THIS "GRANDFATHER = UNSAFE" LOGIC IS **NOT** REUSED FOR HIVE, BELOW,
    // ON PURPOSE. Lite is pre-launch dev/QA traffic; Hive is today's live
    // production user base. Applying the same "no stamp = expired" rule to
    // Hive would sign out every currently-logged-in real user the instant
    // this deploys — trading one bug (unbounded leaked cookies) for a much
    // worse one (mass logout). See the HIVE TTL block for the policy that
    // was chosen instead, and why.
    const expired = session.sessionIssuedAt === undefined || Date.now() - session.sessionIssuedAt > ttlMs;
    if (expired) {
      // Clear the LITE fields in place so every caller sees exactly what it
      // would see for an absent cookie (`session.user` falsy — every actor
      // gate in http/actor.ts keys off that). Deliberately NOT
      // `session.destroy()` or `session.save()`: both call next/headers
      // `cookies().set(...)`, which Next.js refuses outside a Server Action
      // or Route Handler ("Cookies can only be modified..."). getLiteSession
      // is also called from plain Server Component renders
      // (app/[param]/[p2]/[permlink]/{page,layout}.tsx) — calling either
      // there would throw on every request from an expired session instead
      // of quietly signing it out. The stale cookie stays in the browser,
      // which is harmless: it re-seals the same too-old (or absent)
      // `sessionIssuedAt` on every future request and is refused here again,
      // every time. `oauthState` is deliberately left untouched — it belongs
      // to the full-Hive OAuth flow that shares this cookie's shape, not to
      // lite session lifetime, and this expiry is scoped to the lite path
      // only.
      session.user = undefined;
      session.liteSignup = undefined;
      session.sessionEpoch = undefined;
      session.sessionId = undefined;
      session.sessionIssuedAt = undefined;
    }
  }

  // ---- HIVE TTL (F-L38, 2026-08-11 — new) ----
  //
  // A logged-in, NON-lite session (`account_tier` absent or 'full' — a real
  // Hive login never sets 'lite') gets a DIFFERENT policy from the lite one
  // above, for the production-traffic reason stated there. Two sub-cases:
  //
  //   1. STAMPED AND STALE -> expire, exactly like lite (in-memory only, for
  //      the same "Server Component cannot write cookies" reason).
  //   2. NO STAMP AT ALL -> this is EVERY Hive session alive right now
  //      (login.ts was out of this job's ownership and could not be edited
  //      to write this field at issue — see the comment on
  //      `hiveSessionIssuedAt` in packages/smart-signer/types/common.ts).
  //      Rather than treat that as expired (mass sign-out of live users) or
  //      leave it permanently unenforced (the bug this exists to close),
  //      BACKFILL it here: stamp it now and attempt to PERSIST that stamp,
  //      so the TTL clock starts counting from the first time any route
  //      covered by this job's fix reads the session, and holds from then on.
  //
  // Persisting the backfill needs `session.save()`, which — like
  // `session.destroy()` above — throws when called from a Server Component
  // render (the permlink page/layout). Unlike the expiry branch, skipping
  // the write here is NOT harmless: an in-memory-only stamp is discarded the
  // instant this request ends, so the very next read would see "no stamp"
  // again and the check would never actually bind to anything — a check
  // that always passes is worse than no check. So this is wrapped in its own
  // try/catch: it persists whenever this call happens to run inside a Route
  // Handler (in practice, nearly every navigation hits at least one — any
  // `/api/lite/*` call, `/api/feed/for-you`, or `/api/retention/goal`), and
  // silently no-ops for THIS request when it does not, retrying on the next
  // request through any such route. A Hive user whose entire session is
  // spent exclusively on the two Server-Component permlink readers, and
  // nothing else, would never get backfilled — a real, narrow, stated gap;
  // both of those readers only ever consult `session.user?.userId` (always
  // undefined for a Hive account), so it has no other effect on them.
  // ★ ONE POLICY, FIVE READERS (updated F-L40, 2026-08-12). This block used to be
  // a hand-copied twin of the one in `packages/smart-signer/lib/get-session.ts`,
  // kept in step only by a comment asking the next reader to remember. That is
  // the same failure mode that opened the hole this policy exists to close:
  // F-L38 wired the check into the one call site it owned and every other
  // reader enforced nothing. The policy now lives in `applyHiveSessionTtl`, and
  // every reader that touches a Hive session calls it: this one, `getAppSession`,
  // `apps/blog/lib/server-session.ts`'s `getServerSessionUser`, and — closed by
  // F-L40, found by grepping `getIronSession` repo-wide rather than trusting the
  // "three readers" count above, which was itself already stale —
  // `apps/blog/lib/auth-utils.ts`'s `getObserver` and `apps/blog/app/page.tsx`'s
  // `hasSession`. Re-verify this list by grep, not by re-reading this comment,
  // the next time a call site is added: that is exactly the mistake this policy
  // exists to stop repeating.
  // `canPersist: true` — this accessor is reached from Route Handlers, where the
  // write is legal; the helper swallows the Server-Component case described above.
  await applyHiveSessionTtl(session, { canPersist: true });

  // Stamp the tier-appropriate "issued at" field the instant `session.user`
  // is assigned a truthy value on a session that does not already carry
  // one — i.e. exactly at issue, never on a later mutation of an
  // already-stamped, still-valid session. Today this only ever fires for
  // lite (`sessionIssuedAt`, via auth-service.ts's issueSession/resolveLogin/
  // completeSignup, all of which assign a lite-shaped user and call
  // `session.save()` themselves right after) — no code path assigns a
  // full-Hive `session.user` through this Proxy, because login.ts bypasses
  // this function entirely (hence the read-side backfill above, which is
  // what actually enforces the Hive TTL today). The `hiveSessionIssuedAt`
  // branch is kept anyway so this trap stays CORRECT — not just currently
  // unreached-and-harmless — if a future caller ever does assign a Hive user
  // through `getLiteSession()`.
  //
  // Implemented as a Proxy `set` trap rather than wrapping `session.save`,
  // because iron-session defines `save`/`destroy`/`updateConfig` as
  // non-configurable, non-writable properties (node_modules/iron-session/
  // dist/index.js: `Object.defineProperties(session, { save: { value: ... } })`
  // with no `writable`/`configurable`, which default to `false`). Reassigning
  // `session.save` throws (`Cannot assign to read only property`), and a
  // Proxy `get` trap that returned a different function for `save` would
  // violate the Proxy invariant for non-configurable data properties and
  // throw too (verified against both the spec rule and the installed
  // library's own defineProperties call before choosing this shape).
  // Intercepting the `user` WRITE has neither problem: `user` is an ordinary
  // writable, configurable data property, so wrapping it needs no special
  // case and breaks no invariant.
  return new Proxy(session, {
    set(target, prop, value, receiver) {
      if (prop === 'user' && value) {
        if (value.account_tier === 'lite') {
          if (target.sessionIssuedAt === undefined) target.sessionIssuedAt = Date.now();
        } else if (target.hiveSessionIssuedAt === undefined) {
          target.hiveSessionIssuedAt = Date.now();
        }
      }
      return Reflect.set(target, prop, value, receiver);
    }
  });
}

export async function destroyLiteSession(): Promise<void> {
  const session = await getLiteSession();
  session.destroy();
  // Clear the analytics parity cookie set at login.
  cookies().set('account_info', '', { path: '/', maxAge: 0 });
}
