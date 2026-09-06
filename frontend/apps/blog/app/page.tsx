import HomeShell from '@/blog/features/discovery-feed/home-shell';
import { InitialFeedProvider } from '@/blog/components/observer-provider';
import { prefetchHomeFeed, newHomeFeedTrace } from '@/blog/lib/feed/feed-prefetch';
import { renderTimer, renderTimingEnabled } from '@ui/lib/render-timing';
import { getServerSessionUser } from '@/blog/lib/server-session';

/**
 * ★★ ONE `getServerSessionUser` UNSEAL PER REQUEST, NOT TWO (2026-09-06,
 * signed-in home build map item 4). This used to open and unseal the session
 * cookie a second time with its own `getIronSession` + `applyHiveSessionTtl
 * (canPersist: false)` call -- byte-for-byte the same decode the root layout
 * already does, two lines below, through `getServerSessionUser()`
 * (lib/server-session.ts), which is `React.cache()`-wrapped for exactly this
 * reason. Same `sessionOptions` import, same `canPersist: false` (this file
 * is a Server Component render, which cannot write cookies either way), so
 * delegating here is a like-for-like substitution for the overwhelming
 * majority of sessions -- and it means this call and the layout's share the
 * ONE unseal React memoised for the request instead of each paying the ~4
 * webcrypto thread-pool hops (PBKDF2 + HMAC verify + AES-GCM decrypt) that
 * showed up as 286-605ms `session=` values under contention in tonight's
 * samples.
 *
 * ★ THIS CLOSES ONE OF THE REQUEST'S TWO UNSEALS, NOT BOTH (correction,
 * 2026-09-06 review -- an earlier version of this header claimed "one unseal
 * per request", full stop, which overstates what changed here). A signed-in
 * home render still pays a SECOND, separate unseal: `getLiteSession()` in
 * `lib/feed/feed-prefetch.ts`, its own `React.cache()`-wrapped function over
 * the same cookie under a DIFFERENT policy (`canPersist: true`, plus the
 * lite-tier TTL check `getServerSessionUser()` does not run -- see that
 * function's own doc for why the two are deliberately not merged). That
 * function's doc and `lib/lite/http/session.ts`'s own comment both account
 * for it correctly: three cookie unseals per request are now TWO --
 * `getServerSessionUser()` (this one, shared with the root layout) and
 * `getLiteSession()` (shared across its own two call sites in
 * `feed-prefetch.ts`) -- not one.
 *
 * ★ ONE SMALL, DELIBERATE BEHAVIOUR CHANGE (2026-09-06, review, worth stating
 * rather than glossing over): the OLD inline read here considered a session
 * signed in whenever `session.user?.isLoggedIn` was truthy, full stop --
 * `viewer` fell back to `''` if `username` happened to be missing, but
 * `signedIn` itself did not depend on it. `getServerSessionUser()` requires
 * BOTH `isLoggedIn` AND a non-empty `username` (`lib/server-session.ts`'s own
 * `if (session.user?.isLoggedIn && session.user.username)`), else it returns
 * `SIGNED_OUT`. For every session this app actually issues the two conditions
 * always travel together, so this is not expected to change what any real
 * cookie renders as -- but a session somehow carrying `isLoggedIn: true` with
 * no `username` would have shown the SIGNED-IN shell before and now renders
 * the SIGNED-OUT one instead.
 */
async function readSession(): Promise<{ signedIn: boolean; viewer: string }> {
  const session = await getServerSessionUser();
  return { signedIn: session.isLoggedIn, viewer: session.isLoggedIn ? session.username : '' };
}

export default async function HomePage() {
  // ★★★ RENDER TIMING FOR THE SIGNED-IN HOME, OFF UNLESS `LUMEN_RENDER_TIMING=yes`
  // (2026-09-05). Measured on prod, headless, sealed session: signed-in home is
  // 1159ms TTFB cold / 602ms warm, against 84ms for the (edge-served) anonymous
  // one -- and nothing said which await that was. Three deadlines can each buy a
  // piece of it (`PREFETCH_TIMEOUT_MS` here, the root layout's tags prefetch and
  // its 150ms rank-tier race), so an outside number cannot settle it. Same
  // instrument the profile already carries; see `@ui/lib/render-timing`.
  //
  // The ROOT LAYOUT emits its own `render-timing: root-layout` line for its own
  // awaits. Compare the two totals: they say whether the layout and this page
  // overlap or stack, which no single line can.
  const timer = renderTimer('home');
  const { signedIn, viewer } = await readSession();
  // The iron-session cookie decode (AES-GCM unseal + the Hive TTL check), which is
  // pure CPU with no network -- so a large number here is event-loop contention,
  // not latency.
  timer.mark('session');
  // Written by `prefetchHomeFeed`, never read by it. Facts that exist only inside
  // that call (stored-feed hit/miss/stale, which seed won, the sub-stage costs)
  // have to reach this one line somehow.
  //
  // ★ ALLOCATED ONLY WHEN THE FLAG IS ON (2026-09-05, review), because its
  // presence is also the switch that starts the four stopwatches inside
  // `prefetchHomeFeed`. Ungated, a production render paid for a trace object and
  // eight `performance.now()` calls to produce a line nobody would log.
  // `renderTimingEnabled()` is one env property read, no allocation.
  const trace = renderTimingEnabled() ? newHomeFeedTrace() : undefined;
  const feed = await prefetchHomeFeed(viewer, timer, trace);
  // ★ ONE LINE PER RENDER, e.g.
  //   render-timing: home user=bozz stored=hit ranked=true source=recsys count=20
  //   read=6ms block=3ms trim=9ms session=11ms race=21ms total=33ms
  // and, when the personalised feed was not ready:
  //   render-timing: home user=bozz stored=stale ranked=false
  //   source=trending-fallback count=20 read=4ms block=8ms trim=-1ms session=11ms
  //   race=5ms trend=701ms assemble=9ms total=726ms
  // `-1ms` means NOT MEASURED (the stage never ran on the path taken), never
  // "instant" -- the convention `renderStopwatch` documents. `user` and every
  // other field is sanitised by the helper to `[a-z0-9.-]`, 32 characters, so a
  // session value can never forge a second field on this line.
  // The `??` fallbacks are for the flag-OFF shape only, where `trace` is absent
  // and `done()` is the shared no-op: nothing here is ever logged in that case.
  timer.done({
    user: viewer || 'anon',
    stored: trace?.stored ?? 'skip',
    ranked: String(trace?.ranked ?? false),
    source: trace?.source ?? 'none',
    count: trace?.count ?? 0,
    read: `${trace?.readMs ?? -1}ms`,
    // `blockMs` is `number | 'timeout'` (feed-prefetch.ts's `HomeFeedTrace`):
    // the literal `block=timeout` means `boundedBlockedKeySet` lost its own
    // 500ms race and the seed was dropped -- but a NUMBER here is NOT proof
    // that bound was respected (correction, 2026-09-06 review). The clock
    // starts before the `getLiteSession()` unseal that precedes the bounded
    // lookup, which is itself unbounded (see `session=` above for the
    // 286-605ms it can cost under contention), so `block=` measures "unseal
    // plus lookup", not the lookup alone -- live `stored=hit` lines have
    // logged `block=898ms` and `block=510ms`, both past the 500ms
    // `boundedBlockedKeySet` itself enforces. Read this field as how long the
    // step took, never as evidence the bound held -- see `HomeFeedTrace`'s
    // own `blockMs` doc and `boundedBlockedKeySet`'s doc comment in
    // feed-prefetch.ts for what IS actually bounded.
    block: trace?.blockMs === 'timeout' ? 'timeout' : `${trace?.blockMs ?? -1}ms`,
    trim: `${trace?.trimMs ?? -1}ms`
  });
  return (
    <InitialFeedProvider value={feed}>
      <HomeShell showIntro={!signedIn} />
    </InitialFeedProvider>
  );
}
