// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "@ui/lib/sentry-scrub";

/**
 * ★★ ENV-DRIVEN, DEFAULT 0.05 (2026-09-06, signed-in home build map item 7).
 * `SENTRY_TRACES_SAMPLE_RATE` overrides it; unset or unparsable falls back to
 * 0.05, never to 0 or NaN. ★ EMPTY STRING IS TREATED AS UNSET (2026-09-06,
 * review, caught before ship): `Number('')` is `0` in JS, so a declared-but-
 * empty override would otherwise silently disable tracing rather than fall
 * back to the default. Error events are UNCHANGED by this: `tracesSampler`
 * below gates performance transactions only, this file never sets
 * `sampleRate` (the separate error-event knob), so `beforeSend`/`scrubEvent`
 * still see and can send every error at its default of 100%.
 *
 * Unlike `sentry.edge.config.ts`'s copy of this function, this one runs in
 * the Node.js runtime and reads the LIVE environment on every
 * `Sentry.init()` -- no build-time inlining here, so this one IS
 * runtime-tunable by changing the env var and restarting the process (no
 * rebuild needed).
 */
function tracesSampleRate(): number {
  const raw = (process.env.SENTRY_TRACES_SAMPLE_RATE ?? '').trim();
  if (raw === '') return 0.05;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.05;
}

Sentry.init({
  dsn: process.env.REACT_APP_SENTRY_DSN,

  // Only trace authenticated requests (those with account_info cookie).
  // Unauthenticated traffic (bots, crawlers, casual visitors) generates
  // thousands of unique SSR traces that accumulate Sentry span objects
  // in memory. Lab tests showed Sentry adds ~2.5 KB/req heap + ~7.5 KB/req
  // RSS under such traffic (see denser#886).
  //
  // ★ THE 1.0 BELOW IS NOW THE SAME ENV-DRIVEN RATE AS THE EDGE CONFIG, NOT A
  // LITERAL 100% (2026-09-06). The cookie check still decides WHETHER an
  // authenticated request is eligible for tracing at all -- unauthenticated
  // traffic is still always 0, untouched -- but an eligible request is now
  // sampled at `SENTRY_TRACES_SAMPLE_RATE` (default 0.05) rather than always
  // traced, so a signed-in reader's own request is not still paying the same
  // per-request tracing cost this build map's item 7 measured on the edge
  // side.
  tracesSampler: (samplingContext) => {
    const cookie = samplingContext.request?.headers?.cookie ?? '';
    if (cookie.split(';').some((c: string) => c.trim().startsWith('account_info='))) {
      return tracesSampleRate();
    }
    return 0;
  },

  // Enable structured logging API (Sentry.logger.*)
  enableLogs: true,

  // SECURITY: Disable PII collection by default for staging/production.
  // Set REACT_APP_SENTRY_SEND_PII=true for local development debugging only.
  // This prevents Sentry from capturing IP addresses, cookies, and headers.
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: process.env.REACT_APP_SENTRY_SEND_PII === 'true',

  // SECURITY: Scrub WIF private keys from error events before sending to Sentry
  beforeSend: scrubEvent as any,
});
