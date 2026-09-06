// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "@ui/lib/sentry-scrub";

/**
 * ★★ ENV-DRIVEN, DEFAULT 0.05 (2026-09-06, signed-in home build map item 7).
 * This ran every single request at 100% tracing -- measured at ~5ms of the
 * ~10ms the middleware costs per request (lib/request-budget.ts's own
 * analysis, section 3.4/4.8), a fixed tax on every page the middleware runs
 * for, tracked or not. `SENTRY_TRACES_SAMPLE_RATE` overrides it; unset or
 * unparsable falls back to 0.05, never to 0 or NaN (a bad env value must
 * degrade to "sampled a little", not "no traces recorded" or a thrown init).
 * ★ EMPTY STRING IS TREATED AS UNSET, NOT AS ZERO (2026-09-06, review, caught
 * before ship): `Number('')` is `0` in JS, not `NaN` -- so a declared-but-
 * empty `SENTRY_TRACES_SAMPLE_RATE=` in an env file would have silently
 * disabled tracing entirely instead of falling back to the default, and
 * looked identical to an explicit, deliberate `0`. Trimmed and checked for
 * emptiness before `Number()` ever sees it.
 * Error events are UNCHANGED -- `tracesSampleRate` gates performance
 * transactions only; this file never sets `sampleRate` (the error-event
 * knob), so `beforeSend`/`scrubEvent` below still see and can send every
 * error at its default of 100%.
 *
 * ★★ NOT RUNTIME-TUNABLE HERE, UNLIKE THE SERVER CONFIG (2026-09-06, review).
 * Next's Edge Runtime bundle statically replaces `process.env.X` references
 * with their BUILD-TIME value (the same reason this codebase already routes
 * genuinely runtime-tunable, browser-visible config through
 * `@beam-australia/react-env`'s `env()` / `window.__ENV` instead of a bare
 * `process.env` read -- see `getBrowserEnv()`/`instrumentation-client.ts`).
 * So changing `SENTRY_TRACES_SAMPLE_RATE` on a running box changes this
 * file's sampling only after the NEXT BUILD, not the next request --
 * `sentry.server.config.ts`'s copy of this function runs in the Node.js
 * runtime and DOES read the live environment on every `Sentry.init()`.
 */
function tracesSampleRate(): number {
  const raw = (process.env.SENTRY_TRACES_SAMPLE_RATE ?? '').trim();
  if (raw === '') return 0.05;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.05;
}

Sentry.init({
  dsn: process.env.REACT_APP_SENTRY_DSN,

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: tracesSampleRate(),

  // Enable logs to be sent to Sentry
  enableLogs: true,

  // SECURITY: Disable PII collection by default for staging/production.
  // Set REACT_APP_SENTRY_SEND_PII=true for local development debugging only.
  // This prevents Sentry from capturing IP addresses, cookies, and headers.
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: process.env.REACT_APP_SENTRY_SEND_PII === 'true',

  // SECURITY: Scrub WIF private keys from error events before sending to Sentry
  beforeSend: scrubEvent as any,
});
