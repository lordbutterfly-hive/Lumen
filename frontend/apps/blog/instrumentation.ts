import {commonRegister} from '@hive/ui/lib/common-instrumentation';
import * as Sentry from '@sentry/nextjs';

export async function register() {
  await commonRegister('blog');

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
