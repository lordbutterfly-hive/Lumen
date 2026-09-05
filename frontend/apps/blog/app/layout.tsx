import '@hive/tailwindcss-config/globals.css';
import * as Sentry from '@sentry/nextjs';
import { ReactNode } from 'react';
import { Metadata } from 'next';
import type { Viewport } from 'next';
import { cookies } from 'next/headers';
import AppHeader from '../features/layouts/app-header';
import SkipToContent from '../features/layouts/skip-to-content';
import ClientEffects from '../features/layouts/site-header/client-effects';
import ScrollReset from '../features/layouts/scroll-reset';
import { ServerSessionProvider } from '../features/layouts/server-session';
import { ServerAccountTierProvider } from '../features/wallet/lib/server-account-tier-context';
import { OwnRankTierProvider } from '../features/retention/lib/own-rank-tier-context';
import { fetchOwnRankTierSeed } from '../features/retention/lib/own-rank-tier-seed';
import { Providers } from '../features/layouts/providers';
import { getServerSessionUser } from '../lib/server-session';
import { Hydrate, dehydrate } from '@tanstack/react-query';
import { getQueryClient } from '../lib/react-query';
import { trendingTagsForPrefetch, TRENDING_TAGS_QUERY_KEY } from '../lib/trending-tags';
import { StorageCleanup } from '@hive/ui';
import CondenserMigration from '../components/condenser-migration';
import OfflineGuard from '../components/offline-guard';
import { Lora } from 'next/font/google';
import { siteConfig } from '@ui/config/site';
import { configuredImagesEndpoint } from '@ui/config/public-vars';

// ★★★ ONE FAMILY. LORA, AND NOTHING ELSE (owner ruling, 2026-08-19).
//
// Open Sans is gone — the import, its five weights, its preload link and the
// vendored static cut the OG card used. Lora is now the only typeface in the
// product: chrome, nav, labels, chips, buttons, tabs, table headers, numbers
// and running prose. Still self-hosted via next/font, so it continues to
// satisfy the app CSP (`font-src 'self'`).
//
// ★ ONE VARIABLE, NAMED AFTER THE FAMILY. This binding has already carried
// three stale names — `--font-inter`, then `--font-source-serif`, then
// `--font-sans`/`--font-serif` — each describing a face that had been swapped
// out underneath it, and each one costing the next reader a grep to find out
// what was actually loaded. `--font-lora` cannot go stale without the import
// above going with it. `tailwind.config.js` keeps `font-sans` and `font-serif`
// as COMPATIBILITY ALIASES of this single variable so the ~460 existing call
// sites keep compiling while they are migrated; both resolve to Lora today.
//
// ★ WHAT LORA DOES NOT HAVE. Measured, not assumed, in
// `next/dist/compiled/@next/font/dist/google/font-data.json`: Lora's wght axis
// is 400-700. There is no 300 and there is no 800. Asking for either does not
// throw and does not synthesise — it resolves to the nearest real cut, so a
// `font-extrabold` element renders at the SAME weight as the 700 beside it,
// and a `font-light` one at the same weight as the 400. Anything that needs
// more authority than 700 buys it with size and negative tracking. Open Sans
// also carried a `wdth` axis; nothing in this app used it.
//
// ★ PRELOAD (2026-08-13, re-checked and still true). MEASURED on the shipped
// build by walking the generated font stylesheet: Lora normal 400, 500, 600
// AND 700 all resolve to the SAME latin file (`5c0c2bcbaa4149ca-s.p.woff2` —
// the `.p.` infix is next/font's own "preloaded" marker), emitted as
// `<link rel="preload" as="font">` alongside the italic file. Dropping Open
// Sans removes one of the three preload links outright. Stating `preload: true`
// keeps the guarantee if someone later adds a weight or a subset.
//
// ★ NEVER HARDCODE THE GENERATED FAMILY NAME. next/font registers this under a
// hashed family (`__Lora_a0ef65` in one build), NOT under `Lora`, and the hash
// changes whenever this config changes. Anything that needs the family must
// read `var(--font-lora)`. `masthead-glyph.tsx` records what that trap costs:
// a canvas probe asked for "146px Lora", silently measured Georgia instead,
// and every offset derived from it was wrong in a way that looked right.
const lora = Lora({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-lora',
  display: 'swap',
  preload: true
});

/**
 * ★ T3b (perf hunt, 2026-09-04) — preconnect target for the image host.
 *
 * ~40 `<img>`s per page (feed thumbnails, avatars, post bodies) point at
 * `configuredImagesEndpoint` (default `https://images.hive.blog`, overridable
 * via `REACT_APP_IMAGES_ENDPOINT` — see `packages/ui/config/public-vars.ts`),
 * and NOTHING warmed that connection before this: the DNS lookup + TCP + TLS
 * handshake all happened on the first image request, serially blocking it.
 * Derived from the same config the actual `<img src>`s resolve through
 * (`proxifyImageSrc`/`getUserAvatarDirectUrl`) rather than hardcoded, so an
 * env override moves the preconnect target with it instead of preconnecting
 * to a host nothing on the page actually requests.
 *
 * ★ NO `crossOrigin` ON THE PRECONNECT. Grepped every `<img` in this app and
 * `@hive/ui`/`@hive/renderer`'s components — none sets `crossOrigin`, so every
 * image fetch is a plain, non-CORS request. A `crossorigin` preconnect opens
 * an anonymous-CORS connection, which is a SEPARATE connection from the one
 * a no-CORS `<img>` fetch actually uses — warming the wrong pool would waste
 * the early connection instead of serving the real requests. (Contrast the
 * font preloads below, which DO need `crossOrigin`: `as="font"` fetches are
 * always anonymous-CORS by spec, same-origin or not.)
 */
function imagesPreconnectOrigin(): string {
  try {
    return new URL(configuredImagesEndpoint).origin;
  } catch {
    return 'https://images.hive.blog';
  }
}
const imagesOrigin = imagesPreconnectOrigin();

/**
 * ★★★ THIS WAS HIVE'S COPY, ON LUMEN'S MOST-SEEN SURFACE (2026-08-18).
 *
 * Every Lumen link pasted into X, Discord, Slack or iMessage rendered a preview
 * carrying hive.blog's artwork AND this sentence, which is Hive's boilerplate
 * about Hive. The people most likely to see it are the ones who have never used
 * Lumen — so the product's main introduction to strangers was an advert for a
 * different product.
 */
/**
 * The absolute origin this deployment serves from. Share-card URLs are resolved
 * against it, so getting it wrong makes every preview point at another host.
 */
function siteDomain(): string {
  const configured = process.env.REACT_APP_SITE_DOMAIN;
  if (configured) return configured;
  // Loud, once, on the server: a missing value here is invisible in the UI and
  // only shows up as a broken preview on someone else's timeline.
  if (typeof window === 'undefined') {
    // eslint-disable-next-line no-console
    console.warn(
      'REACT_APP_SITE_DOMAIN is not set — share-card image URLs will be resolved against http://localhost:3000 and will not work when shared.'
    );
  }
  return 'http://localhost:3000';
}

const SITE_DESC = 'A calmer place to read and write. Read what is worth your time. Write without chasing an audience.';

const metadata = {
  /**
   * ★★★ THE FALLBACK HERE DECIDES WHERE EVERY SHARE CARD IS FETCHED FROM
   * (2026-08-18). Next resolves every relative `og:image` against this, so with
   * `REACT_APP_SITE_DOMAIN` unset the card URL came out as
   * `https://hive.blog/lumen/og-plain.png` — a path that exists on OUR server and
   * not on theirs. The preview would 404, and the one surface this work exists to
   * fix would be blank instead of merely wrong.
   *
   * Falling back to hive.blog was harmless while the images were literal
   * hive.blog URLs; the moment they became ours it became a live bug. The
   * fallback is now this app's own origin, and an unset variable is warned about
   * at boot rather than silently pointing somewhere else.
   */
  metadataBase: new URL(siteDomain()),
  title: {
    default: siteConfig.name,
    template: `%s - ${siteConfig.name}`
  },
  description: SITE_DESC,
  /**
   * ★ NOTHING EXISTED BELOW 100px BEFORE THIS (2026-08-18). `favicon.ico` was the
   * only file: no SVG, no apple-touch-icon, no maskable tiles, no manifest. So a
   * pinned tab, an iOS home screen and an Android install all fell back to a
   * screenshot or a blank. SQ9 (an ink nib on paper) is the small-size form of
   * the wordmark — deliberately NOT the quill, which already means "lite account"
   * in a byline and must never be confused with the app's own mark.
   */
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48' }
    ],
    apple: '/apple-touch-icon.png'
  },
  manifest: '/site.webmanifest',
  openGraph: {
    type: 'website',
    siteName: siteConfig.name,
    title: siteConfig.name,
    description: SITE_DESC,
    // The TODO that sat here is done: this is Lumen's own card now (LP8, warm
    // paper, wordmark, masthead rule), not hive.blog's.
    images: ['/lumen/og-plain.png']
  },
  twitter: {
    // ★ `summary_large_image`, not `summary`: the card is a 1200x630 landscape
    // design, and `summary` crops it to a small square thumbnail beside the text,
    // throwing away the whole layout.
    card: 'summary_large_image',
    // No real Lumen social handle exists anywhere in this codebase
    // (siteConfig.links.twitter is itself a dead '/' placeholder) — omitting
    // `site` rather than keeping the unrelated official @hiveblocks handle.
    title: siteConfig.name,
    description: SITE_DESC,
    images: ['/lumen/og-plain.png']
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

/**
 * ★ `theme-color`, THE ONE MISSING PIECE OF THE ICON/MANIFEST SET (uniformity audit,
 * 2026-08-18). The favicon set, apple-touch-icon and webmanifest all landed; this did
 * not, so on Android Chrome and an installed PWA the browser chrome stays default grey
 * instead of continuing the page — which is the whole visual point of having shipped a
 * manifest.
 *
 * ★★ IT IS A SEPARATE `viewport` EXPORT, NOT A `metadata` FIELD. Next.js 14 moved
 * `themeColor` out of `metadata`; leaving it in the metadata object logs a deprecation
 * and, more to the point, does not emit the tag. The value here would be silently
 * ignored if it were added ten lines up with the icons.
 *
 * ★ THE VALUE IS MEASURED, NOT ASSUMED: `getComputedStyle(document.body).backgroundColor`
 * on the running production build returns `rgb(247, 247, 247)`. If the page background
 * moves to paper (`252 250 247`, an open item on the same audit) this MUST move with it,
 * or the browser chrome and the page will disagree by a visible step.
 */
export const viewport: Viewport = {
  themeColor: '#f7f7f7'
};

/**
 * ★ T3a (perf hunt, 2026-09-04) — replaces the sync `<script src="/__ENV.js">`.
 *
 * `/__ENV.js` used to be a SEPARATE render-blocking request (826B, `no-store`,
 * placed after the CSS chain): a full cold RTT before `<body>` could paint,
 * every single load. `@beam-australia/react-env` (`dist/cli-index.js`,
 * `getEnvironment()`) builds that file's content by taking every
 * `process.env` key matching `/^REACT_APP_/i` verbatim and writing
 * `window.__ENV = ${JSON.stringify(env)};` to `public/__ENV.js` ONCE, at
 * container boot, BEFORE spawning `next start`/`server.js` — and that child
 * process inherits the parent's (dotenv-expanded) `process.env` by default
 * (`cross-spawn(..., { stdio: 'inherit' })` passes no `env` override). So the
 * Next.js server process handling this exact render already holds, in its
 * own `process.env`, byte-for-byte the same REACT_APP_* values react-env
 * wrote to the file — reading them here cannot disagree with what the file
 * would have said. `getBrowserEnv` below mirrors react-env's own filter
 * exactly (same regex, same "every matching key, verbatim" rule).
 *
 * ★ WHY THIS IS SAFE TO DO PER-REQUEST, NOT JUST AT BOOT. This root layout
 * already calls `cookies()` above, which opts the whole tree out of static
 * rendering — every request re-runs this function against the LIVE
 * `process.env` of the running container, so there is no build-time snapshot
 * to go stale and no risk of shipping a dev/testnet value baked in at build.
 * (Contrast: hardcoding any value here would have been wrong — the whole
 * point of react-env is that the deploy's real `/opt/lumen/.env` decides
 * this, not the source tree.)
 *
 * ★ `<`-ESCAPING, NOT A RAW `JSON.stringify`. This now sits INSIDE an
 * HTML document (the old file was served as `application/javascript`, where
 * this had no meaning). `JSON.stringify` does not escape `<`, so an operator
 * env value that happened to contain `</script>` could otherwise break out
 * of this tag; escaping every `<` to its JSON `\u` form (browsers decode it
 * identically, `<script>` parsing never sees a literal `<`) closes that
 * regardless of which key or position it appeared in — the same technique
 * Next.js itself uses to inline `__NEXT_DATA__`.
 */
function getBrowserEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    if (/^REACT_APP_/i.test(key)) {
      out[key] = process.env[key] as string;
    }
  }
  return out;
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Server-side locale and language handling
  const cookieStore = cookies();
  const locale = cookieStore.get('NEXT_LOCALE')?.value || 'en';
  const isRTL = locale === 'ar';

  // window.__ENV, inlined below instead of fetched — see getBrowserEnv above.
  const browserEnvScript = `window.__ENV = ${JSON.stringify(getBrowserEnv()).replace(/</g, '\\u003c')};`;

  /*
   * ★★★ THE RIGHT RAIL'S TOPICS, IN THE HTML (2026-08-30).
   *
   * `features/layouts/right-rail/topics.tsx` is a client widget with no prefetch,
   * so its nine chips could not exist until the entire 983 KB client bundle had
   * downloaded, parsed and hydrated. Measured on the production build in a real
   * browser: the request did not even START until 1746 ms (warm) / 1429 ms (cold
   * cache), which was 321 ms / 267 ms AFTER the last script finished downloading.
   * The request itself was 50 ms and 1 ms. The wait was hydration, not data.
   *
   * Dehydrating the query here puts the answer in the server-rendered markup, so
   * the chips are painted with the first paint and the browser makes no request
   * at all. See `lib/trending-tags.ts` for the numbers and the cache.
   *
   * ★ IT CANNOT SLOW THE PAGE DOWN. `trendingTagsForPrefetch()` races a short
   * deadline and returns null rather than making every route on the site wait
   * behind a sick Hive node. Null means we simply do not seed the key, and the
   * widget fetches for itself exactly as it does today. Never worse.
   *
   * ★ ONLY ON A HIT. Seeding the key with an empty array would be worse than not
   * seeding it: react-query would treat `[]` as a fresh answer for the whole
   * `StaleTime.LONG` window and the card would render its empty state instead of
   * fetching. So a miss must leave the key ABSENT, not present-and-empty.
   *
   * ★ PARALLEL WITH THE SESSION READ, NOT AFTER IT (C-B, 2026-09-05). This and
   * `getServerSessionUser()` below used to run as two sequential `await`s, but
   * neither's input depends on the other's output — the session read opens a
   * cookie, this races a Hive read against its own deadline — so making a
   * reader wait for them back-to-back only ever added the first's latency to
   * the second's. `Promise.all` runs the same two reads concurrently; the
   * root layout's wall-clock cost is now the SLOWER of the two, not the sum.
   */
  const [serverSession, trendingTags] = await Promise.all([
    // ★ The header and the left rail used to learn who you are only after React
    // mounted and `/api/users/me` came back, which on this app is 5-20s — so a
    // signed-in reader was served signed-out chrome for that whole window. This
    // request already carries the session cookie; read it once here and hand the
    // answer down. See features/layouts/server-session.tsx.
    getServerSessionUser(),
    trendingTagsForPrefetch()
  ]);

  /**
   * ★★★ THE LEFT RAIL'S RANK TIER, IN THE HTML TOO (C-B, 2026-09-05, owner:
   * "the left navbar spark loads slow"). Same idea as the trending-tags seed
   * above, for `league-showcase.tsx`'s instant-tier row: `useOwnRankTier`
   * reads a snapshot that answers in ~10ms once the read itself starts, but
   * on a cold load nothing started it until the client mounted and fired its
   * own `/api/streak/marks` request, so the rail always painted
   * `ShowcaseSkeleton` first regardless of how fast that read was. This reads
   * the SAME snapshot directly (`own-rank-tier-seed.ts`, no HTTP hop) so
   * `OwnRankTierProvider` below can hand `useOwnRankTier` an answer it already
   * has on the very first render.
   *
   * UNLIKE `trendingTagsForPrefetch()`, this cannot join the `Promise.all`
   * above — it needs `serverSession.username`, which is that call's own
   * output, so the dependency is real, not incidental. Bounded by its own
   * short race for the same reason `app/wallet/page.tsx`'s `PREFETCH_BUDGET_MS`
   * is: this seed feeds EVERY page via the root layout, not one route, so a
   * degraded read must never add more than a small, fixed amount to every
   * page's TTFB. Sized with generous headroom over the ~10ms the snapshot
   * read itself costs; a miss or timeout just means "no seed" —
   * `useOwnRankTier`'s existing unseeded client fetch runs exactly as it does
   * today.
   */
  const RANK_TIER_PREFETCH_BUDGET_MS = 150;
  const rankTierSeed = serverSession.isLoggedIn
    ? await Promise.race([
        fetchOwnRankTierSeed(serverSession.username),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), RANK_TIER_PREFETCH_BUDGET_MS))
      ])
    : null;

  const queryClient = getQueryClient();
  if (trendingTags) {
    queryClient.setQueryData([...TRENDING_TAGS_QUERY_KEY], trendingTags);
  }
  const dehydratedState = dehydrate(queryClient);
  queryClient.clear();

  return (
    <html lang={locale} dir={isRTL ? 'rtl' : 'ltr'} className={lora.variable}>
      <head>
        {/* ★ T3b (perf hunt, 2026-09-04) — warm the image host connection.
            See imagesPreconnectOrigin() above for why there's no crossOrigin
            here and why the origin is derived rather than hardcoded.
            dns-prefetch is the fallback for browsers that ignore/cap
            preconnect (old Safari; Firefox's ~India connections limit) — it
            degrades to "just resolve the DNS early", still a net win. */}
        <link rel="preconnect" href={imagesOrigin} />
        <link rel="dns-prefetch" href={imagesOrigin} />
        {/* ★ Lumen UI (Merriweather Sans) + Lumen Num (Fira Sans digits) preloads
            (2026-09-02 typography; widened 2026-09-04 perf hunt; latin-ext DROPPED
            2026-09-05, batch C-C). Lora is loaded by next/font above and preloads
            itself; these cover the OTHER two faces.
            ★ SIX of the NINE files packages/tailwindcss/globals.css's "Lumen UI"/
            "Lumen Num" @font-face rules reference are preloaded here — the 400/500/
            600 "latin" cut of Merriweather Sans (plain, no unicode-range — matches
            everything the "latin-ext" cut doesn't) plus all three Fira Sans digit
            weights. Any element rendered at font-medium/font-semibold (.font-ui) or
            using .font-num (feed-card payout figures, wallet balances — both above
            the fold) needs these, so an unpreloaded fetch there was a visible
            weight/face swap after first paint (FOUT).
            ★ THE THREE "latin-ext" CUTS ARE NOT PRELOADED, DELIBERATELY. They stay
            declared in globals.css (`merriweather-sans-latin-ext-{400,500,600}-*`,
            `unicode-range: U+0100-024F, U+0259, U+1E00-1EFF, U+2020, U+20A0-20AB,
            U+20AD-20CF, U+2113, U+2C60-2C7F, U+A720-A7FF` — mostly Central/Eastern-
            European Latin diacritics), so the browser still fetches one on demand
            the moment a page actually renders a character in that range — this is
            the CSS unicode-range subsetting mechanism working as intended, not a
            missing fallback. Forcing them via `<link rel=preload>` bypassed that
            mechanism and fetched all three unconditionally on every load (~51KB +
            3 requests) for a range most readers' content never touches. Filenames
            carry the content hash described in globals.css; a re-subset font needs
            both updated together. */}
        <link
          rel="preload"
          href="/fonts/merriweather-sans-latin-400-normal.28371889.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/fonts/merriweather-sans-latin-500-normal.5d656fcf.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/fonts/merriweather-sans-latin-600-normal.4f0b3ea5.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/fonts/fira-sans-digits-400.64bd6851.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/fonts/fira-sans-digits-500.cc36e988.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/fonts/fira-sans-digits-600.aa2c09a8.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
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
            never block the HTML parser — THEN this script, THEN the inline
            `window.__ENV` script (formerly a separate `__ENV.js` request,
            inlined in the T3a perf fix, 2026-09-04 — still the same document
            position, so this ordering argument is unaffected).
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
        {/* ★ CLEAR THE DEAD `theme` KEY (QA Low-4, 2026-08-16). This app has no
            dark-mode control anywhere — features/layouts/providers.tsx:27-38
            (owner ruling, 2026-08-11) records that next-themes and every
            `dark:` variant were removed after the dark palette was found
            broken when forced (header and cards stayed white, the sidebar
            went unreadable dark-grey-on-dark), and that decision was final:
            light-only, no toggle, no revisit. Grepping this app and its
            shared packages turns up zero remaining code that reads or writes
            a `theme` key — so a reader who still carries one in
            localStorage (from before that removal, or from a shared-origin
            visit to apps/wallet, which keeps its own real, separate
            next-themes toggle) is holding a value nothing here has consulted
            in months, and nothing here will ever act on again. Cheap,
            one-time, best-effort removal rather than leaving stale state
            sitting in a reader's browser forever; safe to run on every load
            (removeItem on an already-missing key is a no-op), and a plain
            script rather than a React effect so it runs even if a chunk
            fails to load (same reasoning as the chunk-error guard above). */}
        <script
          id="lumen-clear-dead-theme-key"
          dangerouslySetInnerHTML={{
            __html: `(function () { try { localStorage.removeItem('theme'); } catch (e) {} })();`
          }}
        />
        {/* ★ T3a (perf hunt, 2026-09-04): was `<script src="/__ENV.js?v=...">`,
            a separate render-blocking request (826B, `no-store`) needing a full
            cold RTT after the CSS chain before <body> could paint. Inlined —
            see getBrowserEnv()/browserEnvScript above for what it contains and
            why it is safe to compute per-request from live process.env. Same
            plain, non-async, synchronous script tag (still executes in
            document order, still before hydration), just no network round
            trip. suppressHydrationWarning is no longer needed: that guarded
            against the Hive Keychain extension rewriting this tag's `src`
            attribute pre-hydration, and an inline script has no `src` for it
            to rewrite. */}
        <script id="lumen-env" dangerouslySetInnerHTML={{ __html: browserEnvScript }} />
      </head>
      <body className="bg-background-secondary font-sans">
        <div className="min-h-screen">
          <Providers>
            {/* Inside Providers because Hydrate must sit under the QueryClientProvider
                Providers creates; outside OfflineGuard because it renders no UI of its
                own and must wrap every route's tree, not just the guarded children. */}
            <Hydrate state={dehydratedState}>
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
                {/* ★ C-B, 2026-09-05: `accountTier` (wallet-content.tsx /
                    wallet-right-rail.tsx) and the rank-tier snapshot
                    (league-showcase.tsx) — see each provider's own doc for why
                    these are separate, feature-scoped contexts rather than
                    fields added to `ServerSessionProvider` itself. */}
                <ServerAccountTierProvider value={serverSession.accountTier}>
                <OwnRankTierProvider value={rankTierSeed}>
                <StorageCleanup />
                <CondenserMigration />
                {/* Every route lands at the top of its own page. See scroll-reset.tsx. */}
                <ScrollReset />
                {/* First tab stop on every route — see skip-to-content.tsx. */}
                <SkipToContent />
                <AppHeader />
                {/* ★ NOT <main> (2026-08-13). Every page shell already renders its own
                    <main> (home-shell, page-shell, main-page-layout), so this outer one
                    produced a <main> inside a <main> on every page — invalid, and it
                    leaves assistive technology with two competing "main content"
                    landmarks. The inner ones are the correct ones because they wrap the
                    page content without the surrounding chrome, so this becomes a plain
                    wrapper rather than removing the landmark entirely. */}
                <div className="mx-auto" id="main-content" tabIndex={-1}>
                  {children}
                </div>
                </OwnRankTierProvider>
                </ServerAccountTierProvider>
              </ServerSessionProvider>
            </OfflineGuard>
            </Hydrate>
          </Providers>
        </div>
        <ClientEffects />
      </body>
    </html>
  );
}
