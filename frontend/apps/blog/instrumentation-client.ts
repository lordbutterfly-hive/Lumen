// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import env from "@beam-australia/react-env";
import { scrubEvent } from "@ui/lib/sentry-scrub";

/**
 * ★★★ LOADED ONLY WHEN A DSN EXISTS (2026-08-13).
 *
 * The gate below was already correct — Sentry never initialises without a DSN, and
 * `window.__SENTRY__` is `undefined` at runtime on any install that has not set one.
 * What was NOT conditional was the IMPORT: `import * as Sentry` is static, so the
 * whole SDK (core plus Session Replay) was linked into the entry chunks and shipped
 * to every reader whether or not it could ever run. Measured in the production
 * bundle: Sentry code present in 4 chunks, including Replay in `d763957a` (121 KB)
 * and core in `9007` (361 KB), with nothing initialised.
 *
 * A dynamic `import()` inside the gate keeps every behaviour that matters — same
 * options, same `scrubEvent`, same deliberate Replay masking of the upgrade screen's
 * private keys — while letting the bundler split it out, so an install without a DSN
 * downloads none of it. This is why the SDK is NOT simply deleted: with a DSN set it
 * still initialises and still reports, exactly as before.
 */
let captureRouterTransitionStart: ((...args: unknown[]) => void) | undefined;

if (!!env('SENTRY_DSN')) {
  void import("@sentry/nextjs").then((Sentry) => {
    captureRouterTransitionStart = Sentry.captureRouterTransitionStart as typeof captureRouterTransitionStart;

Sentry.init({
  dsn: env('SENTRY_DSN'),

  // Add optional integrations for additional features
  integrations: [
    Sentry.replayIntegration({
      // SECURITY: Mask all input fields to prevent capturing passwords/keys in session replays
      maskAllInputs: true,
      // The upgrade screen renders a master password and four private keys as TEXT,
      // not inputs, so `maskAllInputs` does not cover them — today they are masked only
      // by rrweb's `maskAllText` default, and `beforeSend`/`scrubSensitiveData` never
      // runs for replay envelopes (Sentry applies it to error events only). Blocking
      // the element outright means the guarantee does not depend on a default that a
      // future "make replays readable" change could flip.
      block: ['[data-testid="upgrade-keys"]'],
    }),
  ],

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 1,
  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Define how likely Replay events are sampled.
  // This sets the sample rate to be 10%. You may want this to be 100% while
  // in development and sample at a lower rate in production
  replaysSessionSampleRate: 0.1,

  // Define how likely Replay events are sampled when an error occurs.
  replaysOnErrorSampleRate: 1.0,

  // SECURITY: Disable PII collection by default for staging/production.
  // Set SENTRY_SEND_PII=true for local development debugging only.
  // This prevents Sentry from capturing IP addresses, cookies, and headers.
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: env('SENTRY_SEND_PII') === 'true',

  // SECURITY: Scrub WIF private keys from error events before sending to Sentry
  beforeSend: scrubEvent as any,
});

  });
}

/**
 * Next calls this on every client route change. It has to be a stable export that
 * exists at module-evaluation time, but the SDK it delegates to now arrives
 * asynchronously — so this is a thin forwarder that no-ops until the import
 * resolves (a few hundred ms at worst, during which the only loss is transition
 * timing for those first navigations) and is `undefined` entirely without a DSN,
 * exactly as before.
 */
export const onRouterTransitionStart = !!env('SENTRY_DSN')
  ? (...args: unknown[]) => captureRouterTransitionStart?.(...args)
  : undefined;
