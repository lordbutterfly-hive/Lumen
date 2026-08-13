import '@hive/tailwindcss-config/globals.css';
import * as Sentry from '@sentry/nextjs';
import { ReactNode } from 'react';
import { Metadata } from 'next';
import { cookies } from 'next/headers';
import AppHeader from '../features/layouts/app-header';
import ClientEffects from '../features/layouts/site-header/client-effects';
import ScrollReset from '../features/layouts/scroll-reset';
import { ServerSessionProvider } from '../features/layouts/server-session';
import { Providers } from '../features/layouts/providers';
import { getServerSessionUser } from '../lib/server-session';
import { StorageCleanup } from '@hive/ui';
import CondenserMigration from '../components/condenser-migration';
import OfflineGuard from '../components/offline-guard';
import { getEnvVersion } from '../lib/env-version';
import { Open_Sans, Lora } from 'next/font/google';
import { siteConfig } from '@ui/config/site';

// Redesign typography (design-handoff-v2, 2026-07-21): Open Sans for ALL UI —
// headers, nav, labels, chips, buttons, tabs, table headers and numbers
// (tabular-nums) — and Lora for running body prose. The handoff is explicit:
// "ONLY two families ... no Inter, no serif display face." Self-hosted via
// next/font so it complies with the app CSP (font-src 'self'). The CSS-variable
// names are deliberately kept (--font-inter / --font-source-serif) so the whole
// tailwind + denser font pipeline downstream needs no change — only the family
// bound to each variable swaps.
const openSans = Open_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-inter',
  display: 'swap'
});
const lora = Lora({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-source-serif',
  display: 'swap'
});

// Get basePath from build-time environment
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

const SITE_DESC =
  'Communities without borders. A social network owned and operated by its users, powered by Hive.';

const metadata = {
  metadataBase: new URL(process.env.REACT_APP_SITE_DOMAIN || 'https://hive.blog'),
  title: {
    default: siteConfig.name,
    template: `%s - ${siteConfig.name}`
  },
  description: SITE_DESC,
  icons: {
    icon: '/favicon.ico'
  },
  openGraph: {
    type: 'website',
    siteName: siteConfig.name,
    title: siteConfig.name,
    description: SITE_DESC,
    // TODO(branding): these still point at hive.blog's own share images — no
    // Lumen-branded og/twitter share image exists anywhere in public/images/
    // yet. Left as a real, working image rather than a 404 on a guessed path;
    // swap once a real asset exists.
    images: ['https://hive.blog/images/hive-blog-share.png']
  },
  twitter: {
    card: 'summary',
    // No real Lumen social handle exists anywhere in this codebase
    // (siteConfig.links.twitter is itself a dead '/' placeholder) — omitting
    // `site` rather than keeping the unrelated official @hiveblocks handle.
    title: siteConfig.name,
    description: SITE_DESC,
    images: ['https://hive.blog/images/hive-blog-twshare.png']
  },
  other: {
    // Real placeholder removed: no Facebook App ID is configured anywhere in
    // this codebase, so the key is simply omitted rather than shipping a
    // literal 'YOUR_FB_APP_ID' string in production metadata.
  }
} as const satisfies Metadata;

export function generateMetadata(): Metadata {
  if (!process.env.REACT_APP_SENTRY_DSN) {
    return metadata;
  }

  return {
    ...metadata,
    other: {
      ...metadata.other,
      ...Sentry.getTraceData()
    }
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Server-side locale and language handling
  const cookieStore = cookies();
  const locale = cookieStore.get('NEXT_LOCALE')?.value || 'en';
  const isRTL = locale === 'ar';

  // Generate stable version hash for __ENV.js cache-busting
  // Only changes when REACT_APP_* env variables change
  const envVersion = getEnvVersion();

  // ★ The header and the left rail used to learn who you are only after React
  // mounted and `/api/users/me` came back, which on this app is 5-20s — so a
  // signed-in reader was served signed-out chrome for that whole window. This
  // request already carries the session cookie; read it once here and hand the
  // answer down. See features/layouts/server-session.tsx.
  const serverSession = await getServerSessionUser();

  return (
    <html lang={locale} dir={isRTL ? 'rtl' : 'ltr'} className={`${openSans.variable} ${lora.variable}`}>
      <head>
        {/* ★★★ THE ONLY THING THAT CAN CATCH A PURGED ROOT CHUNK (2026-08-11).
            `ChunkLoadError: Loading chunk app/layout failed` reached a real
            reader on /@lordbutterfly. `app/error.tsx` and `app/global-error.tsx`
            now detect and auto-reload on this too, but React error boundaries
            are code that itself lives in a chunk — measured in this repo: when
            `app/layout.js` fails to load, `app/error.js` and
            `app/global-error.js` usually fail in the SAME deploy purge, so
            neither boundary's code ever runs and the page is left on a stuck
            skeleton with no visible error at all. This script has no chunk of
            its own — it is inlined directly into the HTML document the server
            already sent — so it is the one thing that still runs no matter
            which of the app's OWN chunks are missing.

            ★★★ RAW native `<script>`, NOT `next/script strategy="beforeInteractive"`
            — CORRECTED 2026-08-11, this comment previously recorded the OPPOSITE
            conclusion and was WRONG. Retracted below with the measurement that
            replaced it, because a wrong comment here is what let this ship
            broken and stopped two later agents from re-checking it.

            THE BUG: `next/script` with no `src` does NOT inline your code. `curl
            localhost:3000/` on the OLD version of this file showed the served
            HTML was literally
            `<script>(self.__next_s=self.__next_s||[]).push([0,{"children":"...
            ","id":"lumen-chunk-error-guard"}])</script>` — the IIFE sat inertly
            as a JSON string on an array; nothing executed it. The code that
            drains that array — `appBootstrap()` /
            `loadScriptsInSequence()` in `next/dist/client/app-bootstrap.js` —
            ships INSIDE `main-app.js`, and is only invoked once `main-app.js`
            itself has finished loading. So: if `main-app.js` fails to load (the
            worst case this guard exists for), the queue is never drained and
            `window.addEventListener('error', ...)` is NEVER attached — the
            guard cannot catch the exact failure it exists for. Even when
            `main-app.js` DOES load, draining only happens after it finishes
            fetching + parsing + executing, which can lose the race against
            OTHER failing chunks' (near-instant) error events, registering the
            listener after those events already fired and went unheard.

            MEASURED, 2x2, on this repo's dev server (Playwright, `page.route`
            aborting requests; re-run clean after the coordinator's 16:00-16:02
            UTC server restart to rule out the wedged-server contamination a
            prior agent hit):

            (a) ALL `_next/static/chunks/**` blocked (deploy-purge worst case):
              - `next/script beforeInteractive`: NEVER attaches. `window.next`
                stays `undefined`, the guard's own DOM node never appears,
                `sessionStorage['lumen:chunk-reload-at']` stays `null` through a
                15s settle window, and a synthetic `ErrorEvent` dispatched
                afterward still does nothing. Reproduced twice, identical both
                times. This directly CONTRADICTS what this comment used to
                claim ("beforeInteractive caught the failure and reloaded on
                the first attempt" with all chunks blocked) — that measurement
                was never reproduced and is now believed to have tested the
                wrong artifact.
              - raw `<script>` (this file, now): attaches essentially
                instantly (present on the very first poll, well under the 0.5s
                poll interval). Fires, reloads (2 navigations observed), and on
                the repeat failure inside the cooldown renders
                `#lumen-chunk-error-card`. `sessionStorage` populated. This
                happens even though `main-app.js`/`webpack.js` are ALSO
                blocked and `window.next` never gets defined — this guard has
                zero dependency on the app's own bootstrap.
            (b) ONLY route-segment chunks blocked (`app/layout.js`,
                `app/page.js`, `app/error.js`; `main-app.js`/`webpack.js`
                allowed through — the more realistic single-deploy case):
              - `next/script beforeInteractive`: the 3 blocked chunks fail at
                ~t+4.5s / ~t+26.7s (two runs); the guard's own DOM node did not
                exist until ~t+11.5s / ~t+37.3s respectively — roughly a 7-11s
                gap in which nothing was listening, tracking `main-app.js`'s
                own load time. `sessionStorage` stayed `null` organically in
                THREE separate runs. A synthetic dispatch fired successfully
                once settled (proving the listener works once attached — it is
                purely a timing loss on the real failures, not a broken
                listener).
              - raw `<script>` (this file, now): attaches instantly regardless
                of `main-app.js` timing, fires organically on the real blocked
                chunks (observed reacting within ~2s of the failures),
                reloads, and shows the recovery card on repeat failure.
                `sessionStorage` populated. Reproduced three times, consistent
                every time.

            WHY the raw script wins even though it sits in the same JSX
            position: document order in the served HTML (unchanged by this
            fix) is Next's own `main-app.js`, `app-pages-internals.js`,
            `app/global-error.js`, `app/not-found.js`, `app/page.js`,
            `app/layout.js`, `app/error.js` — ALL as `<script async>`, which
            never block the HTML parser — THEN this script, THEN `__ENV.js`.
            Because none of those preceding tags are synchronous, the parser
            reaches this plain, non-async inline script and executes it
            essentially immediately, before any network request (even an
            already-in-flight one) can complete. Its error listener attaches
            before ANY chunk — including Next's own `main-app.js` — has a
            chance to fail. `next/script beforeInteractive`'s ordering
            guarantee is about WHEN THE CODE IS QUEUED, not when it runs; a
            plain synchronous inline script's ordering guarantee is about
            PARSE ORDER, which is the one that actually matters here.

            ★ BONUS: this also kills a years-open Next.js hydration bug
            (vercel/next.js#51242) this guard was ALSO triggering. The stub
            string above (`<script>(self.__next_s=...)`) is EXACTLY what a
            reported hydration warning showed as the client value — `Prop
            'dangerouslySetInnerHTML' did not match. Server: "" Client:
            "(self.__next_s=...)"` — because `next/script`'s own React
            component renders one thing during SSR and something else once
            `appBootstrap` has mutated the DOM under it. A plain native
            `<script>` is not special-cased by Next; React hydrates it like any
            other static-content DOM node, server and client render the
            identical string, and there is nothing to mismatch. Re-checked
            signed in on `/@lordbutterfly/settings` and
            `/@lordbutterfly/lists/blacklisted` after this change: zero
            console errors/warnings, zero hydration-mismatch text on either
            page.

            To reproduce: in Playwright, route every request under
            `_next/static/chunks` (glob: two-star, slash, that path, two-star —
            written out here with a space so this comment doesn't self-close on
            the literal star-slash) and abort ones matching either pattern above
            (all of them; or just `app/(layout|page|error)\.js$`), navigate to
            `/`, then poll `document.getElementById('lumen-chunk-error-guard')`,
            `sessionStorage.getItem('lumen:chunk-reload-at')`, and
            `typeof window.next` on an interval — that ad hoc harness (not
            committed) is what produced every number above.

            It only reloads once per 10 minutes (matches
            `lib/chunk-error-reload.ts`'s cooldown, same sessionStorage key by
            name) so a real outage does not reload the tab forever.

            ★ ITEM 4 (2026-08-11): reloading once used to be the WHOLE fix —
            if the SAME failure recurred inside that 10-minute cooldown (a
            real outage, not a one-off stale manifest), `reloadOnce` just
            returned and the tab was left on whatever it had, sometimes an
            entirely blank `document.body`, with nothing else running to
            explain why. Now a second failure inside the cooldown renders a
            dependency-free recovery card straight into `document.body` via
            plain DOM calls — no CSS chunk, no React, nothing this script
            doesn't already have. A manual "Reload" button deliberately
            bypasses the cooldown timer (a real click is not an automatic
            loop) and re-arms it so an immediate repeat failure shows the
            card again instead of silently retrying forever.

            ★ ITEM 5 (2026-08-11): REGRESSION FIX — item 4 shipped the card
            gated on cooldown alone, not on whether the app ever came up.
            Reproduced (Playwright): load the page NORMALLY (app mounts,
            header renders, `window.next` is an object), then set
            `sessionStorage['lumen:chunk-reload-at']` to 60s ago and dispatch
            one synthetic `Loading chunk 917 failed` `ErrorEvent` — the card
            painted `position:fixed;inset:0` over the fully working page,
            with one Reload control and no way back. Real-world path: a
            reader hits one transient chunk error, the guard reloads fine —
            but the cooldown key is now armed for 10 minutes. Any UNRELATED
            chunk error in that window (a lazily-imported component 404ing
            after a deploy, an offline blip, an extension aborting a
            request) then covers a working app with a full-screen "Something
            went wrong", and clicking Reload re-arms the key, so a repeat of
            that same failing lazy chunk shows the card again immediately.
            Before item 4 this case was a silent no-op (see
            `reloadOnceForChunkError` in `lib/chunk-error-reload.ts`, which
            still does nothing on a cooldown repeat for the React-boundary
            layer) — item 4 regressed it.

            THE FIX: `showRecoveryCard()` inside the cooldown branch is now
            gated on a new `appMounted` flag — a failed lazy chunk on an app
            that is actually up is a different event from a framework
            bootstrap that never ran, and only the latter earns a full-screen
            takeover; the former now falls back to the old silent no-op.

            HOW `appMounted` IS DETECTED, with no dependency on any app
            chunk: this script runs before React (see the parse-order
            argument above), so checked immediately it would always read
            "not mounted" — the check has to be DEFERRED. It listens once for
            the window `load` event (or reads `document.readyState ===
            'complete'` if that already passed) and only then, if NO chunk
            error was observed at any point up to that moment, marks
            `appMounted = true`. `load` — unlike `DOMContentLoaded` — waits
            for every subresource on the page to settle, success or failure,
            INCLUDING the `async` chunk `<script>` tags this guard watches;
            `DOMContentLoaded` fires before those async scripts are
            guaranteed to have even started, which would let `appMounted` go
            true before a real bootstrap failure had a chance to be caught,
            defeating the guard entirely. Because the guard's own `error`/
            `unhandledrejection` listeners are attached before any chunk
            request can complete (measured above), any chunk failure that is
            part of the actual page bootstrap always fires before `load`
            does — so the two measured true-positive matrices above are
            unaffected: (a) all chunks blocked — `load` never gets to fire
            "clean", `appMounted` stays false, card still shows on the
            repeat failure; (b) only route-segment chunks blocked — those
            still error before `load` settles, `appMounted` stays false, the
            card still shows correctly. Only a page that reaches `load` with
            zero chunk errors — i.e. one that has actually finished
            bootstrapping — sets the flag, and only a LATER, unrelated
            failure can then be silently ignored. This is a heuristic, not a
            proof (React 18 hydration can still be settling a Suspense
            boundary after `load`), but it fails toward the SAME behavior
            this codebase already ships elsewhere for the equivalent case
            (`reloadOnceForChunkError`'s no-op-in-cooldown), so a misread in
            either direction is a known, already-accepted outcome, not a new
            risk.

            DISMISS BUTTON — deliberately NOT added. The root cause of
            today's regression was the card showing over a working page; that
            path is now closed at the gate (`appMounted` true → no card, full
            stop) rather than patched with an escape hatch. The card can now
            ONLY render when `appMounted` is false, i.e. exactly when there is
            no evidence a working page exists underneath it — that is
            precisely the one state where a dismiss button would risk doing
            what the reviewer warned about, leaving the reader on a page that
            may be genuinely non-functional with the card gone and nothing
            else to do. Reload (a full document re-fetch) is the only action
            offered because it is the only one that is safe in every state
            the card can now legitimately appear in. */}
        <script
          id="lumen-chunk-error-guard"
          dangerouslySetInnerHTML={{
            __html: `(function () {
  var KEY = 'lumen:chunk-reload-at';
  var COOLDOWN_MS = 10 * 60 * 1000;
  var reloadTriggered = false;
  var cardShown = false;
  var chunkErrorSeen = false;
  var appMounted = false;
  function markAppMounted() {
    // Deferred, dependency-free 'did the app come up' check - see the ITEM 5
    // comment above for why this has to be the window load event (not
    // DOMContentLoaded, not an immediate check) and why the chunkErrorSeen
    // guard is required.
    if (!chunkErrorSeen) appMounted = true;
  }
  if (document.readyState === 'complete') {
    markAppMounted();
  } else {
    window.addEventListener('load', markAppMounted, { once: true });
  }
  function isChunkAssetUrl(src) {
    return typeof src === 'string' && src.indexOf('/_next/static/') !== -1;
  }
  function showRecoveryCard() {
    if (cardShown) return;
    cardShown = true;
    function render() {
      if (!document.body || document.getElementById('lumen-chunk-error-card')) return;
      var card = document.createElement('div');
      card.id = 'lumen-chunk-error-card';
      card.setAttribute('style',
        'position:fixed;inset:0;z-index:2147483647;display:flex;' +
        'align-items:center;justify-content:center;padding:24px;' +
        'background:#fafafa;font-family:system-ui,sans-serif;color:#161511;');
      card.innerHTML =
        '<div style="max-width:440px;border-radius:20px;border:1px solid #eee2dc;' +
        'border-left:3px solid #c0392b;background:linear-gradient(125% 130% at 0% 0%, ' +
        '#f7c9bd 0%, #fbdfd6 30%, #fdefe9 58%, #fffdfc 85%);padding:28px 28px 24px;' +
        'text-align:center;">' +
        '<p style="margin:0 0 6px;font-size:34px;font-weight:600;line-height:1.1;">Lumen</p>' +
        '<p style="margin:0 0 4px;font-size:15px;font-weight:600;">Something went wrong</p>' +
        '<p style="margin:0 0 20px;font-size:13px;line-height:1.55;color:#6b7280;">' +
        // The card can now be reached with no network (see reloadOnce), where
        // "reloading usually fixes it" would be a straight lie - reloading is
        // the one thing that cannot work. Say which one it is.
        (navigator.onLine === false
          ? 'You are offline, so this page could not finish loading. Reload once your connection is back.'
          : 'This page could not finish loading. Reloading usually fixes it.') +
        '</p>' +
        '<button type="button" id="lumen-chunk-error-reload" style="height:40px;' +
        'padding:0 20px;border-radius:14px;border:none;background:#c0392b;color:#fff;' +
        'font-size:14px;font-weight:600;cursor:pointer;">Reload</button></div>';
      document.body.appendChild(card);
      var btn = document.getElementById('lumen-chunk-error-reload');
      if (btn) {
        btn.addEventListener('click', function () {
          try { sessionStorage.setItem(KEY, String(Date.now())); } catch (e) {}
          location.reload();
        });
      }
    }
    if (document.body) {
      render();
    } else {
      document.addEventListener('DOMContentLoaded', render, { once: true });
    }
  }
  function reloadOnce() {
    chunkErrorSeen = true;
    if (reloadTriggered) return;
    // ★★★ NEVER RELOAD WITH NO NETWORK (2026-08-13). A reload is a fresh
    // document request; offline it cannot come back, so it lands on Chrome's
    // network-error page and the app is GONE - the exact outcome this guard
    // exists to prevent, self-inflicted. MEASURED: offline, one synthetic
    // 'Loading chunk 917 failed' on a fully working page put the tab on
    // chrome-error://chromewebdata/ with no click anywhere. That is not a
    // hypothetical: cutting the connection mid-load fails the in-flight
    // <script> tags, which is exactly what this listener fires on. A chunk
    // that failed because there is no network is also not the stale-deploy
    // purge this guard was written for - it will simply load when the
    // connection returns. Same shape as the cooldown branch below: only a page
    // that never came up earns the card.
    if (navigator.onLine === false) {
      if (!appMounted) showRecoveryCard();
      return;
    }
    var last = 0;
    try { last = Number(sessionStorage.getItem(KEY)) || 0; } catch (e) {}
    var now = Date.now();
    if (now - last < COOLDOWN_MS) {
      // Only a repeat failure on an app that never actually came up earns
      // the full-screen takeover. A failed chunk on an app that DID mount
      // (appMounted true) is a different, lesser event - silently do
      // nothing, same as reloadOnceForChunkError's cooldown no-op.
      if (!appMounted) showRecoveryCard();
      return;
    }
    reloadTriggered = true;
    try { sessionStorage.setItem(KEY, String(now)); } catch (e) {}
    location.reload();
  }
  window.addEventListener('error', function (event) {
    var target = event && event.target;
    if (target && target.tagName === 'SCRIPT' && isChunkAssetUrl(target.src)) {
      reloadOnce();
      return;
    }
    var msg = event && event.message;
    if (typeof msg === 'string' && /ChunkLoadError|Loading (chunk|CSS chunk) .* failed/i.test(msg)) {
      reloadOnce();
    }
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    var name = reason && reason.name;
    var msg = (reason && (reason.message || String(reason))) || '';
    if (name === 'ChunkLoadError' || /Loading (chunk|CSS chunk) .* failed/i.test(msg)) {
      reloadOnce();
    }
  });
})();`
          }}
        />
        {/* Use plain script tag for guaranteed synchronous loading of env globals.
            ★ suppressHydrationWarning (2026-08-11, audit item 7b): the Hive
            Keychain browser extension rewrites this tag's `src` in the live DOM
            before React hydrates, so React sees a server/client mismatch on
            `src` that has nothing to do with our own code and cannot be fixed by
            changing what we render — the extension edits the DOM out from under
            us. This is the same pattern Next.js documents for third-party
            extensions (e.g. Grammarly on <body>): suppress the mismatch warning
            on exactly this one attribute-bearing node rather than papering over
            real mismatches elsewhere. */}
        <script src={`${basePath}/__ENV.js?v=${envVersion}`} suppressHydrationWarning />
      </head>
      <body className="bg-background-secondary font-sans">
        <div className="min-h-screen">
          <Providers>
            {/* ★ EVERY client navigation is inside this (2026-08-13). Offline, a
                failed RSC fetch makes Next hard-navigate the document, which then
                fails at the network layer and replaces the entire app with
                Chrome's error page — measured on the feed tabs AND on ordinary
                <Link>s, signed in and signed out. No error boundary can catch a
                browser navigation, so it has to be stopped before the router
                starts it; this sits high enough to cover every link and every
                `useRouter()` call site at once. See components/offline-guard.tsx. */}
            <OfflineGuard>
              <ServerSessionProvider value={serverSession}>
                <StorageCleanup />
                <CondenserMigration />
                {/* Every route lands at the top of its own page. See scroll-reset.tsx. */}
                <ScrollReset />
                <AppHeader />
                {/* ★ NOT <main> (2026-08-13). Every page shell already renders its own
                    <main> (home-shell, page-shell, main-page-layout), so this outer one
                    produced a <main> inside a <main> on every page — invalid, and it
                    leaves assistive technology with two competing "main content"
                    landmarks. The inner ones are the correct ones because they wrap the
                    page content without the surrounding chrome, so this becomes a plain
                    wrapper rather than removing the landmark entirely. */}
                <div className="mx-auto">{children}</div>
              </ServerSessionProvider>
            </OfflineGuard>
          </Providers>
        </div>
        <ClientEffects />
      </body>
    </html>
  );
}
