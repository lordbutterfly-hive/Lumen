'use client';

import { useMemo, useState } from 'react';
import type { Entry } from '@hive/common-hiveio-packages/wax';
import { UserAvatarImg } from '@hive/ui';
import TimeAgo from '@ui/components/time-ago';
import { getUserAvatarUrl } from '@ui/lib/avatar-utils';
import { getPostSummary } from '@/blog/lib/utils';
import { isNotePost } from '@/blog/lib/short-post-note';
import { find_first_img } from './post-img';

/**
 * The post being reblogged, as a small version of its feed card (byline, title,
 * two lines of text, thumbnail), for the reblog popup. Same helpers as the feed card
 * (`medium-post-card.tsx`) so the two can never disagree about the image or excerpt.
 */
export function MiniPostCard({ entry, title, displayAuthor }: { entry?: Entry; title: string; displayAuthor: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  const note = isNotePost(entry?.json_metadata);
  const excerpt = useMemo(() => (entry ? getPostSummary(entry.json_metadata, entry.body) : ''), [entry]);
  const thumbnail = useMemo(() => {
    if (!entry) return '';
    const image = find_first_img(entry);
    return image && image !== getUserAvatarUrl(displayAuthor, 'large') ? image : '';
  }, [entry, displayAuthor]);

  return (
    <div className="flex gap-3 rounded-card border border-line-9 bg-surface-1 p-3.5" data-testid="reblog-mini-card">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-ui text-[13px] leading-[18px] text-ink-14">
          <UserAvatarImg
            username={displayAuthor}
            src={entry?._lite?.avatarUrl}
            pixelSize={20}
            radiusClassName="rounded-full"
            className="shrink-0"
          />
          <span className="truncate font-medium text-ink-2">{displayAuthor}</span>
          {entry?.created ? (
            <span className="shrink-0">
              · <TimeAgo date={entry.created} />
            </span>
          ) : null}
        </div>
        {note ? (
          <p className="mt-1.5 line-clamp-3 font-lora text-[15px] leading-[23px] text-ink-4">{excerpt || title}</p>
        ) : (
          <>
            <p className="mt-1.5 line-clamp-2 font-ui text-[15px] font-semibold leading-[21px] text-ink-2">{title || 'Untitled'}</p>
            {excerpt ? <p className="mt-1 line-clamp-2 font-lora text-[14px] leading-[21px] text-ink-action">{excerpt}</p> : null}
          </>
        )}
      </div>
      {thumbnail && !imageFailed ? (
        <img
          src={thumbnail}
          alt=""
          width={72}
          height={72}
          loading="lazy"
          onError={() => setImageFailed(true)}
          className="h-[72px] w-[72px] shrink-0 rounded-control object-cover"
        />
      ) : null}
    </div>
  );
}
