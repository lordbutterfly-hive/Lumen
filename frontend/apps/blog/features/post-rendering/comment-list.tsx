'use client';

import CommentListItem from '@/blog/features/post-rendering/comment-list-item';
import { Entry, IFollowList } from '@hive/common-hiveio-packages/wax';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { sanitizeHash } from '@ui/lib/sanitize-url';
import { useLiteOverlay } from '@/blog/lib/lite/client/use-lite-overlay';

/**
 * ThreadLine component for Reddit-style visual thread indicators
 * Shows a vertical line with a curved connector to parent comment
 *
 * ★ THIS IS THE ONLY SOURCE OF PER-DEPTH INDENT (fixed 2026-08-11, F2 item 6/10).
 * It used to be ONE of two: this 24px box, plus a 52px avatar
 * (`mr-3` + `w-[40px]`) that CommentListItem rendered again at every level,
 * compounding to 76px/level — measured on the live POB post via
 * getBoundingClientRect(): depth-1 card x=311.5, depth-2 x=387.5, depth-3
 * x=463.5, each exactly +76.0px, unbounded, eating the row's own width until
 * the action row had nowhere to go but clip (item 9). The avatar now renders
 * once, inside the card header, for every depth — see CommentListItem — so
 * this 20px box (`w-4` + `mr-1`) is the single, capped source of indent.
 */
const ThreadLine = ({ isLast }: { isLast: boolean }) => (
  <div className="group/thread relative mr-1 w-4 flex-shrink-0">
    {/* Vertical line from top to curve junction - connects to parent's line above */}
    <div
      className={clsx(
        'absolute left-0 top-0 h-3 w-0',
        'border-l-2',
        'border-thread-line',
        'transition-colors duration-150'
      )}
    />
    {/* Curved connector - branches off to the comment */}
    <div
      className={clsx(
        'absolute left-0 top-3 h-3 w-3',
        'rounded-bl-lg border-b-2 border-l-2',
        'border-thread-line',
        'transition-colors duration-150'
      )}
    />
    {/* Vertical line extending down for siblings below */}
    {!isLast && (
      <div
        className={clsx(
          'absolute bottom-0 left-0 top-3 w-0',
          'border-l-2',
          'border-thread-line',
          'transition-colors duration-150'
        )}
      />
    )}
  </div>
);

// ★ item 10: cap the visual nesting so indent cannot run away. Beyond this
// many levels, stop adding ThreadLine/margin (every deeper reply renders
// flush with the depth-MAX_VISUAL_DEPTH level instead of pushing further
// right) and label the card with who it is replying to instead, since the
// connector line beyond this point no longer conveys that. The recursion and
// the underlying <ul><ul> DOM nesting are unchanged — only the visual indent
// is capped — so existing structural selectors keep working.
const MAX_VISUAL_DEPTH = 4;

const CommentList = ({
  highestAuthor,
  highestPermlink,
  permissionToMute,
  data,
  parent,
  parent_depth,
  mutedList,
  flagText,
  discussionAuthor,
  discussionPermlink,
  observer,
  filteringEnabled = true
}: {
  highestAuthor: string;
  highestPermlink: string;
  permissionToMute: Boolean;
  data?: Entry[];
  parent: Entry;
  parent_depth: number;
  mutedList: IFollowList[];
  flagText: string | undefined;
  discussionAuthor: string;
  discussionPermlink: string;
  observer: string;
  filteringEnabled?: boolean;
}) => {
  const [markedHash, setMarkedHash] = useState<string>('');

  // ★ item 2 (adversarial review): every `comment` in `arr` below is, by
  // construction (see the filter in `arr`'s useMemo), a direct reply to
  // `parent` — so `parent`'s own lite overlay IS the "replying to" identity
  // for the whole list, resolved once per CommentList instance rather than
  // once per comment. Same derivation CommentListItem uses for the comment's
  // own byline (`displayAuthor = liteOverlay?.author ?? comment.author`),
  // applied to the parent instead of inventing a new lookup. `parent` here is
  // always a full server-attached Entry (see attachLiteIdentitiesToDiscussion
  // in page.tsx), so this resolves from the SSR-embedded `_lite` with no
  // extra round trip in the common case.
  const parentLiteOverlay = useLiteOverlay(parent);
  const parentDisplayAuthor = parentLiteOverlay?.author ?? parent?.author;

  useEffect(() => {
    if (typeof window !== 'undefined') {
      // Security: Sanitize hash to prevent potential injection
      const hash = sanitizeHash(window.location.hash);
      if (hash) {
        setMarkedHash(hash);
      }
    }
  }, []);

  const arr = useMemo(() => {
    if (!data || !parent) return undefined;
    const filtered = data.filter(
      (x) => x?.parent_author === parent?.author && x?.parent_permlink === parent?.permlink
    );

    const mutedContent = filtered.filter(
      (item) => parent && item.depth === 1 && item.parent_author === parent.author
    );
    const unmutedContent = filtered.filter((md) => mutedContent.every((fd) => fd.post_id !== md.post_id));
    return [...mutedContent, ...unmutedContent];
  }, [data, parent?.author, parent?.permlink]);
  return (
    <ul data-testid="comment-list" className="w-full min-w-0 overflow-hidden">
      <>
        {!!arr
          ? arr.map((comment: Entry, index: number) => {
              const localDepth = comment.depth - parent_depth;
              const beyondCap = localDepth > MAX_VISUAL_DEPTH;
              // ★ item 1 (adversarial review): `post_id` is typed as a required
              // `number` on Entry but the Hive bridge API never actually sends it
              // (measured: 0 of 125 entries on a real discussion carry the field) —
              // so every key below built from it collapsed to `-index-${index}`,
              // effectively an index key. Author+permlink is Hive's real identity
              // for a comment and is always present; keying on it means local
              // per-comment state (hiddenComment, openState, reply/edit toggles)
              // stays attached to the right comment across a sort change or an
              // optimistic insert at the head, instead of following position.
              const commentKey = `${comment.author}/${comment.permlink}`;
              return (
                <div
                  key={`parent-${commentKey}`}
                  className={clsx('flex min-w-0', {
                    'my-2 rounded border-2 border-red-600 bg-green-50 p-2':
                      markedHash?.includes(`@${comment.author}/${comment.permlink}`) && comment.depth < 8
                  })}
                >
                  {/* Thread line connector for nested comments (only show for replies to comments,
                    not top-level, and only up to MAX_VISUAL_DEPTH — see the constant above) */}
                  {parent.depth >= 1 && !beyondCap && <ThreadLine isLast={index === arr.length - 1} />}
                  <div className="min-w-0 flex-1">
                    <CommentListItem
                      parentPermlink={highestPermlink}
                      parentAuthor={highestAuthor}
                      permissionToMute={permissionToMute}
                      comment={comment}
                      key={`${commentKey}-item`}
                      parent_depth={parent_depth}
                      mutedList={mutedList}
                      flagText={flagText}
                      discussionAuthor={discussionAuthor}
                      discussionPermlink={discussionPermlink}
                      observer={observer}
                      filteringEnabled={filteringEnabled}
                      onCommnentLinkClick={(hash) => setMarkedHash(hash)}
                      replyingToAuthor={beyondCap ? parentDisplayAuthor : undefined}
                    >
                      <CommentList
                        flagText={flagText}
                        highestAuthor={highestAuthor}
                        highestPermlink={highestPermlink}
                        permissionToMute={permissionToMute}
                        mutedList={mutedList}
                        data={data}
                        parent={comment}
                        key={`${commentKey}-list`}
                        parent_depth={parent_depth}
                        discussionAuthor={discussionAuthor}
                        discussionPermlink={discussionPermlink}
                        observer={observer}
                        filteringEnabled={filteringEnabled}
                      />
                    </CommentListItem>
                  </div>
                </div>
              );
            })
          : null}
      </>
    </ul>
  );
};
export default CommentList;
