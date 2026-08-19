'use client';

import { useEffect } from 'react';
import { Link } from '@hive/ui';
import { handleError } from '@ui/lib/handle-error';
import PageMasthead from '@/blog/features/layouts/page-masthead';
import { isChunkLoadError, reloadOnceForChunkError } from '@/blog/lib/chunk-error-reload';

// TODO i18n — staged copy, same precedent as app-header's LABELS.
const COPY = {
  title: 'Something went wrong',
  body: 'This page hit an error it could not recover from. Reloading usually fixes it.',
  updatingTitle: 'Updating Lumen',
  updatingBody: 'A newer version of this page is ready. Reloading now.',
  tryAgain: 'Try again',
  home: 'Go to the home feed',
  reload: 'Reload'
};

const PRIMARY =
  'inline-flex h-10 items-center justify-center rounded-card bg-surface-brand-12 px-5 font-sans text-[14px] leading-[22px] font-semibold text-ink-27 transition-colors hover:bg-surface-brand-15';
const SECONDARY =
  'inline-flex h-10 items-center justify-center rounded-card border border-line-11 px-5 font-sans text-[14px] leading-[22px] font-semibold text-ink-7 transition-colors hover:bg-surface-16';

/**
 * ★★★ ROOT ERROR BOUNDARY, LUMEN-STYLED, CHUNK-LOAD-AWARE (2026-08-11).
 *
 * Was the stock shadcn "Something went wrong!" — default sans, a
 * `text-muted-foreground` line, a default-variant `Button` — the same
 * off-brand shape `app/not-found.tsx` was fixed for on 2026-08-10. Same
 * masthead, same brand-red action button, no bare `<h2>`.
 *
 * ★ CHUNK-LOAD-ERROR AUTO-RECOVERY. `ChunkLoadError: Loading chunk app/layout
 * failed` reached a real reader on `/@lordbutterfly` and produced Next's dev
 * overlay — because in dev this route is not even mounted yet, so there was
 * no boundary alive to catch it. In production the same failure means: this
 * tab loaded before the last deploy, and the chunk it now needs was purged
 * with the old build. No amount of "Try again" fixes that — the chunk is not
 * coming back — so this reloads the document once instead of showing an error
 * a retry cannot resolve. See `lib/chunk-error-reload.ts` for why this alone
 * is not the whole fix: when `app/layout.js` itself is the purged chunk,
 * `app/error.js` is usually purged in the same deploy, and this component's
 * own code never gets to run. `app/layout.tsx` carries a second, dependency-free
 * copy of this same detection in a plain inline `<script>` for exactly that
 * case.
 *
 * ★ ITEM 4 (2026-08-11): the `chunkError` branch used to render ONLY the
 * "Updating Lumen... Reloading now" text with no button at all. That text is
 * a promise, not a guarantee — `reloadOnceForChunkError()` silently no-ops
 * inside its 10-minute cooldown, and a repeat failure inside that window left
 * this exact card on screen forever with nothing to click. Now a manual
 * reload button is always rendered for the chunk-error case too, so a stuck
 * "reloading now" message always has a way out.
 */
export default function Error({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const chunkError = isChunkLoadError(error);

  useEffect(() => {
    handleError(error, { method: 'RootErrorBoundary', params: { digest: error.digest, chunkError } });
    if (chunkError) reloadOnceForChunkError();
  }, [error, chunkError]);

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-[520px] flex-col items-center justify-center px-6 text-center">
      <div className="w-full text-left">
        <PageMasthead title={chunkError ? COPY.updatingTitle : COPY.title}>
          <p className="max-w-[460px] font-serif text-caption text-ink-10">
            {chunkError ? COPY.updatingBody : COPY.body}
          </p>
        </PageMasthead>
        {chunkError ? (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => window.location.reload()} className={PRIMARY}>
              {COPY.reload}
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => reset()} className={PRIMARY}>
              {COPY.tryAgain}
            </button>
            <Link href="/" className={SECONDARY}>
              {COPY.home}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
