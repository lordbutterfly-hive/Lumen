const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

// Support serving from subdirectory like /blog
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

// Note: Security headers (CSP, X-Content-Type-Options, etc.) are now applied
// via middleware for runtime environment variable evaluation.
// See packages/middleware/lib/csp.ts and apps/blog/middleware.ts

/** @type {import('next').NextConfig} */
const nextConfig = {
  // ★ TWO INSTANCES, ONE WORKSPACE.
  //
  // `next dev` and `next start` both use `.next` by default, so running a dev
  // server in this directory while a production server is serving from it
  // overwrites the production build UNDER the running process: BUILD_ID goes
  // empty, every static chunk 500s, and every route but `/` returns a bare
  // "Internal Server Error". That is exactly what happened on 2026-08-07 when a
  // second instance was started here for creator-token QA, and it cost a tester
  // six of their eight charter steps.
  //
  // Default is unchanged. Set NEXT_DIST_DIR=.next-dev for the secondary
  // instance and the two can no longer touch each other.
  distDir: process.env.NEXT_DIST_DIR || '.next',

  reactStrictMode: true,
  poweredByHeader: false, // Don't expose X-Powered-By: Next.js
  // ★ COMPRESSION IS ON UNLESS SOMETHING IN FRONT IS DOING IT (2026-08-13).
  //
  // This was `false` on the reasoning "Nginx handles compression; disabling avoids
  // zlib memory retention (denser#886)". The premise stopped being true: measured in
  // a real browser against this build, Home pulls 50 JS files / 3,250 KB where
  // `encodedBodySize === decodedBodySize` on every single one — nothing anywhere in
  // the chain is compressing, and gzip -9 on the very same chunks is 3.5x smaller
  // (11,422 KB -> 3,277 KB). An uncompressed 3.4 MB frontend is a far worse problem
  // than zlib arena retention, so the default now favours the reader.
  //
  // If a compressing proxy IS confirmed in front of a given deployment, set
  // `NEXT_DISABLE_COMPRESSION=true` there to hand the work back to it and restore
  // denser#886's behaviour — double-compressing is pure waste, which is what that
  // issue was really about.
  compress: process.env.NEXT_DISABLE_COMPRESSION !== 'true',
  output: 'standalone',
  swcMinify: false,
  basePath: basePath,
  assetPrefix: basePath,
  publicRuntimeConfig: {
    basePath: basePath
  },
  experimental: {
    outputFileTracingRoot: path.join(__dirname, '../..'),
    instrumentationHook: true
    // ★ `experimental.preloadEntriesOnStart` WAS TRIED HERE AND REMOVED — do not
    // re-add it without re-measuring (2026-08-17).
    //
    // The theory was sound and the code backs it: Next `require()`s a route's
    // compiled bundle lazily on its first request (next/dist/server/require.js
    // `requirePage`, from next-server.js's `findPageComponents`), so the first
    // reader after a restart pays parse + compile + top-level eval of that bundle
    // plus the ~327KB shared app-page runtime. `preloadEntriesOnStart` is Next's
    // own fix: at boot it requires every route up front.
    //
    // It did not move the number. A/B over 6 restart cycles each, same machine,
    // first hit on /communities: WITHOUT 0.549-0.626s (one 1.020s outlier),
    // WITH 0.516-0.563s. Medians 0.581s vs 0.550s — overlapping ranges, ~30ms
    // apart, which is noise at this sample size. The first three cycles looked
    // like a win purely because the control drew that one outlier.
    //
    // Removed rather than kept: an experimental flag that pays boot work for no
    // measured gain is a liability across Next upgrades. The residual first-hit
    // cost is the shared runtime, paid ONCE per process on whichever route is hit
    // first (proven: /communities first hit ~0.55s, then /creators and / are
    // ~30ms in the same process) — so it is one visitor per deploy, not per route.
    // DO NOT add `serverComponentsExternalPackages` for @hiveio/beekeeper or
    // @hiveio/wax. It makes the lite publisher's WASM signer work, but it also
    // makes EVERY page 500 ("Element type is invalid… got: undefined") — verified
    // on clean builds 2026-07-27, with either package listed. The publisher opts
    // out per-module instead, via `webpackIgnore` runtime imports in
    // lib/lite/publisher/hive-broadcaster.ts.
  },
  // Worker files need specific headers (security headers are applied via middleware)
  async headers() {
    return [
      {
        source: '/auth/worker.js',
        headers: [
          {
            key: 'Content-Type',
            value: 'application/javascript; charset=utf-8'
          },
          {
            key: 'Cache-Control',
            value: 'no-cache, no-store, must-revalidate, max-age=0'
          }
        ]
      }
    ];
  },
  transpilePackages: [
    '@hive/common-hiveio-packages',
    '@hive/smart-signer',
    '@hive/ui',
    '@hive/transaction',
    '@hive/renderer',
    '@hive/middleware'
  ],

  /**
   * ★★★ RETIRED ROUTES MUST REDIRECT BEFORE THEY RENDER (2026-08-12).
   *
   * `trending / hot / created / payout / muted` were retired on 2026-08-08 — Lumen
   * has one ranked home feed plus topic pages, and no chain-sort destinations. Each
   * of those routes was left as a `page.tsx` calling `redirect()`, which looks like
   * it costs nothing. Measured, it costs a great deal:
   *
   *   GET /trending              -> 200, 95,791 bytes, <meta http-equiv="refresh"
   *                                content="1;url=/">
   *   GET /trending/photography  -> 200, 49,787 bytes, 1s meta-refresh to /topics/…
   *
   * NOT a 307. The reason is `(main-and-community)/loading.tsx`: because the group
   * has a loading boundary, Next STREAMS the route, so the shell is flushed — and
   * the 200 status committed — before the page component ever runs. `redirect()`
   * can no longer set a status code, so it degrades to a meta-refresh with a
   * ONE-SECOND delay. A visitor to a page we deleted from the product renders a
   * full document, watches the loading animation, waits a second, and only then
   * bounces. Crawlers see a 200 with content, which is a soft redirect and far
   * worse for search than a real one.
   *
   * `redirects()` runs in routing, before any rendering, so these become genuine
   * 308s: zero bytes, zero render, no delay. The `page.tsx` stubs are left in place
   * as a backstop if this config is ever edited, but they should no longer be
   * reachable.
   *
   * ★ ORDER MATTERS. `/:sort/my` MUST precede `/:sort/:tag` or the `:tag` pattern
   * swallows `my` and sends readers to a topic page for a topic called "my".
   *
   * ★ `permanent: false` (307), NOT 308, and that is deliberate. It matches exactly
   * what the `redirect()` stubs already returned, so this change moves ONLY the cost
   * and changes no semantics. A 308 would be better for search — it de-indexes the
   * old URL and passes link equity — but browsers cache it indefinitely, so it is
   * effectively one-way. That is the owner's call to make, not a side effect of a
   * performance fix.
   *
   * The `/lists/*` and `/comments` entries below have the same cause — they sit in
   * `[param]/(user-profile)/`, which also has a `loading.tsx`.
   */
  async redirects() {
    const RETIRED_SORTS = ['trending', 'hot', 'created', 'payout', 'muted'];
    return [
      /**
       * ★ THE BARE PATHS 404 WHILE ONLY THE `.html` ONES RESOLVE (QA report
       * 2026-08-16, "Low/polish 3"). `/help`, `/tos` and `/privacy` are the
       * spellings a human types and the spellings other sites link, and every
       * one of them returned 404 while `/help.html`, `/tos.html` and
       * `/privacy.html` rendered fine. Legal pages in particular get linked and
       * indexed from outside, where a 404 is not recoverable by the reader.
       *
       * Permanent, unlike the retired-sort redirects below: these three are not
       * a migration in progress, the `.html` spelling is the canonical one and
       * is not going to move again.
       */
      { source: '/help', destination: '/help.html', permanent: true },
      { source: '/tos', destination: '/tos.html', permanent: true },
      { source: '/privacy', destination: '/privacy.html', permanent: true },
      ...RETIRED_SORTS.flatMap((sort) => [
        { source: `/${sort}`, destination: '/', permanent: false },
        /**
         * ★ `/my` IS A SCOPE, AND IT SURVIVED THE RETIREMENT (2026-08-13, audit
         * §3.1). The 2026-08-08 ruling retired the SORT. `/{sort}/my` also
         * carries a second thing it never retired: on Hive `/my` means "only
         * the accounts I follow". Sending it to plain `/` dropped that
         * silently — the reader asked for their own circle and landed on the
         * global For You feed with nothing to say so. Lumen has that surface:
         * the home feed's Following tab (`features/discovery-feed/feed-tabs.tsx`,
         * `?tab=feed`). Signed out, that tab shows its own "Following shows the
         * people you follow" prompt with a Log in action, so nobody is dropped
         * into a silently empty list.
         *
         * `muted` is the ONE exception and stays on `/`: `/muted` lists posts a
         * moderator has HIDDEN, and Lumen has no surface that browses hidden
         * content at all. Honouring only the `/my` half would serve ordinary
         * posts under a URL that asked for muted ones — a worse lie than the
         * redirect. The matching `page.tsx` stubs carry the same note.
         */
        { source: `/${sort}/my`, destination: sort === 'muted' ? '/' : '/?tab=feed', permanent: false },
        { source: `/${sort}/:tag`, destination: '/topics/:tag', permanent: false }
      ]),
        /**
         * ★ THE BARE COMMUNITY PATH 404'd, AND IT IS THE PREFIX OF EVERY POST URL
         * THIS APP EMITS (2026-08-21).
         *
         * Our own post links look like `/hive-160391/@gtg/<permlink>`. Delete the
         * tail — which is what a reader does to get "the rest of this community",
         * and what a copy-paste truncation does by accident — and `/hive-160391`
         * answered 404. So did `/hive-139531`, the spelling pasted out of other
         * Hive front ends.
         *
         * ★ MATCHED AGAINST WHAT THE OTHER FRONT ENDS ACTUALLY DO, not assumed.
         * Measured 2026-08-21:
         *
         *     hive.blog/hive-139531      404
         *     hive.blog/c/hive-139531    404
         *     peakd.com/hive-139531      200
         *     peakd.com/c/hive-139531    200
         *
         * hive.blog treats `/trending/hive-…` as the only community URL; peakd
         * serves the bare path and its own `/c/` form. Following peakd is the
         * owner's call (2026-08-21: "id still rather it not show 404"), and it
         * costs nothing — both spellings land on the one canonical topic page
         * rather than becoming a second place a community can live.
         *
         * `hive-\d+` and nothing looser: community accounts on Hive are always
         * `hive-` plus digits, and a bare `:tag` here would swallow every unknown
         * single-segment path in the app (`/photography`, and any future top-level
         * route) into a topic page that may not exist. A one-segment source cannot
         * match `/hive-160391/@gtg/<permlink>`, so post URLs are untouched.
         *
         * `permanent: false` to match the retired-sort redirects above rather than
         * pinning a 308 into every reader's browser cache while the topic surface
         * is still settling.
         */
        { source: '/:community(hive-\\d+)', destination: '/topics/:community', permanent: false },
        { source: '/c/:community(hive-\\d+)', destination: '/topics/:community', permanent: false },
      // The four legacy moderation lists — one Blocked list now (owner ruling,
      // 2026-08-12). A hash fragment is never sent to the server, so it is carried
      // here in the destination for the browser to apply on arrival.
      ...['muted', 'blacklisted', 'followed_blacklists', 'followed_muted_lists'].map((list) => ({
        source: `/:user((?:@|%40)[^/]+)/lists/${list}`,
        destination: '/:user/settings#blocked-accounts',
        permanent: false
      })),
      {
        source: '/:user((?:@|%40)[^/]+)/comments',
        destination: '/:user?tab=comments',
        permanent: false
      }
    ];
  },

  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [
        {
          source: '/.well-known/openid-configuration',
          destination: '/api/oidc/.well-known/openid-configuration'
        },
        {
          source: '/oidc/:path*',
          destination: '/api/oidc/:path*'
        },
        // Strip /public from paths to handle auth worker and other assets
        {
          source: '/public/:path*',
          destination: '/:path*',
        }
      ],
      // Fallback rewrites run after all pages and dynamic routes.
      // This routes /@user/permlink to the resolve-post API (which redirects
      // to the canonical /category/@author/permlink URL) without a catch-all
      // [param]/[p2]/route.ts that would intercept _next/* internal paths.
      fallback: [
        {
          source: '/:user((?:@|%40)[^/]+)/:permlink([^/]+)',
          destination: '/api/resolve-post/:user/:permlink',
        }
      ],
    };
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = { fs: false, module: false };
    }

    // Reown AppKit -> @coinbase/cdp-sdk imports the undeclared '@x402/*' peers.
    if (Array.isArray(config.resolve.alias)) {
      config.resolve.alias.push({ name: '@x402', alias: false });
    } else {
      config.resolve.alias = config.resolve.alias || {};
      config.resolve.alias['@x402'] = false;
    }

    config.plugins.push(
      new CopyPlugin({
        patterns: [
          {
            from: path.join(__dirname, '../../node_modules/@hiveio/hb-auth/dist/worker.js'),
            to: path.join(__dirname, 'public/auth/')
          },
          {
            from: path.join(__dirname, '../../node_modules/@hiveio/hb-auth/dist/assets'),
            to: path.join(__dirname, 'public/auth/assets')
          },
          /*
           * ★ TWO LOCALE COPIES REMOVED 2026-08-15 — NOTHING EVER READ THEM.
           *
           * These published `apps/blog/locales/` and
           * `packages/smart-signer/locales/` into `public/locales/` on every
           * build, i.e. served them over HTTP. But translations are not fetched
           * over HTTP here: both `i18n/client.ts` and `i18n/server.ts` use
           * `i18next-resources-to-backend` with a webpack dynamic
           * `import('../locales/<lang>/<ns>.json')`, so every namespace is
           * bundled. There is no `loadPath`, no HTTP backend, and a repo-wide
           * grep for `/locales` as a URL (apps AND packages) returns nothing.
           *
           * So this copied two source trees into every build output and every
           * Docker image for a directory no code has ever requested. It is also
           * where the stray `public/locales/ko/` came from — smart-signer ships
           * a Korean bundle the blog has no locale for.
           *
           * The hb-auth worker/assets and smart-signer public copies below stay:
           * those ARE fetched at runtime by URL.
           */
          {
            from: path.join(__dirname, '../../packages/smart-signer/public/smart-signer'),
            to: path.join(__dirname, 'public/smart-signer/')
          }
        ]
      })
    );

    return config;
  }
};

const withBundleAnalyzer = require('@next/bundle-analyzer')({
  enabled: process.env.ANALYZE === 'true'
});

// Sentry configuration - always included so builds are identical regardless of env vars.
// Sentry is enabled/disabled at runtime based on REACT_APP_SENTRY_DSN in instrumentation.ts
const { withSentryConfig } = require('@sentry/nextjs');

module.exports = withSentryConfig(withBundleAnalyzer(nextConfig), {
  // Disable source map upload - env vars not available at build time
  // Sentry is enabled/disabled at runtime based on REACT_APP_SENTRY_DSN in instrumentation.ts
  sourcemaps: {
    disable: true,
  },

  silent: true,

  webpack: {
    // Tree-shaking options for reducing bundle size
    treeshake: {
      removeDebugLogging: true,
    },
  },
});
