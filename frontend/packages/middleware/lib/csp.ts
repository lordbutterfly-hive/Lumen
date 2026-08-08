/**
 * Content Security Policy builder for runtime evaluation
 *
 * This module builds CSP headers at runtime so environment variables
 * can be evaluated when the server starts, not at build time.
 */

/**
 * App-specific CSP configuration
 */
export interface CspConfig {
  /**
   * Additional frame-src sources beyond 'self'
   * Blog needs: twitter, instagram, vimeo, youtube, soundcloud, twitch, spotify, 3speak, odysee, openhive.chat
   * Wallet needs: accounts.google.com (for OAuth)
   */
  frameSrc?: string[];

  /**
   * CSP report URI endpoint
   */
  reportUri?: string;
}

/**
 * Build connect-src allowed hosts from environment variables
 */
function buildConnectSrcHosts(): Set<string> {
  const hosts = new Set([
    'https://api.hive.blog',
    'https://api.syncad.com',
    'https://api.openhive.network',
    'https://images.hive.blog'
  ]);

  // Allow custom API nodes from environment
  const allowedNodes = process.env.REACT_APP_ALLOWED_HIVE_API_NODES;
  if (allowedNodes) {
    const nodes = allowedNodes.split(/[ ,]+/).filter(Boolean);
    if (nodes.length > 0) {
      hosts.clear();
      nodes.forEach((node) => hosts.add(node));
    }
  }

  // Ensure the configured images endpoint is in connect-src for proxy-auth token fetch
  const imagesEndpoint = process.env.REACT_APP_IMAGES_ENDPOINT;
  if (imagesEndpoint) {
    try {
      hosts.add(new URL(imagesEndpoint).origin);
    } catch { /* invalid URL, skip */ }
  }

  // Google APIs for Drive wallet backup and Sign-In.
  // ★ `REACT_APP_LITE_GOOGLE_CLIENT_ID` is what Lumen's login actually reads;
  // keying this solely off the Drive variable meant a correctly-configured
  // Google sign-in was still blocked. See buildScriptSrc() for the full story.
  if (process.env.REACT_APP_GOOGLE_DRIVE_CLIENT_ID) {
    hosts.add('https://www.googleapis.com');
  }
  if (process.env.REACT_APP_GOOGLE_DRIVE_CLIENT_ID || process.env.REACT_APP_LITE_GOOGLE_CLIENT_ID) {
    hosts.add('https://accounts.google.com');
  }

  // ★★★ MAGI (VSC) ENDPOINTS — creator tokens and the prediction market.
  //
  // Added 2026-08-06 after a QA pass caught the token page dying with
  // "Couldn't load this market — we couldn't reach the chain just now" and
  // `Refused to connect to 'https://magi-test.techcoderx.com/api/v1/graphql'
  // because it violates the Content Security Policy`. The contract was deployed
  // and correctly configured; the browser was simply forbidden from talking to
  // it. Derived from the SAME env vars the features read, so provisioning a
  // contract can never again leave the CSP behind — the failure mode was
  // especially cruel because both the feature config and the contract were
  // right, and the only symptom was a generic "chain unreachable".
  for (const varName of [
    'REACT_APP_CREATOR_TOKENS_GQL_URL',
    'REACT_APP_CREATOR_TOKENS_INDEXER_URL',
    'REACT_APP_VSC_MARKET_GQL_URL',
    'REACT_APP_VSC_MARKET_INDEXER_URL'
  ]) {
    const value = process.env[varName];
    if (!value) continue;
    try {
      hosts.add(new URL(value).origin);
    } catch { /* invalid URL, skip */ }
  }

  // ★★★ COINGECKO — the wallet's own price cards.
  //
  // Found by an exploratory UX tester 2026-08-06: /wallet renders "$1.000" as
  // if it were a live HBD price AND "Price unavailable" in the same card, while
  // the console shows `Refused to connect to 'https://api.coingecko.com/...'`.
  // The widget was not broken; the browser was forbidden from fetching the data
  // it needed, so it fell back to a hardcoded peg value and contradicted itself.
  hosts.add('https://api.coingecko.com');

  // ★★★ REOWN / WALLETCONNECT — the PRIMARY "Connect a Bitcoin/Ethereum wallet"
  // button on the login page.
  //
  // Same tester, worse consequence: the connect modal opened with an EMPTY
  // wallet list and no error, because its icon API and font host were both
  // CSP-blocked. Anyone who actually owns a wallet — the people this button is
  // for — hit a dead list. Only gated on the project id the feature itself
  // reads, so an unconfigured deploy grants nothing extra.
  if (process.env.REACT_APP_REOWN_PROJECT_ID) {
    hosts.add('https://api.web3modal.org');
    hosts.add('https://pulse.walletconnect.org');
    hosts.add('https://relay.walletconnect.org');
    hosts.add('wss://relay.walletconnect.org');
    hosts.add('https://explorer-api.walletconnect.com');
  }

  // Sentry error reporting
  if (process.env.REACT_APP_SENTRY_DSN) {
    // Support both Sentry SaaS and self-hosted instances
    // DSN format: https://<key>@<host>/<project_id>
    try {
      const dsnUrl = new URL(process.env.REACT_APP_SENTRY_DSN);
      const sentryHost = dsnUrl.hostname;
      if (sentryHost.endsWith('.sentry.io')) {
        // Sentry SaaS - use ingest subdomains
        hosts.add('https://*.ingest.sentry.io');
        hosts.add('https://*.ingest.us.sentry.io');
      } else {
        // Self-hosted Sentry
        hosts.add(`https://${sentryHost}`);
      }
    } catch {
      // Fallback to SaaS domains if DSN parsing fails
      hosts.add('https://*.ingest.sentry.io');
      hosts.add('https://*.ingest.us.sentry.io');
    }
  }

  return hosts;
}

/**
 * ★★★ THE TWO THIRD-PARTY SCRIPTS THE SIGN-UP PATH CANNOT RUN WITHOUT.
 *
 * Added 2026-08-06 after the first auth-gated QA run against a PRODUCTION build
 * behind real TLS. Both of these are invisible in `next dev` on http://, which
 * is why they survived every previous pass:
 *
 *  1. CLOUDFLARE TURNSTILE. `assertLiteEnabled()` REFUSES to run signup in
 *     production unless `LITE_TURNSTILE_SECRET` is set (captcha must not fail
 *     open) — so on the real site the widget is not optional, it is mandatory.
 *     But its script and its iframe both come from challenges.cloudflare.com,
 *     which this CSP did not allow. The widget would therefore never render,
 *     `captchaRequired && !captchaToken` would stay true forever, and the
 *     "Create account" button would be permanently disabled. Net effect: with
 *     the config the code itself demands, NOBODY could sign up.
 *
 *  2. GOOGLE SIGN-IN was gated on `REACT_APP_GOOGLE_DRIVE_CLIENT_ID` — a
 *     different feature's variable. Lumen's login reads
 *     `REACT_APP_LITE_GOOGLE_CLIENT_ID`, so configuring Google sign-in exactly
 *     as documented still left its origin out of the CSP. That is the reported
 *     "Google login does nothing": the button mounts, GIS never loads.
 *
 * Both are derived from the SAME env vars the features read, so provisioning a
 * key can never again leave the CSP behind.
 */
function googleSignInEnabled(): boolean {
  return Boolean(
    process.env.REACT_APP_LITE_GOOGLE_CLIENT_ID || process.env.REACT_APP_GOOGLE_DRIVE_CLIENT_ID
  );
}

function turnstileEnabled(): boolean {
  return Boolean(process.env.REACT_APP_TURNSTILE_SITE_KEY);
}

/** The WalletConnect/Reown connect modal, used by the BTC + EVM login buttons. */
function reownEnabled(): boolean {
  return Boolean(process.env.REACT_APP_REOWN_PROJECT_ID);
}

/** Frame sources the auth path needs, on top of whatever the app whitelists. */
function authFrameSrcHosts(): string[] {
  const hosts: string[] = [];
  // The Turnstile challenge itself is an iframe; frame-src omitting this host
  // is enough on its own to make signup impossible.
  if (turnstileEnabled()) hosts.push('https://challenges.cloudflare.com');
  // The Reown modal renders wallet handoff in an iframe.
  if (reownEnabled()) hosts.push('https://secure.walletconnect.org');
  // GIS renders both the button and the One Tap prompt in iframes.
  if (googleSignInEnabled()) hosts.push('https://accounts.google.com');
  return hosts;
}

/**
 * Build script-src directive
 */
function buildScriptSrc(): string {
  let scriptSrc = "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'";

  // Twitter/X widgets.js for native tweet rendering (used by TwitterResizePlugin)
  scriptSrc += ' https://platform.twitter.com';

  if (googleSignInEnabled()) {
    scriptSrc += ' https://accounts.google.com/gsi/';
  }

  if (turnstileEnabled()) {
    // Path-less: Turnstile's api.js pulls further chunks from the same host.
    scriptSrc += ' https://challenges.cloudflare.com';
  }

  return scriptSrc;
}

/**
 * Build the full CSP header value at runtime
 */
export function buildCsp(config: CspConfig = {}): string {
  const connectSrcHosts = buildConnectSrcHosts();
  const scriptSrc = buildScriptSrc();

  // Image proxy host — all external images are proxied through this
  let imagesHost = 'https://images.hive.blog';
  const imagesEndpoint = process.env.REACT_APP_IMAGES_ENDPOINT;
  if (imagesEndpoint) {
    try {
      imagesHost = new URL(imagesEndpoint).origin;
    } catch { /* invalid URL, use default */ }
  }

  // App whitelist (post embeds) + whatever the auth path needs. Merged here, not
  // in the app's middleware config, so the embed list and the login requirements
  // stay independent — a future embed edit cannot silently drop signup.
  const frameSrcList = [...new Set([...(config.frameSrc ?? []), ...authFrameSrcHosts()])];
  const frameSrcValue =
    frameSrcList.length > 0 ? `frame-src ${frameSrcList.join(' ')}` : "frame-src 'self'";

  const directives = [
    // Default fallback for unspecified resource types
    "default-src 'self'",
    // Scripts: self + inline (required for Next.js) + eval (required for HBAuth/Beekeeper WASM) + Google Sign-In
    scriptSrc,
    // Styles: self + inline (required for React/Next.js styling)
    "style-src 'self' 'unsafe-inline'",
    // Images: self + image proxy + data URIs + blob (for image processing/previews)
    // Wallet icons in the connect modal are served from Reown's asset API.
    reownEnabled()
      // ★ YouTube thumbnails (2026-08-07). The renderer injects
      // `<img src="https://img.youtube.com/vi/<id>/hqdefault.jpg">` into every
      // post body containing a YouTube link, with no fallback — so every such
      // embed rendered as a broken-image icon and the console filled with CSP
      // refusals. img.youtube.com serves images only; allowing it here costs
      // nothing and fixes every video preview in the app.
      ? `img-src 'self' ${imagesHost} https://img.youtube.com https://i.ytimg.com data: blob: https://api.web3modal.org`
      : `img-src 'self' ${imagesHost} https://img.youtube.com https://i.ytimg.com data: blob:`,
    // Fonts: self + data URIs (for inline fonts)
    // ★ `fonts.reown.com` — without it the connect modal's own typeface is
    //   blocked and it renders as an empty, unstyled shell.
    reownEnabled() ? "font-src 'self' data: https://fonts.reown.com" : "font-src 'self' data:",
    // API connections: whitelist of trusted Hive API nodes and services
    `connect-src 'self' ${[...connectSrcHosts].join(' ')}`,
    // Embedded content: app-specific whitelist
    frameSrcValue,
    // Web Workers: self + blob (for HBAuth worker)
    "worker-src 'self' blob:",
    // Prevent site from being embedded in iframes (clickjacking protection)
    "frame-ancestors 'self'",
    // Restrict base URI to prevent base tag injection
    "base-uri 'self'",
    // Restrict form submissions to same origin
    "form-action 'self'"
  ];

  // Add report URI if configured
  if (config.reportUri) {
    directives.push(`report-uri ${config.reportUri}`);
  }

  return directives.join('; ');
}

/**
 * Security headers that don't depend on environment variables
 * These can stay in next.config.js or be applied via middleware
 */
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-XSS-Protection': '1; mode=block',
  'X-DNS-Prefetch-Control': 'off',
  'X-Download-Options': 'noopen',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};
