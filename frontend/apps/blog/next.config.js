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
      ...RETIRED_SORTS.flatMap((sort) => [
        { source: `/${sort}`, destination: '/', permanent: false },
        { source: `/${sort}/my`, destination: '/', permanent: false },
        { source: `/${sort}/:tag`, destination: '/topics/:tag', permanent: false }
      ]),
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
          {
            from: path.join(__dirname, './locales'),
            to: path.join(__dirname, 'public/locales/')
          },
          {
            from: path.join(__dirname, '../../packages/smart-signer/locales'),
            to: path.join(__dirname, 'public/locales/')
          },
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
