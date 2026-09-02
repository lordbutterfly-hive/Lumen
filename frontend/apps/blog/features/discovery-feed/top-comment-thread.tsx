'use client';

import clsx from 'clsx';
import { Link, UserAvatarImg } from '@hive/ui';
import TimeAgo from '@ui/components/time-ago';
import RendererContainer from '@/blog/features/post-rendering/rendererContainer';
import VotesComponentWrapper from '@/blog/features/votes/votes-component-wrapper';
import { useLiteOverlay } from '@/blog/lib/lite/client/use-lite-overlay';
import { useTranslation } from '@/blog/i18n/client';
import { MAX_VISUAL_DEPTH, type DerivedThread, type ThreadNode } from './lib/top-comment-thread';
import styles from './post-card.module.css';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TOP COMMENT'S FULL REPLY THREAD, RENDERED BENEATH IT IN THE CARD DRAWER.
 * Built to `LUMEN-DOCS/TOP-COMMENT-THREAD-EXPAND-SPEC-2026-09-02.md` §2.3 (Option
 * B — the lean renderer) and §2.4.
 *
 * ★★★ THIS IS PURELY ADDITIVE. The top comment's own `.cbox` (its clamp, vote and
 * two counts) is untouched; this section is a SIBLING of it inside `.drawerInner`,
 * never a child — the top comment's stretched `.cboxLink` anchor would otherwise
 * swallow every reply click (§2.4 placement).
 *
 * ★★ OPTION B: REUSE THE PROVEN LEAF PIECES, NOT THE HEAVY `CommentListItem`.
 * Each reply composes only the components that carry real shipped guards:
 *   • `RendererContainer` — the FULL, unclamped markdown body. This is the entire
 *     no-clip mechanism for reply bodies (the post page uses the same at
 *     `comment-list-item.tsx:979`). No line-clamp, no max-height (see the CSS).
 *   • `VotesComponentWrapper size="quote"` — the SAME control the top comment's
 *     vote already mounts (`top-comment-drawer.tsx:320`), so replies inherit the
 *     lite-vs-Hive tier split and every auth guard rather than a hand-rolled vote.
 *   • `useLiteOverlay(entry)` — the reply byline shows a lite author's Lumen
 *     identity (`_lite` is attached server-side by `/api/discussion`).
 *   • `UserAvatarImg` + `TimeAgo` — the meta row, matching the top comment's.
 *   • `ThreadLine` + `MAX_VISUAL_DEPTH` — MIRRORED from `comment-list.tsx` (see
 *     below and the helper) so deep nesting behaves like the post page.
 *
 * DELIBERATELY OMITTED for the feed (all one click away on the post page via the
 * top comment's own link): the reply composer, the moderation dropdown, the
 * downvote weight slider and the per-reply collapse Accordion. Keeps the busiest
 * screen in the product light (§2.3).
 * ═══════════════════════════════════════════════════════════════════════════
 */

// Per-level indent, in px. The post page's single indent source is a 20px box
// (`comment-list.tsx:14-22`: `w-4` 16px + `mr-1` 4px); this matches it.
const INDENT_STEP = 20;

/**
 * Mirror of `comment-list.tsx:24-56`'s `ThreadLine` — the vertical rule + curved
 * connector for a nested reply. Mirrored (not imported) because it is a
 * module-local const there; the spec permits mirror-with-citation (§2.3). Uses
 * the same `border-thread-line` theme colour so the two cannot drift.
 */
const ThreadLine = ({ isLast }: { isLast: boolean }) => (
  <div className="relative mr-1 w-4 flex-shrink-0" aria-hidden="true">
    <div className="absolute left-0 top-0 h-3 w-0 border-l-2 border-thread-line" />
    <div className="absolute left-0 top-3 h-3 w-3 rounded-bl-lg border-b-2 border-l-2 border-thread-line" />
    {!isLast && <div className="absolute bottom-0 left-0 top-3 w-0 border-l-2 border-thread-line" />}
  </div>
);

/**
 * One reply. A child component so `useLiteOverlay` is a valid hook call (it cannot
 * run inside the parent's `.map`). Resolves the byline exactly as
 * `comment-list-item.tsx:264-265` does: `liteOverlay?.author ?? comment.author`.
 */
function TopCommentReply({ node }: { node: ThreadNode }) {
  const { t } = useTranslation('common_blog');
  const entry = node.entry;
  const liteOverlay = useLiteOverlay(entry);
  const displayAuthor = liteOverlay?.author ?? entry.author;

  return (
    <div className={styles.replyInner} data-testid="post-card-thread-reply" data-comment-key={node.key}>
      <div className={styles.replyMeta}>
        <span className="flex shrink-0" aria-hidden="true">
          <UserAvatarImg username={displayAuthor} pixelSize={20} alt="" />
        </span>
        <span className={styles.replyAuthor}>{displayAuthor}</span>
        <span className={styles.commentSep} aria-hidden="true">
          ·
        </span>
        <span className={styles.replyTime}>
          <TimeAgo date={entry.created} />
        </span>
        {/* ★ Beyond MAX_VISUAL_DEPTH the indent stops, so this is the only thing
            left that says who a flattened reply answers (mirrors
            `comment-list-item.tsx:772-777`). Reuses the shipped `replying_to`
            string. */}
        {node.replyingToAuthor && (
          <span className={styles.replyingTo} data-testid="thread-replying-to">
            {t('cards.comment_card.replying_to', { author: node.replyingToAuthor })}
          </span>
        )}
      </div>
      {/* FULL body — no clamp, no max-height (the drawer's JS height measure sizes
          the drawer to fit, §2.4). This is the no-clip requirement, satisfied by
          reusing the post page's own renderer. */}
      <div className={styles.replyBody}>
        <RendererContainer
          body={entry.body}
          author={entry.author}
          permlink={entry.permlink}
          className={styles.replyBodyProse}
          dataTestid="post-card-thread-reply-body"
        />
      </div>
      {/* ★ `stopPropagation` on click and keydown, exactly as the top comment's
          vote does (`top-comment-drawer.tsx:313-318`). Clicks inside the drawer
          already never toggle the card (`medium-post-card.tsx:405-434` returns
          early for `[data-testid="post-card-drawer"]`), so this is belt-and-
          braces against a future card-level handler, matching the top vote. */}
      <div
        className={styles.replyActions}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
        }}
      >
        <VotesComponentWrapper post={entry} type="comment" size="quote" />
      </div>
    </div>
  );
}

export default function TopCommentThread({
  thread,
  viewAllHref
}: {
  thread: DerivedThread;
  /** The post URL + the top comment fragment, for the "view all" link (§3.5). */
  viewAllHref: string;
}) {
  const { t } = useTranslation('common_blog');
  if (thread.nodes.length === 0) return null;

  return (
    <div className={styles.thread} data-testid="post-card-thread">
      {thread.nodes.map((node) => {
        // Indent capped at MAX_VISUAL_DEPTH (depth 1 = a direct reply => 0 indent).
        const cappedDepth = Math.min(node.depth, MAX_VISUAL_DEPTH);
        const indent = (cappedDepth - 1) * INDENT_STEP;
        return (
          <div
            key={node.key}
            className={clsx('flex min-w-0 items-start', styles.threadRow)}
            style={indent ? { marginLeft: `${indent}px` } : undefined}
          >
            <ThreadLine isLast={node.isLast} />
            <div className={styles.threadReply}>
              <TopCommentReply node={node} />
            </div>
          </div>
        );
      })}
      {thread.truncated && (
        <Link
          href={viewAllHref}
          scroll={false}
          className={styles.viewAll}
          data-testid="post-card-thread-view-all"
        >
          {t('discovery_feed.top_comment_thread.view_all_replies', { count: thread.total })}
        </Link>
      )}
    </div>
  );
}
