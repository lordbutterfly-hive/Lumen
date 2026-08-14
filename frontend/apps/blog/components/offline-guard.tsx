'use client';

import {
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore
} from 'react';
import { useRouter } from 'next/navigation';
import {
  AppRouterContext,
  type AppRouterInstance
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { WifiOff } from 'lucide-react';
import { toast } from '@ui/components/hooks/use-toast';
import { useTranslation } from '@/blog/i18n/client';

/**
 * ★★★ THE APP MUST NOT BE REPLACED BY CHROME'S ERROR PAGE WHEN THE NETWORK DROPS.
 *
 * MEASURED, 2026-08-13, production build behind https://localhost:3443, real
 * Chromium with the context toggled offline. Signed in AND signed out, three
 * separate navigation kinds — the "Following" feed tab (imperative
 * `router.replace`), a header `<Link>` to `/wallet`, and a post permalink
 * `<Link>` — every one of them ended with `page.url()` at
 * `chrome-error://chromewebdata/`, `document.body.innerText` reading
 * "ERR_INTERNET_DISCONNECTED", and NOTHING of Lumen left on screen. It only
 * came back on a reload once the connection returned. Two facts that a prior
 * QA report got wrong and that this comment exists to correct:
 *
 *   1. It is NOT about being signed in. Signed out reproduces identically. The
 *      variable is only WHICH URL you click: the landing URL is served from the
 *      seeded prefetch cache with no network at all, so re-tapping the tab you
 *      are already on looks safe. Any other URL fetches, and fails.
 *   2. It is NOT specific to the feed tabs. EVERY client navigation in the app
 *      does it, `<Link>` included — so a guard bolted onto the feed tabs alone
 *      would have fixed the one reported click and left the whole app exposed.
 *
 * WHY NO ERROR BOUNDARY CAN CATCH IT (verified in the installed Next 14.2.23,
 * so nobody re-derives this): `router-reducer/fetch-server-response.js:110-121`
 * catches the failed RSC `fetch()` and returns the URL as a *string* instead of
 * flight data; `reducers/navigate-reducer.js:124-126` reads that string as
 * "external URL" and sets `mpaNavigation`; `app-router.js:396-406` then calls
 * `window.location.replace()` AS A SIDE EFFECT IN RENDER (Next's own comment
 * there: "Don't try this at home, kids."). Nothing throws — so `app/error.tsx`,
 * `app/global-error.tsx` and the four scoped boundaries are all irrelevant —
 * and a document navigation cannot be cancelled once it has started. The only
 * place left to intervene is BEFORE the router is handed the navigation.
 *
 * WHY A PRIVATE NEXT IMPORT. `next/link` gets its router from
 * `useContext(AppRouterContext)` (`next/dist/client/link.js:129`, then
 * `router[replace ? "replace" : "push"](...)` at `:89`), and so does every
 * `useRouter()` call site in this app (39 of them). Re-providing that one
 * context with a guarded copy is therefore a SINGLE choke point that covers
 * every `<Link>`, every `BasePathLink`, and all 39 imperative calls at once —
 * versus patching 39 call sites and still missing every link. The import path
 * is internal to Next; if a future upgrade moves it the BUILD FAILS LOUDLY,
 * which is the failure mode to prefer. The alternative shapes were considered
 * and rejected: a service worker (large, brings its own cache-staleness
 * problems, and this app has none), patching Next in `node_modules` (not app
 * code), and monkey-patching the router object in place (same internals
 * dependency but fails SILENTLY if Next ever recreates the object).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not make Lumen work offline —
 * Lumen reads a chain over the network and cannot. It keeps the reader inside
 * the app and tells them what happened, which is the whole bar.
 *
 * HONEST LIMITS, none of which this can close from app code:
 *   - `navigator.onLine` is the browser's own guess. A connection that dies
 *     BETWEEN the check and Next's `fetch()`, or a captive-portal Wi-Fi that
 *     reports "online" with no route to the internet, still ejects. This
 *     narrows the window to near-zero for the ordinary "lost signal" case; it
 *     does not eliminate it.
 *   - The browser's own Back/Forward buttons are outside the app entirely.
 *   - `BasePathLink` does `window.location.href = ...` for `/@user` links when
 *     `NEXT_PUBLIC_BASE_PATH` is set (it is empty on this deployment, so that
 *     branch is dead here). A full document navigation cannot be intercepted
 *     after the fact; the click handler below prevents the click first, which
 *     covers it for as long as that stays a click-driven path.
 *   - A navigation whose target happened to be sitting in the router's prefetch
 *     cache WOULD have completed with no network, and is now blocked with an
 *     honest message instead. That trade is deliberate: the entries live 30 s
 *     (auto) to 5 min (full), and the page they would render is one whose every
 *     client query then fails anyway.
 */

/** Toasting on every tap of a dead link would be its own kind of broken. */
const NOTICE_THROTTLE_MS = 1500;

function subscribeToConnectivity(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/**
 * Read at CALL time, never off React state: the guard below runs inside a click
 * handler, where the freshest possible answer is the one the browser has right
 * now — and reading it directly is also what keeps the guarded router's
 * identity stable across connectivity changes (see the `useMemo` deps).
 */
const browserIsOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

interface OfflineState {
  /**
   * ★ USE THIS IN EVENT HANDLERS, never `offline` below. MEASURED on this build:
   * the browser's `offline` event arrives 1-248 ms after the connection drops,
   * but React had painted the consequence anywhere from 2 ms to 2436 ms later.
   * A click that lands inside that window would sail past a React-state gate and
   * eject the app, which is the entire bug. This reads the browser at call time,
   * so it is correct from the moment the connection goes.
   */
  isOffline: () => boolean;
  /**
   * FOR RENDERING ONLY — it lags the real event (see above). Correct for showing
   * a banner, wrong for deciding whether a navigation may proceed.
   */
  offline: boolean;
  /** Say, once, that the thing the reader just tried needs a connection. */
  notifyBlocked: () => void;
}

/**
 * Defaults are a safe no-op so a component using `useOffline()` outside the
 * provider (a test, a storybook, the wallet app) behaves exactly as it does
 * today rather than blocking navigation it cannot explain.
 */
const OfflineContext = createContext<OfflineState>({
  offline: false,
  isOffline: () => false,
  notifyBlocked: () => {}
});

/**
 * For controls that navigate WITHOUT the router — e.g. a tab that also moves
 * local state, which must not move when the navigation behind it cannot happen.
 */
export function useOffline(): OfflineState {
  return useContext(OfflineContext);
}

export default function OfflineGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { t } = useTranslation('common_blog');

  // `useSyncExternalStore` rather than useState+useEffect: the server snapshot
  // is explicitly `false`, so the server and the first client render agree and
  // there is no hydration mismatch, and every subscriber shares one answer.
  const offline = useSyncExternalStore(
    subscribeToConnectivity,
    () => !navigator.onLine,
    () => false
  );

  // Latest-ref: keeps `t` (which changes when the language changes) and the
  // throttle timestamp out of the memo below, so the guarded router object is
  // created once per real router and never churns.
  const notifyRef = useRef<() => void>(() => {});
  const lastNoticeAt = useRef(0);
  useEffect(() => {
    notifyRef.current = () => {
      const now = Date.now();
      if (now - lastNoticeAt.current < NOTICE_THROTTLE_MS) return;
      lastNoticeAt.current = now;
      toast({ title: t('global.offline_title'), description: t('global.offline_blocked') });
    };
  });

  const guardedRouter = useMemo<AppRouterInstance>(() => {
    const guard =
      <Args extends unknown[]>(navigate: (...args: Args) => void) =>
      (...args: Args) => {
        if (browserIsOffline()) {
          notifyRef.current();
          return;
        }
        navigate(...args);
      };

    // `back`/`forward` are left alone: history moves are restored from the
    // client cache without a network round trip, and the browser's own buttons
    // do the same thing without asking us. `prefetch` is left alone because
    // Next already swallows its own failures, and blocking it would leave links
    // un-prefetched after the connection returned.
    return {
      ...router,
      push: guard(router.push),
      replace: guard(router.replace),
      refresh: guard(router.refresh)
    };
  }, [router]);

  // The router guard covers everything that goes THROUGH the router. A handful
  // of places in this app still use a plain `<a href="/...">` (creator studio,
  // proposals help), which is a full document navigation the router never sees
  // — and that is the version that paints the browser error page hardest.
  // Capture phase, and `preventDefault` only (never `stopPropagation`): a
  // `<Link>`'s own React handler still runs, still calls the guarded router,
  // still gets blocked, and the throttle above collapses the two notices into
  // one.
  //
  // ★ ATTACHED ALWAYS, AND IT ASKS THE BROWSER ITSELF. This was gated on the
  // `offline` React state, which is a window I can measure and cannot defend:
  // across three runs the browser's `offline` event landed 1-248 ms after the
  // connection was cut, and React had rendered the consequence 2 ms, 412 ms and
  // 2436 ms later. A state-gated listener simply is not attached for that long,
  // so any click in it is unguarded — I did not have to observe an eject in that
  // window to know the guard was not covering it. Reading the browser inside the
  // handler removes the window entirely, for one boolean per click while online.
  useEffect(() => {
    const onClickCapture = (event: MouseEvent) => {
      if (!browserIsOffline()) return;
      if (event.defaultPrevented || event.button !== 0) return;
      // A modified click opens a new tab/window and leaves this page intact.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      // Off-site links are the browser's problem, and `mailto:`/`hive://` etc.
      // are handed to another app entirely — neither one destroys this page.
      if (url.origin !== window.location.origin) return;
      // A jump to an anchor on the page you are already reading needs no
      // network. Blocking that would break in-page navigation for no reason.
      if (url.hash && url.pathname === window.location.pathname && url.search === window.location.search)
        return;
      event.preventDefault();
      notifyRef.current();
    };
    document.addEventListener('click', onClickCapture, true);
    return () => document.removeEventListener('click', onClickCapture, true);
  }, []);

  const value = useMemo<OfflineState>(
    () => ({ offline, isOffline: browserIsOffline, notifyBlocked: () => notifyRef.current() }),
    [offline]
  );

  return (
    <AppRouterContext.Provider value={guardedRouter}>
      <OfflineContext.Provider value={value}>
        {children}
        {/* The live region is in the DOM at all times and only its CONTENT
            changes, so screen readers announce the message. A region inserted
            together with its own text is not reliably announced. It never
            takes a click: `pointer-events-none` on the wrapper, and nothing
            inside it is interactive. */}
        <div
          role="status"
          aria-live="polite"
          /* Centred on phones, where the toast viewport is TOP-anchored
             (packages/ui/components/toast.tsx:17 — `top-0 sm:bottom-0
             sm:right-0`), and hard left from `sm` up, where that viewport moves
             to bottom-right and a centred pill runs straight underneath the
             toast this same guard raises — measured overlapping at 1280px. */
          className={`pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center sm:justify-start ${
            offline ? 'p-3' : ''
          }`}
        >
          {offline ? (
            <div
              data-testid="offline-banner"
              className="flex items-center gap-2 rounded-full border border-line-warn-3 bg-surface-43 px-4 py-2 font-sans text-[13px] leading-[20px] text-ink-27 shadow-[0_2px_8px_rgba(20,18,10,0.25)]"
            >
              <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{t('global.offline_banner')}</span>
            </div>
          ) : null}
        </div>
      </OfflineContext.Provider>
    </AppRouterContext.Provider>
  );
}
