'use client';

import { ReactNode } from 'react';
import { Smile } from 'lucide-react';
import { Icons } from '@ui/components/icons';
import { Button } from '@ui/components/button';
import { cn } from '@ui/lib/utils';
import ComposerAction from './composer-action';

const ICON_CLASS = 'h-5 w-5';

export interface ComposerFooterLabels {
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
  count,
  limit,
  overLimit,
  submitting,
  canSubmit,
  uploading,
  emojiOpen,
  onOpenFilePicker,
  onToggleEmoji,
  onSubmit,
  onCancel,
  picker
}: {
  labels: ComposerFooterLabels;
  count: number;
  limit: number;
  overLimit: boolean;
  submitting: boolean;
  canSubmit: boolean;
  uploading: boolean;
  emojiOpen: boolean;
  onOpenFilePicker: () => void;
  onToggleEmoji: () => void;
  onSubmit: () => void;
  onCancel: () => void;
  /** The lazily-loaded emoji popover, anchored to this row. */
  picker: ReactNode;
}) {
  return (
    <div className="relative mt-3 flex items-center justify-between gap-3 border-t border-[#ebebeb] pl-[56px] pt-3">
      <div className="flex items-center gap-1">
        <ComposerAction
          label={labels.addImage}
          onClick={onOpenFilePicker}
          disabled={submitting}
          testId="short-form-composer-image-button"
        >
          <Icons.imageIcon className={ICON_CLASS} aria-hidden="true" />
        </ComposerAction>
        <ComposerAction
          label={labels.addEmoji}
          onClick={onToggleEmoji}
          disabled={submitting}
          active={emojiOpen}
          ariaExpanded={emojiOpen}
          testId="short-form-composer-emoji-button"
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
            data-testid="short-form-composer-cancel"
            className="font-sans text-[13px] text-[#6b7280] underline-offset-2 hover:text-[#333] hover:underline"
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
            'font-sans text-xs tabular-nums',
            // ★ `ink-brand-6`, not `#c0392b` (2026-08-14 token-migration pass):
            // brand INK role, matching how the rest of the app names a coloured
            // character count.
            overLimit ? 'font-semibold text-ink-brand-6' : count >= limit * 0.9 ? 'text-ink-brand-6' : 'text-[#6b7280]'
          )}
          data-testid="short-form-composer-counter"
        >
          {count} / {limit}
        </span>
        <Button
          type="button"
          variant="default"
          size="sm"
          className="rounded-control bg-surface-brand-12 px-[22px] font-semibold text-white transition-colors hover:bg-surface-brand-16"
          disabled={!canSubmit || submitting || uploading || overLimit}
          onClick={onSubmit}
          data-testid="short-form-composer-post"
          aria-busy={submitting}
        >
          {submitting ? labels.posting : labels.post}
        </Button>
      </div>
    </div>
  );
}
