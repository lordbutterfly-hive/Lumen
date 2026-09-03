'use client';

import { ReactNode } from 'react';
import { Smile } from 'lucide-react';
import { Icons } from '@ui/components/icons';
import { Button } from '@ui/components/button';
import { cn } from '@ui/lib/utils';
import ComposerAction from './composer-action';

const ICON_CLASS = 'h-5 w-5';

export interface ComposerFooterLabels {
  bold: string;
  italic: string;
  addImage: string;
  addEmoji: string;
  post: string;
  posting: string;
  cancel: string;
}

/**
 * The composer's footer, which is now a TOOLBAR (audit §9.2, finding 4 of §3).
 *
 * The footer already spanned the full 781px of the card with a 7px counter on
 * one side and a 74px button on the other — roughly 700px of nothing, in exactly
 * the place a toolbar belongs. The layout was already shaped for controls; the
 * controls were simply never built.
 *
 * Icon rules follow the long-form toolbar so the two editors match: the image
 * glyph is literally `Icons.imageIcon`, the same lucide `Image` the long-form
 * `toolbar-config.tsx` uses, at 20px with `currentColor` and no fill.
 */
export default function ComposerFooter({
  labels,
  testIdPrefix = 'short-form-composer',
  count,
  limit,
  overLimit,
  submitting,
  canSubmit,
  uploading,
  emojiOpen,
  onToggleBold,
  onToggleItalic,
  onOpenFilePicker,
  onToggleEmoji,
  onSubmit,
  onCancel,
  picker,
  preventPostMouseDown = false
}: {
  labels: ComposerFooterLabels;
  /** Prefix for every data-testid below (review F9). Default keeps the
      quick-post's existing ids byte-identical; the quick-reply passes its own
      so the two composers' controls stay distinguishable in the DOM. */
  testIdPrefix?: string;
  /** ★ When true, the Post button preventDefaults its mousedown so a mouse click
      does NOT move focus onto it (the same load-bearing line Cancel and every
      ComposerAction already carry, composer-action.tsx:37 / :124). The quick-reply
      passes this: clicking Post there would otherwise focus the button, and the
      instant `submitting` flips it `disabled` the browser blurs it to <body> — which
      the feed card reads as "focus left the card" and collapses the whole drawer
      the reader just posted into (owner issue, 2026-09-03; Fable review). Default
      false keeps the quick-post byte-identical (it has no drawer to collapse). */
  preventPostMouseDown?: boolean;
  count: number;
  limit: number;
  overLimit: boolean;
  submitting: boolean;
  canSubmit: boolean;
  uploading: boolean;
  emojiOpen: boolean;
  onToggleBold: () => void;
  onToggleItalic: () => void;
  onOpenFilePicker: () => void;
  onToggleEmoji: () => void;
  onSubmit: () => void;
  onCancel: () => void;
  /** The lazily-loaded emoji popover, anchored to this row. */
  picker: ReactNode;
}) {
  return (
    <div className="relative mt-3 flex items-center justify-between gap-3 border-t border-[#ebebeb] pt-3">
      <div className="flex items-center gap-1">
        {/* ★ Bold/italic, added at the FRONT of the cluster (owner ask,
            2026-08-28) — the toolbar previously had only image/emoji and empty
            space to their left. Same `Icons.*` house set and `ICON_CLASS` as
            every other button here, and the same house icons the long-form
            editor's toolbar uses for bold/italic (`toolbar-config.tsx`), so the
            two editors keep matching the way the comment above already
            requires for the image glyph. */}
        <ComposerAction
          label={labels.bold}
          onClick={onToggleBold}
          disabled={submitting}
          testId={`${testIdPrefix}-bold-button`}
        >
          <Icons.bold className={ICON_CLASS} aria-hidden="true" />
        </ComposerAction>
        <ComposerAction
          label={labels.italic}
          onClick={onToggleItalic}
          disabled={submitting}
          testId={`${testIdPrefix}-italic-button`}
        >
          <Icons.italic className={ICON_CLASS} aria-hidden="true" />
        </ComposerAction>
        <ComposerAction
          label={labels.addImage}
          onClick={onOpenFilePicker}
          disabled={submitting}
          testId={`${testIdPrefix}-image-button`}
        >
          <Icons.imageIcon className={ICON_CLASS} aria-hidden="true" />
        </ComposerAction>
        <ComposerAction
          label={labels.addEmoji}
          onClick={onToggleEmoji}
          disabled={submitting}
          active={emojiOpen}
          ariaExpanded={emojiOpen}
          testId={`${testIdPrefix}-emoji-button`}
        >
          <Smile className={ICON_CLASS} strokeWidth={1.75} aria-hidden="true" />
        </ComposerAction>
        {picker}
      </div>

      <div className="flex items-center gap-3">
        {submitting ? (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onCancel}
            data-testid={`${testIdPrefix}-cancel`}
            className="font-sans text-caption text-[#6b7280] underline-offset-2 hover:text-[#333] hover:underline"
          >
            {labels.cancel}
          </button>
        ) : null}
        {/* ★ `{count} / {limit}`, not a bare `0`. A raw integer with no limit,
            no "x of y" and no colour change communicates nothing — and its old
            `text-muted-foreground` resolved to slate rgb(100,116,139), the only
            cool-tinted token in an otherwise warm-neutral card. */}
        <span
          className={cn(
            'font-sans text-caption tabular-nums',
            // ★ `ink-brand-6`, not `#c0392b` (2026-08-14 token-migration pass):
            // brand INK role, matching how the rest of the app names a coloured
            // character count.
            overLimit ? 'font-semibold text-ink-brand-6' : count >= limit * 0.9 ? 'text-ink-brand-6' : 'text-[#6b7280]'
          )}
          data-testid={`${testIdPrefix}-counter`}
        >
          {count} / {limit}
        </span>
        <Button
          type="button"
          variant="default"
          size="sm"
          className="rounded-control bg-surface-brand-12 px-[22px] font-semibold text-white transition-colors hover:bg-surface-brand-16"
          disabled={!canSubmit || submitting || uploading || overLimit}
          onMouseDown={preventPostMouseDown ? (event) => event.preventDefault() : undefined}
          onClick={onSubmit}
          data-testid={`${testIdPrefix}-post`}
          aria-busy={submitting}
        >
          {submitting ? labels.posting : labels.post}
        </Button>
      </div>
    </div>
  );
}
