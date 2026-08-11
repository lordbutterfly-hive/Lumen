'use client';

import { useEffect } from 'react';
import { handleError } from '@ui/lib/handle-error';
import ServiceUnavailable from '@/blog/components/service-unavailable';
import { isChunkLoadError, reloadOnceForChunkError } from '@/blog/lib/chunk-error-reload';

/**
 * ★★★ ROOT-LAYOUT-LEVEL BOUNDARY — DELIBERATELY DEPENDENCY-LIGHT (2026-08-11).
 *
 * `global-error.tsx` only ever mounts when `app/layout.tsx` itself failed, so
 * it replaces `<html>`/`<body>` from scratch and does not inherit the root
 * layout's font classes or run inside `Providers`. Tailwind's compiled CSS
 * chunk is normally still present (`ServiceUnavailable`, kept below for the
 * non-chunk case, already relied on it), but WHEN THE FAILURE IS A CHUNK-LOAD
 * ERROR the css/js bundle this page's own styling might depend on is exactly
 * the kind of asset that can be missing too — so the branded chunk-error copy
 * below is written in plain inline styles, not Tailwind classes, so it does
 * not add a second thing that can fail to load on top of the first.
 *
 * ★ CHUNK-LOAD-ERROR AUTO-RECOVERY, same fix as `app/error.tsx` — see that
 * file and `lib/chunk-error-reload.ts` for the full reasoning, including why
 * this component's own code is not guaranteed to run at all in the worst case
 * (its compiled chunk purged in the same deploy as `app/layout.js`), which is
 * what the plain inline `<script>` in `app/layout.tsx` exists to cover.
 */
export default function GlobalError({
  error,
  reset: _reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const chunkError = isChunkLoadError(error);

  useEffect(() => {
    handleError(error, { method: 'GlobalErrorBoundary', params: { digest: error.digest, chunkError } });
    if (chunkError) reloadOnceForChunkError();
  }, [error, chunkError]);

  if (chunkError) {
    return (
      <html lang="en">
        <body style={{ margin: 0, background: '#fafafa', color: '#161511', fontFamily: 'system-ui, sans-serif' }}>
          <div
            style={{
              display: 'flex',
              minHeight: '100vh',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '24px',
              textAlign: 'center'
            }}
          >
            <div
              style={{
                maxWidth: 440,
                borderRadius: 20,
                border: '1px solid #eee2dc',
                borderLeft: '3px solid #c0392b',
                background: 'linear-gradient(125% 130% at 0% 0%, #f7c9bd 0%, #fbdfd6 30%, #fdefe9 58%, #fffdfc 85%)',
                padding: '28px 28px 24px'
              }}
            >
              <p style={{ margin: '0 0 6px', fontSize: 34, fontWeight: 600, lineHeight: 1.1 }}>Lumen</p>
              <p style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600 }}>Updating Lumen</p>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: '#6b7280' }}>
                A newer version of this page is ready. Reloading now.
              </p>
            </div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                marginTop: 20,
                height: 40,
                padding: '0 20px',
                borderRadius: 14,
                border: 'none',
                background: '#c0392b',
                color: '#fff',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Reload now
            </button>
          </div>
        </body>
      </html>
    );
  }

  return (
    <html lang="en">
      <body>
        <ServiceUnavailable />
      </body>
    </html>
  );
}
