import type { IncomingMessage, ServerResponse } from 'http';
import { getIronSession, IronSession } from 'iron-session';
import { sessionOptions, HIVE_SESSION_TTL_MS } from '@smart-signer/lib/session';
import { IronSessionData } from '@smart-signer/types/common';

/**
 * F-L39 (2026-08-12): the ONE place every call site in THIS package should
 * read its `app_session` cookie through, instead of calling
 * `getIronSession(req, res, sessionOptions)` directly.
 *
 * WHY THIS EXISTS. F-L38 (`packages/smart-signer/lib/session.ts`,
 * `hiveSessionIssuedAt` in `packages/smart-signer/types/common.ts`) added a
 * server-enforced expiry for full-Hive sessions, to replace the one
 * iron-session's own seal `ttl` used to provide for free before J6's
 * `maxAge: undefined` forced that `ttl` to 0 (byte-level proof in
 * session.ts). F-L38 could only WIRE that check into `getLiteSession()`
 * (apps/blog/lib/lite/http/session.ts) — the one Hive-session-touching call
 * site that job owned — and said so explicitly in both files: "`login.ts`
 * ... and the OAuth/consent/chat-token handlers still call
 * `getIronSession(req, res, sessionOptions)` directly and were out of THIS
 * job's ownership." Every direct call site in this package therefore
 * enforced no expiry at all. Proven live: a 400-day-old sealed cookie
 * (28x past the 14-day TTL) got a 403 "cannot grant OAuth consent" from
 * `/api/auth/consent` — i.e. it passed the `isLoggedIn && username` auth
 * gate — while the same cookie got a 401 from `/api/retention/goal`, which
 * reads through `getLiteSession()` and does enforce the stamp.
 *
 * This function is the fix: one accessor, used everywhere in this package,
 * so the check can never again be "out of scope" for whoever adds the next
 * route.
 *
 * ★ MIRRORS, DOES NOT SHARE, `getLiteSession()`'s "HIVE TTL" BLOCK.
 * `packages/smart-signer` cannot import from `apps/blog` — the dependency
 * direction runs the other way; `apps/blog/lib/lite/http/session.ts` already
 * imports `sessionOptions` and `HIVE_SESSION_TTL_MS` FROM this package. So
 * the expire-if-stale / backfill-if-absent logic below is a deliberate,
 * independent copy of that block's logic, not a shared function call.
 * ★★ IF YOU CHANGE THE POLICY HERE, CHANGE IT THERE TOO (and vice versa):
 * apps/blog/lib/lite/http/session.ts, function `getLiteSession()`, the block
 * headed "---- HIVE TTL (F-L38 ...) ----". Nothing enforces these two copies
 * stay identical except this comment.
 *
 * ★ WHY THE `isLite` GUARD. A lite session and a full-Hive session are
 * indistinguishable at the cookie layer (see session.ts) — a lite user's
 * browser could in principle send its cookie to one of this package's
 * Hive/OAuth-flow routes too. Lite sessions are expired by a DIFFERENT stamp
 * (`sessionIssuedAt`, declared only via module augmentation inside
 * apps/blog/lib/lite/http/session.ts — not even a visible field from inside
 * this package) under a DIFFERENT policy (reject-if-missing, not
 * backfill-if-missing; see that block's LEGACY POLICY comment for why the
 * tiers deliberately differ). Running the Hive backfill below against a lite
 * session would be wrong on two counts — it would stamp a field that tier's
 * policy never reads, and do nothing to close lite's own expiry gap — so
 * this function scopes itself to `!isLite` and leaves lite enforcement
 * exactly where F-L37 put it. A lite session that reaches one of this
 * package's routes directly, bypassing `getLiteSession()`, is left exactly
 * as unenforced as it was before this fix — a real, narrow, pre-existing gap
 * this function does not close (see the F-L39 report for which routes that
 * could apply to). Lite accounts are gated dark (`liteConfig.enabled`) as of
 * this date; Hive is today's live production traffic, which is why F-L38 and
 * this follow-up both prioritized it.
 */
export async function getAppSession(
  req: IncomingMessage,
  res: ServerResponse
): Promise<IronSession<IronSessionData>> {
  const session = await getIronSession<IronSessionData>(req, res, sessionOptions);
  await applyHiveSessionTtl(session, { canPersist: true });
  return session;
}

/**
 * The Hive-session expiry policy itself, in ONE place.
 *
 * ★ WHY THIS IS A FUNCTION AND NOT A THIRD COPY. This policy was written twice
 * — once in `getLiteSession()` and once here — and the ONLY thing keeping the
 * two identical was a comment asking the next reader to remember. A third copy
 * was about to be added for the App Router reader in
 * `apps/blog/lib/server-session.ts`. Hand-synced duplicates of an auth rule are
 * precisely how the original hole opened: F-L38 wired the check into the one
 * call site it owned, and every other call site silently enforced nothing.
 * So the policy lives here and the readers call it.
 *
 * `canPersist` is the one genuine difference between the callers, and it is a
 * platform constraint rather than a policy choice: a Pages Router handler may
 * write `Set-Cookie` freely, while an App Router Server Component render may
 * not (Next.js throws "Cookies can only be modified in a Server Action or Route
 * Handler"). When persistence is unavailable the backfill still applies to the
 * in-memory session so THIS request is judged correctly; it is simply
 * recomputed on the next one.
 */
export async function applyHiveSessionTtl(
  session: IronSession<IronSessionData>,
  { canPersist }: { canPersist: boolean }
): Promise<void> {
  const isLite = session.user?.account_tier === 'lite';
  if (session.user && !isLite) {
    if (session.hiveSessionIssuedAt !== undefined) {
      if (Date.now() - session.hiveSessionIssuedAt > HIVE_SESSION_TTL_MS) {
        // Stale: blank `session.user` in place, same as `getLiteSession()`'s
        // HIVE TTL block. Every caller in this package already treats a
        // falsy `session.user` as "signed out" (that is the whole shape of
        // the bug this closes — see registerConsent/getChatToken/getUser
        // below), so no per-caller branching is needed beyond the import
        // swap.
        session.user = undefined;
        session.hiveSessionIssuedAt = undefined;
      }
    } else {
      // No stamp. This is every Hive session issued before this deploy
      // (login.ts never wrote this field until this same change added it at
      // issuance — see login.ts). Backfilling rather than treating "no
      // stamp" as expired avoids mass-logging-out every live user the
      // instant this ships; the TTL clock simply starts counting from the
      // first time any request reads the session through this function,
      // exactly the trade-off F-L38 made for `getLiteSession()`'s own
      // callers.
      session.hiveSessionIssuedAt = Date.now();
      // Persist only where the platform allows it. A Pages Router
      // `NextApiHandler`/`GetServerSideProps` context may write `Set-Cookie`
      // freely; an App Router Server Component render may not, and Next.js
      // throws "Cookies can only be modified in a Server Action or Route
      // Handler" if you try. The try/catch is belt-and-braces for the same
      // reason `getLiteSession()` wraps its equivalent write: the backfill is
      // an optimisation, never a correctness requirement, so failing to store
      // it must not fail the request.
      if (canPersist) {
        try {
          await session.save();
        } catch {
          // Not persistable in this context. The in-memory stamp above still
          // makes THIS request judge correctly; the next one recomputes it.
        }
      }
    }
  }
}
