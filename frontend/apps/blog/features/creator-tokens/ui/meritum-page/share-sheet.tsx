'use client';

import { FC, useEffect, useRef, useState } from 'react';
import ModalShell from '../modal-shell';
import { LumenLoader } from '@hive/ui';
import { MERITUM_PAGE_COPY as COPY } from './meritum-copy';

/**
 * The share sheet (handoff §3): a live preview of the card, the URL in full
 * and selectable, and Copy that confirms in place. No session needed. Where
 * the browser offers a native share sheet (`navigator.share`, phones mostly)
 * a button opens it too; everywhere else the fallback above is the whole
 * sheet.
 *
 * ★ THE PREVIEW IS THE REAL CARD. `cardSrc` is the same route crawlers fetch
 * (`/api/og/meritum?u=<handle>&v=<price>`), so what the reader sees here is
 * byte-for-byte what a timeline will show — not a stock image, not a second
 * renderer that can drift from the first.
 *
 * ★ THE URL IS THE CONFIGURED SITE ORIGIN, NEVER `location.host`: a page
 * served through an odd hostname (a preview deploy, a proxy) must still hand
 * out the canonical address, and a reader must never be able to copy a URL
 * that points anywhere but the real site.
 */
const ShareSheet: FC<{ handle: string; url: string; cardSrc: string; onClose: () => void }> = ({ handle, url, cardSrc, onClose }) => {
  const [copied, setCopied] = useState(false);
  const [canNativeShare, setCanNativeShare] = useState(false);
  // The card is rendered on the server on first request (a few seconds cold);
  // the box keeps the 1200x630 ratio and says what is happening meanwhile
  // (owner, 2026-09-15: "there needs to be a spinner and telling people it will
  // be generated").
  const [cardState, setCardState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Read after mount, never in render: the server has no navigator.
    setCanNativeShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = async () => {
    let done = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        done = true;
      }
    } catch {
      done = false;
    }
    if (!done) {
      // The old way, for a browser that refuses the async clipboard on this
      // page (an insecure context, or permission denied): select the text so
      // the reader can copy it themselves, and say nothing false.
      const el = document.getElementById('meritum-share-url');
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2_000);
  };

  const nativeShare = async () => {
    try {
      await navigator.share({ title: `@${handle} on Lumen`, url });
    } catch {
      // Dismissed, or refused: the sheet is still open with the URL and Copy.
    }
  };

  return (
    <ModalShell width={520} onClose={onClose} title={COPY.shareTitle(handle)}>
      <div className="p-6" data-testid="meritum-share-sheet">
        <div className="flex items-center gap-3">
          <h3 className="font-ui text-[20px] leading-[28px] font-medium text-ink-2">{COPY.shareTitle(handle)}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={COPY.close}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-control bg-surface-11 font-ui text-[16px] text-ink-7 hover:bg-surface-16"
          >
            ×
          </button>
        </div>
        <p className="mt-1 font-ui text-caption text-ink-14">{COPY.shareHint}</p>
        <div className="relative mt-4 overflow-hidden rounded-card border border-line-9 bg-surface-1" style={{ aspectRatio: '1200 / 630' }} data-testid="meritum-share-card-box" data-state={cardState}>
          {/* The card at half size: 1200x630 keeps its ratio at any width. */}
          <img
            src={cardSrc}
            alt={`@${handle} on Lumen`}
            width={1200}
            height={630}
            onLoad={() => setCardState('ready')}
            onError={() => setCardState('failed')}
            className={`block h-auto w-full transition-opacity duration-300 ${cardState === 'ready' ? 'opacity-100' : 'opacity-0'}`}
            data-testid="meritum-share-card"
          />
          {cardState !== 'ready' ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 overflow-hidden bg-surface-1 px-6 text-center" data-testid="meritum-share-card-status">
              {cardState === 'loading' ? (
                <>
                  {/* `sm`, not `md` (2026-09-15, owner: "generating your card clips
                      bottom"): the md loader's 260px minimum alone was taller than
                      this 1200x630 box at sheet width (~245px), so the words under
                      it were pushed out of the box. The loader's own label is
                      screen-reader only; the words must be on screen too. */}
                  <LumenLoader size="sm" label={COPY.cardGenerating} className="shrink-0" />
                  <p className="font-ui text-[14px] font-medium text-ink-2" data-testid="meritum-share-card-generating">
                    {COPY.cardGenerating}…
                  </p>
                  <p className="font-ui text-caption text-ink-14">{COPY.cardGeneratingHint}</p>
                </>
              ) : (
                <p className="font-ui text-caption text-ink-14">{COPY.cardFailed}</p>
              )}
            </div>
          ) : null}
        </div>
        <div className="mt-4 flex items-center gap-2.5 rounded-control bg-surface-11 px-3.5 py-3">
          <span id="meritum-share-url" className="min-w-0 flex-1 select-all break-all font-ui text-[14px] leading-[22px] text-ink-4" data-testid="meritum-share-url">
            {url}
          </span>
          <button
            type="button"
            onClick={copy}
            className="shrink-0 rounded-full bg-surface-brand-12 px-4 py-1.5 font-ui text-[13px] font-medium text-ink-27 hover:bg-surface-brand-16"
            data-testid="meritum-share-copy"
            aria-live="polite"
          >
            {copied ? COPY.copied : COPY.copy}
          </button>
        </div>
        {canNativeShare ? (
          <button
            type="button"
            onClick={nativeShare}
            className="mt-3 w-full rounded-full border border-line-11 bg-surface-1 py-2.5 font-ui text-[14px] font-medium text-ink-7 hover:bg-surface-16"
            data-testid="meritum-share-native"
          >
            {COPY.nativeShare}
          </button>
        ) : null}
      </div>
    </ModalShell>
  );
};

export default ShareSheet;
