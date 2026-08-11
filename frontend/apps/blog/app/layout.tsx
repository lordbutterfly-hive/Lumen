import '@hive/tailwindcss-config/globals.css';
import * as Sentry from '@sentry/nextjs';
import { ReactNode } from 'react';
import { Metadata } from 'next';
import { cookies } from 'next/headers';
import NextScript from 'next/script';
import AppHeader from '../features/layouts/app-header';
import ClientEffects from '../features/layouts/site-header/client-effects';
import ScrollReset from '../features/layouts/scroll-reset';
import { ServerSessionProvider } from '../features/layouts/server-session';
import { Providers } from '../features/layouts/providers';
import { getServerSessionUser } from '../lib/server-session';
import { StorageCleanup } from '@hive/ui';
import CondenserMigration from '../components/condenser-migration';
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

            ★ `strategy="beforeInteractive"`, NOT a plain `<script>` tag — MEASURED,
            not assumed (2026-08-11). A plain inline `<script>` placed here in the
            JSX still lost the race: Next injects its OWN framework/route chunk
            `<script async>` tags (main-app.js, app/layout.js, etc.) at the very
            front of `<head>` regardless of where this element sits in the
            layout's JSX, and those `async` tags start fetching immediately once
            parsed — so a plain script lower in the document attached its error
            listener AFTER the early chunks had already failed and fired their
            (unheard) error events. `next/script`'s `beforeInteractive` is Next's
            own documented mechanism for exactly this ordering guarantee: it is
            injected and executed before any other script, hydration included.
            Confirmed via Playwright with all `_next/static/chunks/*` requests
            blocked: a plain script here caught 0 of 22 failures; beforeInteractive
            caught the failure and reloaded on the first attempt.

            It only reloads once per 10 minutes (matches
            `lib/chunk-error-reload.ts`'s cooldown, same sessionStorage key by
            name) so a real outage does not reload the tab forever. */}
        <NextScript
          id="lumen-chunk-error-guard"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `(function () {
  var KEY = 'lumen:chunk-reload-at';
  var COOLDOWN_MS = 10 * 60 * 1000;
  function isChunkAssetUrl(src) {
    return typeof src === 'string' && src.indexOf('/_next/static/') !== -1;
  }
  function reloadOnce() {
    var last = 0;
    try { last = Number(sessionStorage.getItem(KEY)) || 0; } catch (e) {}
    var now = Date.now();
    if (now - last < COOLDOWN_MS) return;
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
            <ServerSessionProvider value={serverSession}>
              <StorageCleanup />
              <CondenserMigration />
              {/* Every route lands at the top of its own page. See scroll-reset.tsx. */}
              <ScrollReset />
              <AppHeader />
              <main className="mx-auto">{children}</main>
            </ServerSessionProvider>
          </Providers>
        </div>
        <ClientEffects />
      </body>
    </html>
  );
}
