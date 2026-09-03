'use client';

import { Icons } from '@ui/components/icons';
import { CircleSpinner } from 'react-spinners-kit';

export interface ComposerMedia {
  url: string;
  name: string;
}

/**
 * The attached-images row, between the textarea and the toolbar (audit §9.3).
 *
 * The strip lines up under the textarea rather than the avatar, via `indentClass`
 * (default `pl-[56px]` for the quick-post's 44px avatar + 12px gap; the compact
 * reply composer passes `pl-[48px]` for its 36px avatar). The footer itself is
 * full-width and carries no such indent.
 *
 * The pending tile is a real tile, not a spinner somewhere else: an upload that
 * takes six seconds on a phone has to occupy the space its image will occupy, or
 * the toolbar jumps under the reader's finger when it lands.
 */
export default function ComposerMediaStrip({
  media,
  pendingCount,
  removeLabel,
  onRemove,
  testIdPrefix = 'short-form-composer',
  indentClass = 'pl-[56px]'
}: {
  media: ComposerMedia[];
  pendingCount: number;
  removeLabel: string;
  onRemove: (url: string) => void;
  /** Prefix for the data-testids (review F9); default keeps the quick-post's ids. */
  testIdPrefix?: string;
  /** Left indent to line the strip up under the textarea; default is the
   *  quick-post's 56px (44px avatar + 12px gap). The compact reply composer
   *  (36px avatar) passes pl-[48px] so its strip stays aligned (owner 2026-09-03). */
  indentClass?: string;
}) {
  if (media.length === 0 && pendingCount === 0) return null;
  return (
    <div className={`mt-3 flex flex-wrap gap-2 ${indentClass}`} data-testid={`${testIdPrefix}-media`}>
      {media.map((item) => (
        <div
          key={item.url}
          className="relative h-[84px] w-[84px] overflow-hidden rounded-control border border-[#ebebeb] bg-[#f4f5f7]"
        >
          {/* Decorative: the note's own text is the label, and the remove button
              beside it carries the accessible name. */}
          <img src={item.url} alt="" className="h-full w-full object-cover" />
          <button
            type="button"
            aria-label={`${removeLabel}: ${item.name}`}
            title={removeLabel}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onRemove(item.url)}
            data-testid={`${testIdPrefix}-media-remove`}
            className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <Icons.x className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ))}
      {Array.from({ length: pendingCount }).map((_, index) => (
        <div
          key={`pending-${index}`}
          className="relative flex h-[84px] w-[84px] items-center justify-center overflow-hidden rounded-control border border-dashed border-[#ebebeb] bg-white/70"
          data-testid={`${testIdPrefix}-media-pending`}
        >
          <CircleSpinner size={20} color="#6b7280" loading />
        </div>
      ))}
    </div>
  );
}
