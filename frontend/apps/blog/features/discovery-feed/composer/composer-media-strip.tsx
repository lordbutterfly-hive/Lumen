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
 * `pl-[56px]` lines the strip up with the textarea rather than the avatar, the
 * same 56px the footer already uses, so the card has one left edge for
 * everything the reader typed or attached.
 *
 * The pending tile is a real tile, not a spinner somewhere else: an upload that
 * takes six seconds on a phone has to occupy the space its image will occupy, or
 * the toolbar jumps under the reader's finger when it lands.
 */
export default function ComposerMediaStrip({
  media,
  pendingCount,
  removeLabel,
  onRemove
}: {
  media: ComposerMedia[];
  pendingCount: number;
  removeLabel: string;
  onRemove: (url: string) => void;
}) {
  if (media.length === 0 && pendingCount === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2 pl-[56px]" data-testid="short-form-composer-media">
      {media.map((item) => (
        <div
          key={item.url}
          className="relative h-[84px] w-[84px] overflow-hidden rounded-[10px] border border-[#ebebeb] bg-[#f4f5f7]"
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
            data-testid="short-form-composer-media-remove"
            className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <Icons.x className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ))}
      {Array.from({ length: pendingCount }).map((_, index) => (
        <div
          key={`pending-${index}`}
          className="relative flex h-[84px] w-[84px] items-center justify-center overflow-hidden rounded-[10px] border border-dashed border-[#ebebeb] bg-white/70"
          data-testid="short-form-composer-media-pending"
        >
          <CircleSpinner size={20} color="#6b7280" loading />
        </div>
      ))}
    </div>
  );
}
