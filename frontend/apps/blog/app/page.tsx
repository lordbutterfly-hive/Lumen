import { cookies } from 'next/headers';
import { getIronSession } from 'iron-session';
import { sessionOptions } from '@smart-signer/lib/session';
import { applyHiveSessionTtl } from '@smart-signer/lib/get-session';
import type { IronSessionData } from '@smart-signer/types/common';
import { getLogger } from '@ui/lib/logging';
import HomeShell from '@/blog/features/discovery-feed/home-shell';
import { InitialFeedProvider } from '@/blog/components/observer-provider';
import { prefetchHomeFeed, newHomeFeedTrace } from '@/blog/lib/feed/feed-prefetch';
import { renderTimer, renderTimingEnabled } from '@ui/lib/render-timing';

const logger = getLogger('app');

async function readSession(): Promise<{ signedIn: boolean; viewer: string }> {
  const cookieStore = cookies();
  try {
    const session = await getIronSession<IronSessionData>(cookieStore, sessionOptions);
    await applyHiveSessionTtl(session, { canPersist: false });
    const signedIn = Boolean(session.user?.isLoggedIn);
    return { signedIn, viewer: signedIn ? (session.user?.username ?? '') : '' };
  } catch (error) {
    logger.error(error, 'home: could not read session');
    return { signedIn: false, viewer: '' };
  }
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
    block: `${trace?.blockMs ?? -1}ms`,
    trim: `${trace?.trimMs ?? -1}ms`
  });
  return (
    <InitialFeedProvider value={feed}>
      <HomeShell showIntro={!signedIn} />
    </InitialFeedProvider>
  );
}
