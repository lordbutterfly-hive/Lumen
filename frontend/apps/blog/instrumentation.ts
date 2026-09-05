import {commonRegister} from '@hive/ui/lib/common-instrumentation';
import * as Sentry from '@sentry/nextjs';

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

  if (!!process.env.REACT_APP_SENTRY_DSN && process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }

  if (!!process.env.REACT_APP_SENTRY_DSN && process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = !!process.env.REACT_APP_SENTRY_DSN ? Sentry.captureRequestError : undefined;
