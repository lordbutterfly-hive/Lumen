'use client';

import type { Entry } from '@hive/common-hiveio-packages/wax';
import { useLiteOverlay } from '@/blog/lib/lite/client/use-lite-overlay';
import { find_first_img } from '../list-of-posts/post-img';
import { Link } from '@hive/ui';
import { proxifyImageSrc } from '@ui/lib/proxify-images';
import { useState } from 'react';
import { getDefaultImageUrl } from '@hive/ui';
import type { SuggestionsVariant } from './list';

interface SuggestionsCardProps {
  entry: Entry;
  variant?: SuggestionsVariant;
}

const SuggestionsCard = ({ entry, variant = 'rail' }: SuggestionsCardProps) => {
  const cardImage = find_first_img(entry);
  const [image, setImage] = useState<string>(cardImage);
  // A Lumen proxy post reaches this card authored by the shared publishing account,
  // and its title comes back from Hivemind as "RE: <container title>" because every
  // lite post is a comment on chain. No-op for ordinary Hive posts.
  const liteOverlay = useLiteOverlay(entry);
  const displayAuthor = liteOverlay?.author ?? entry.author;
  const displayTitle = liteOverlay?.title || entry.title;
  const href = `/${entry.category}/@${displayAuthor}/${entry.permlink}`;

  if (variant === 'horizontal') {
    return (
      <div className="w-44 flex-shrink-0 snap-start overflow-hidden rounded-lg bg-background shadow-md">
        <Link href={href}>
          {image ? (
            <div className="h-24 overflow-hidden bg-transparent">
              <img
                src={proxifyImageSrc(image, 256, 512)}
                alt="Post image"
                loading="lazy"
                className="h-full w-full object-cover"
                onError={() => setImage(getDefaultImageUrl())}
              />
            </div>
          ) : (
            <div className="flex h-24 items-center justify-center bg-background-secondary text-caption text-muted-foreground">
              No image
            </div>
          )}
          <div className="p-2">
            <h2 className="line-clamp-2 font-text text-caption font-semibold">{displayTitle}</h2>
            <p className="mt-1 truncate text-caption text-muted-foreground">@{displayAuthor}</p>
          </div>
        </Link>
      </div>
    );
  }

  /**
   * ★ THE RAIL ROW (2026-08-13, audit §6.3.4).
   *
   * The rail used to stack the same shadowed image cards the strip uses: 186px
   * tall each, measured. Ten of them is the 1,976px that forced the panel to
   * grow an inner scroller. A 40px thumbnail with a two-line title is ~66px, so
   * a capped list of five fits the pinned column beside the existing rail cards
   * with nothing below the fold — no scroller, no max-height, no clipping.
   *
   * The title is a real `<a>`, and the author is a SECOND `<a>` to the author's
   * profile rather than a third copy of the post link, so the row offers the two
   * destinations a reader actually wants from it.
   */
  return (
    <div className="border-b border-line-4 py-2.5 last:border-b-0 last:pb-0">
      <div className="flex gap-3">
        <Link href={href} tabIndex={-1} aria-hidden className="shrink-0" data-testid="post-image">
          {image ? (
            <img
              src={proxifyImageSrc(image, 128, 128)}
              alt=""
              loading="lazy"
              className="h-10 w-10 rounded-control object-cover ring-1 ring-inset ring-line-9"
              onError={() => setImage(getDefaultImageUrl())}
            />
          ) : (
            <span className="block h-10 w-10 rounded-control bg-surface-23 ring-1 ring-inset ring-line-9" />
          )}
        </Link>
        <div className="flex min-w-0 flex-1 flex-col">
          <Link
            href={href}
            className="line-clamp-2 font-text text-caption font-semibold text-ink-2 hover:underline"
          >
            {displayTitle}
          </Link>
          <Link
            href={`/@${displayAuthor}`}
            className="mt-0.5 truncate font-sans text-caption text-ink-10 hover:text-ink-brand-6"
          >
            @{displayAuthor}
          </Link>
        </div>
      </div>
    </div>
  );
};
export default SuggestionsCard;
