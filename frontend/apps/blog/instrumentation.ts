import {commonRegister} from '@hive/ui/lib/common-instrumentation';
import * as Sentry from '@sentry/nextjs';
// Type-only: erased at compile time, so this costs the edge bundle nothing —
// same reasoning as every dynamic `import()` below, just for a type instead
// of a value.
import type { IncomingMessage, ServerResponse } from 'node:http';

export async function register() {
  await commonRegister('blog');

  /**
   * ★ ONE TLS HANDSHAKE PER ORIGIN INSTEAD OF ONE PER CALL, WHEN ASKED FOR
   * (2026-09-05). Nothing in this repo has ever configured an outbound HTTP
   * dispatcher: wax reaches Hive through the bare global `fetch`, which is
   * Node's own undici with its default `Agent`, which drops an idle socket after
   * 4s. So the layout's two remaining round trips (`getAccount` p50 212ms,
   * `bridge.get_profile` p50 202ms, measured on the live cluster) each pay a
   * fresh TCP + TLS handshake on any profile render that is not immediately
   * behind another one.
   *
   * `lib/http-keepalive.ts` carries the full reasoning and the numbers; the
   * short version of the three properties that matter HERE:
   *
   *  1. `nodejs` ONLY, and behind a DYNAMIC import, for the same reason the warm
   *     below is: the edge runtime gets its own module instance, undici is a
   *     Node-only package, and a static import would drag it into the edge
   *     bundle to do nothing.
   *  2. BEFORE `warmServerCaches()`, so the boot warms are themselves the calls
   *     that open the pooled sockets. Installed after them, the first real
   *     reader would still dial cold and the warm would have paid for a
   *     connection nobody kept.
   *  3. IT MUST NEVER STOP THE SERVER, and that has to be what the CODE does
   *     rather than what a comment claims: EVERY import here is inside the
   *     `try`, including the logger and the settings module, because "the module
   *     failed to load" is the most likely failure of the lot (a standalone
   *     bundle that did not trace `undici`) and a `register()` that throws is a
   *     server that does not boot. `log` starts as `console.warn` and is upgraded
   *     to the app logger the moment that import lands, so the failure path never
   *     depends on anything the success path had to import.
   *
   * OFF IS BYTE-FOR-BYTE TODAY. With `LUMEN_HTTP_KEEPALIVE` unset, undici is
   * never imported, no dispatcher is replaced, and the only trace is the one boot
   * line saying which arm this process is in -- which is the point: an operator
   * A/B'ing this must be able to read the arm out of the log rather than infer
   * it from the numbers they are trying to judge.
   */
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    let log: (line: string) => void = (line) => console.warn(line);
    try {
      const { getLogger } = await import('@ui/lib/logging');
      const logger = getLogger('app');
      log = (line) => logger.info(line);

      const { httpKeepAliveSettings, httpKeepAliveLogLine } = await import('./lib/http-keepalive');
      const settings = httpKeepAliveSettings();

      if (settings.enabled) {
        const { Agent, setGlobalDispatcher } = await import('undici');
        setGlobalDispatcher(
          new Agent({
            keepAliveTimeout: settings.keepAliveTimeout,
            keepAliveMaxTimeout: settings.keepAliveMaxTimeout,
            connections: settings.connections,
            pipelining: settings.pipelining
          })
        );
      }
      log(httpKeepAliveLogLine(settings));
    } catch (error) {
      // Built by hand, NOT through `httpKeepAliveLogLine`, because that module is
      // one of the things that may have failed to import. Same prefix so the one
      // grep an operator runs still finds it. Degraded to today's behaviour: the
      // process keeps Node's default agent.
      log(
        'render-timing: http-keepalive off ' +
          `(REQUESTED but not installed: ${error instanceof Error ? error.message : String(error)})`
      );
    }
  }

  /**
   * ★ Fill the shared upstream caches before the first reader asks, so nobody
   * pays a 6.6s cold `bridge.list_communities` just for arriving first after a
   * deploy. See `lib/warm-server-caches.ts` for what is warmed and why it can
   * never delay or fail server start.
   *
   * ★ `nodejs` ONLY. The edge runtime gets its own module instance, so warming
   * there would spend the upstream calls again to fill a cache no page render
   * reads. The dynamic import keeps that cost out of the edge bundle entirely.
   */
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { warmServerCaches } = await import('./lib/warm-server-caches');
    warmServerCaches();
  }

  /**
   * ★★★ THE REQUEST-TIMING INSTRUMENT THAT CLOSES THE GAP THE PER-RENDER
   * LINES CANNOT SEE (2026-09-06, signed-in home build map section 6).
   *
   * `render-timing: home` and `render-timing: root-layout` cover every await
   * INSIDE the page and the layout, and that data phase is small and fully
   * accounted for (the build map's own section 0: warm root-layout 5-65ms,
   * home 18-173ms, run CONCURRENTLY). What is missing is everything AFTER the
   * last await: React's server-side HTML render of the client component tree,
   * and the event-loop queueing while that render waits behind every other
   * request in the same worker. Neither is an `await` this app controls, so
   * no `RenderTimer` inside a page can see it — it can only be measured from
   * OUTSIDE the render, at the HTTP layer itself.
   *
   * ★ `node:diagnostics_channel`, NOT a `http.Server.prototype.emit` patch.
   * Node 20 ships a built-in `http.server.request.start` channel (verified on
   * this box's Node 20.20.1: it fires with `{ request, response, socket,
   * server }` for a plain `http.createServer`) that fires for EVERY
   * `http.Server` in the process, however it was created — so this works
   * whether Next is started by `next start`, by a cluster launcher, or in
   * dev, with no dependency on WHEN `register()` runs relative to Next
   * building its own server object. A prototype patch would have needed to
   * land before that object existed; a diagnostics_channel subscription only
   * needs to exist before the first request, which boot-time `register()`
   * already guarantees. Node ALSO ships a `http.server.response.finish`
   * channel, but this code does not subscribe to it (fixed in this comment,
   * 2026-09-06, review) — the `response` object handed to the
   * `request.start` listener is a plain Node `ServerResponse`, so its own
   * ordinary `'finish'`/`'close'` events (below) are the simpler way to know
   * when it is done, on the exact same object this code already has a
   * reference to and is patching `write`/`end` on.
   *
   * ★ `nodejs` ONLY, behind `LUMEN_RENDER_TIMING=yes` — the same contract
   * `@ui/lib/render-timing` documents: with the flag off, nothing here is
   * imported, no channel is subscribed, no histogram runs, and the whole
   * block is one `renderTimingEnabled()` check.
   *
   * ★ ONLY HTML PAGE RESPONSES ARE LOGGED — `isBudgetedPage()` from
   * `lib/request-budget.ts` (reused, not reinvented: it already excludes
   * `_next/*`, every `/api/*` except the one it budgets as a page,
   * `/robots.txt`, and everything else in `public/`) plus an explicit
   * `/api/` exclusion, because `isBudgetedPage('/api/og')` is `true` for
   * THAT module's purpose (it rasterises an image on the same thread) but is
   * not an HTML page render for this one.
   *
   * ★ WHAT THIS NEVER DOES: change a byte of the response. `write`/`end` are
   * wrapped to OBSERVE `arguments` and call straight through with the
   * original `this`, inside a `try` that cannot throw past the original call
   * — an instrument is not allowed to be the reason a render fails, the same
   * rule `render-timing.ts` states for its own `mark()`/`done()`.
   */
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { renderTimingEnabled, sanitiseTimingField } = await import('@ui/lib/render-timing');
      if (renderTimingEnabled()) {
        const { getLogger } = await import('@ui/lib/logging');
        const logger = getLogger('app');
        const { isBudgetedPage } = await import('./lib/request-budget');
        const { cookieNamePrefix } = await import('@hive/smart-signer/lib/session');
        const dc = await import('node:diagnostics_channel');
        const { monitorEventLoopDelay } = await import('node:perf_hooks');

        const sessionCookieMarker = `${cookieNamePrefix}session=`;

        /**
         * A rough bucket, not a route match — this file has no access to
         * Next's router, and a bucket is enough to tell "which shape of page
         * is this" apart in a log line without ever printing an account name
         * or a permlink (every field is still run through
         * `sanitiseTimingField` below regardless, as defence in depth).
         */
        function classify(pathname: string): string {
          const segments = pathname.split('/').filter(Boolean);
          if (segments.length === 0) return 'home';
          if (segments[0] === 'topics') return 'topic';
          if (segments[0].startsWith('@') || segments[0].startsWith('%40')) {
            return segments.length === 1 ? 'profile' : 'profile-sub';
          }
          if (segments.length >= 2 && (segments[1].startsWith('@') || segments[1].startsWith('%40'))) {
            return 'post';
          }
          if (['trending', 'hot', 'created', 'payout', 'muted', 'roles'].includes(segments[0])) {
            return 'community-feed';
          }
          return 'other';
        }

        // ★ ONE HISTOGRAM FOR THE WHOLE WORKER, READ NOT RESET PER REQUEST.
        // Resetting on every request would make "the last second" mean
        // "since the last request", which is not the same quantity under
        // contention — exactly what this instrument exists to measure.
        // Refreshed once a second; `perf_hooks` reports nanoseconds,
        // converted to ms here so the log line matches every other `...ms`
        // field.
        const loopDelay = monitorEventLoopDelay({ resolution: 10 });
        loopDelay.enable();
        let loopP99Ms = 0;
        setInterval(() => {
          loopP99Ms = Math.round(loopDelay.percentile(99) / 1e6);
          loopDelay.reset();
        }, 1000).unref();

        let inFlight = 0;

        dc.subscribe('http.server.request.start', (message: unknown) => {
          try {
            const { request, response } = message as { request: IncomingMessage; response: ServerResponse };
            const rawUrl = request.url || '/';
            const pathname = rawUrl.split('?')[0] || '/';
            if (request.method !== 'GET' || pathname.startsWith('/api/') || !isBudgetedPage(pathname)) return;

            const startedAt = Date.now();
            const startedInFlight = inFlight;
            inFlight += 1;
            let settled = false;
            let firstByteMs = -1;
            let bytes = 0;

            const cookieHeader = request.headers.cookie || '';
            const signed = cookieHeader.includes(sessionCookieMarker);
            const rsc = request.headers['rsc'] === '1';

            const observe = (chunk: unknown, encoding: unknown): void => {
              try {
                if (firstByteMs === -1) firstByteMs = Date.now() - startedAt;
                // ★ `ArrayBuffer.isView`, NOT `Buffer.isBuffer` (2026-09-06,
                // review, caught before ship). The App Router's Fizz renderer
                // streams plain `Uint8Array` chunks through `res.write`, not
                // Node `Buffer` instances -- `Buffer.isBuffer(uint8array)` is
                // `false` for those, so the original check silently counted
                // `bytes=0` for every real page response. `ArrayBuffer.isView`
                // is `true` for a `Uint8Array` (and for a `Buffer`, which IS
                // one), and `Buffer.byteLength` accepts any `ArrayBufferView`
                // directly -- no copy, no conversion.
                if (typeof chunk === 'string' || ArrayBuffer.isView(chunk)) {
                  // Cast needed: `ArrayBuffer.isView`'s type guard narrows to the DOM
                  // lib's global `ArrayBufferView`, a structurally similar but
                  // DIFFERENT type from the `NodeJS.ArrayBufferView` `Buffer.byteLength`
                  // actually declares -- a real Uint8Array satisfies both at runtime.
                  bytes += Buffer.byteLength(
                    chunk as string | NodeJS.ArrayBufferView,
                    typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined
                  );
                }
              } catch {
                // An instrument may not break the write it is observing.
              }
            };

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const origWrite = (response.write as any).bind(response);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const origEnd = (response.end as any).bind(response);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (response as any).write = (...args: any[]) => {
              observe(args[0], args[1]);
              return origWrite(...args);
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (response as any).end = (...args: any[]) => {
              observe(args[0], args[1]);
              return origEnd(...args);
            };

            const finishOnce = (): void => {
              if (settled) return;
              settled = true;
              inFlight = Math.max(0, inFlight - 1);
              const totalMs = Date.now() - startedAt;
              logger.info(
                `request-timing: path=${sanitiseTimingField(classify(pathname))} ` +
                  `signed=${sanitiseTimingField(signed ? 'yes' : 'no')} rsc=${sanitiseTimingField(rsc ? 'yes' : 'no')} ` +
                  `ttfb=${sanitiseTimingField(`${firstByteMs}ms`)} total=${sanitiseTimingField(`${totalMs}ms`)} ` +
                  `bytes=${sanitiseTimingField(bytes)} inflight=${sanitiseTimingField(startedInFlight)} ` +
                  `loop=${sanitiseTimingField(`${loopP99Ms}ms`)}`
              );
            };
            response.once('finish', finishOnce);
            response.once('close', finishOnce);
          } catch {
            // An instrument may not break a request. Same rule as `observe` above.
          }
        });

        logger.info('request-timing: instrument installed (LUMEN_RENDER_TIMING=yes)');
      }
    } catch (error) {
      // Same degrade-never-throw contract as the keep-alive block above: a
      // failed import (or an old Node without these diagnostics_channel
      // hooks) must never fail server boot.
      console.warn(
        'request-timing: not installed ' + `(${error instanceof Error ? error.message : String(error)})`
      );
    }
  }

  if (!!process.env.REACT_APP_SENTRY_DSN && process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }

  if (!!process.env.REACT_APP_SENTRY_DSN && process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = !!process.env.REACT_APP_SENTRY_DSN ? Sentry.captureRequestError : undefined;
