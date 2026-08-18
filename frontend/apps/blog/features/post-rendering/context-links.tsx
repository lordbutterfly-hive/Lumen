import { useTranslation } from '@/blog/i18n/client';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { Link } from '@hive/ui';

/**
 * Type guard for the `root_title` Hivemind actually sends but the shared
 * `Entry` type never declared. See the `rootTitle` doc comment below for why
 * this reads defensively instead of widening that type.
 */
function hasRootTitle(entry: Entry): entry is Entry & { root_title: string } {
  const raw = (entry as unknown as { root_title?: unknown }).root_title;
  return typeof raw === 'string' && raw.length > 0;
}

/**
 * ★ ONLY EVER A GENUINE HIVE COMMENT REACHES THIS COMPONENT (2026-08-16, QA
 * defect B1). `content.tsx` gates this behind `commentSite`, which now excludes
 * a Lumen-native post (`isLumenNativePost`, see that file) — a Lumen post is a
 * depth-1 chain comment by construction (published under the gateway account's
 * rolling container, see `lib/lite/publisher/container.ts`), but to a Lumen
 * reader it IS the post, and this banner's "View the full context" link
 * previously sent them straight to `/lumen/@hbd-temp/lumen-c-...` — the shared
 * gateway account and container. There is no second check for that here on
 * purpose: this component has exactly one caller, and duplicating the gate
 * would just be a second place for the two to drift apart. If a second caller
 * is ever added, it must apply the same gate before reaching for this.
 */
const ContentLinks = ({ data, noContext }: { data: Entry; noContext: boolean }) => {
  const { t } = useTranslation('common_blog');

  /**
   * ★ root_title, NOT title (2026-08-16, QA defect B1 item 2). Hivemind's
   * bridge API (`get_discussion` / `get_content`) returns `root_title` on every
   * entry in a thread — the title of the THREAD ROOT — distinct from `title`,
   * which is this entry's own and is routinely empty on an ordinary depth>0
   * Hive comment. This banner read `data.title` instead, so it named the
   * comment's own (usually blank) title as the thing "the full context" leads
   * back to — condenser-era code used `root_title` for exactly this reason.
   * `root_title` was never added to the shared `Entry` type (a different
   * team's file — `packages/common-hiveio-packages`), so this reads it
   * defensively rather than widen that type; falls back to `title` if a caller
   * ever hands in an entry that genuinely lacks it, which is the byte-identical
   * pre-fix behaviour rather than a blank heading.
   */
  const rootTitle = hasRootTitle(data) ? data.root_title : data.title;

  return (
    // ★ NEUTRAL SURFACE, NOT SUCCESS GREEN (2026-08-16, QA defect B1 cosmetic).
    // `bg-card-noContent` is `hsl(102, 50%, 96%)` — pale green — paired with
    // `border-card-emptyBorder`; both are the "empty state" pair from
    // elsewhere in the app, not a colour anyone chose for THIS banner, which is
    // a neutral "here is where you are" notice, not a success/confirmation
    // state. `border-line-18` / `bg-surface-14` is the neutral notice-card
    // pairing this same feature directory already uses for an equivalent
    // "informational aside" card (see `comment-list-item.tsx`'s
    // `comment-moderation-unknown` block).
    <div className="flex flex-col gap-2 rounded-card border border-line-18 bg-surface-14 p-2">
      <h4 className="text-sm text-ink-10">
        {t('post_content.if_comment.you_are_viewing_a_single_comments_thread_from')}:
      </h4>
      <h1 data-testid="article-title" className="text-2xl">
        {rootTitle}
      </h1>
      {/* ★ NO STRAY BULLET (2026-08-16, QA defect B1 cosmetic). These were
          literal "• " characters standing in for list markup on two links that
          are not a list. Removed from both, not just the one QA measured —
          leaving one bulleted and one not would have been its own
          inconsistency. */}
      <Link
        className="text-sm hover:text-destructive"
        href={`${data.url}`}
        data-testid="view-the-full-context"
      >
        {t('post_content.if_comment.view_the_full_context')}
      </Link>
      {noContext ? (
        <Link
          className="text-sm hover:text-destructive"
          href={`/${data.category}/@${data.parent_author}/${data.parent_permlink}`}
          data-testid="view-the-direct-parent"
        >
          {t('post_content.if_comment.view_the_direct_parent')}
        </Link>
      ) : null}
    </div>
  );
};

export default ContentLinks;
