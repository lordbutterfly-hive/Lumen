'use client';

import LeftRail from '@/blog/features/layouts/left-rail';
import PageMasthead from '@/blog/features/layouts/page-masthead';
import PostForm from '@/blog/features/post-editor/post-form';
import PostingLoader from '@/blog/features/post-editor/posting-loader';
import { useTranslation } from '@/blog/i18n/client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useState } from 'react';

/**
 * ★★★ THE COMPOSER HAD NO PAGE (2026-08-10).
 *
 * Every other route in Lumen renders inside the same shell: the 200px nav
 * column, the content column, the 44px gutter rule, and one `PageMasthead` at
 * the top (see features/layouts/main-page-layout.tsx, app/ranks/page.tsx). This
 * one rendered a bare `px-4 py-8` div. Measured live before this change: the
 * form's bounding box started at x=16 and there were ZERO `<aside>` elements on
 * the page — no nav, no header, no column. Clicking the pencil dropped you out
 * of the product and into a form.
 *
 * Two columns, not three: the composer is a side-by-side editor and preview and
 * wants the whole content width, so it takes the same nav + content shell the
 * wallet and `/ranks` use rather than the three-column reading shell.
 *
 * ★ NO `mark` ON THE MASTHEAD. Per page-masthead.tsx, the watermark glyph is
 * assigned per page by a person; home is the pilcrow and topics is the hash, and
 * everything else — including this — has none until someone decides.
 */

const MASTHEAD_TITLE = 'Write a post';
const MASTHEAD_META = 'Saved as you type. Nothing goes out until you press Submit.';

const SubmitContent = () => {
  const { t } = useTranslation('common_blog');
  /**
   * ★ SAME BUG CLASS AS app-header.tsx ("NEVER SHOW A SIGNED-IN READER A
   * SIGNED-OUT HEADER", 2026-08-10, N-3). The raw client user object cannot
   * answer during SSR and is empty on the client until `/api/users/me`
   * returns (measured up to 4.6s on this box), so a signed-in author hitting
   * the composer saw "log in to post" for that whole window. `identity`
   * (which wraps `useUserClient` itself) prefers the client's real answer the
   * moment it has landed and falls back to the cookie the server already read
   * before then, so the very first paint is correct. `identity.username` is
   * used directly below rather than a separate `useUserClient()` call, since
   * it is guaranteed non-empty whenever `identity.isLoggedIn` is true.
   */
  const identity = useSessionIdentity();
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Draft is saved automatically by PostForm via useStorageWithTTL
  // and cleared only when:
  // 1. Post is successfully submitted (removePost() in onSubmit)
  // 2. User discards the draft and confirms (handleCancel)

  return (
    <>
      <div className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11">
        <div
          className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-surface-26 md:block"
          aria-hidden
        />

        <aside className="sticky top-24 hidden h-fit bg-background-secondary md:block">
          <LeftRail />
        </aside>

        <main className="min-w-0">
          <PageMasthead title={MASTHEAD_TITLE}>{MASTHEAD_META}</PageMasthead>

          {identity.isLoggedIn ? (
            <PostForm
              username={identity.username}
              editMode={false}
              sideBySidePreview={true}
              setIsSubmitting={setIsSubmitting}
            />
          ) : (
            <div
              className="rounded-[14px] border border-line-9 bg-surface-1 px-4 py-6 text-sm text-ink-10"
              data-testid="log-in-to-make-post-message"
            >
              {t('submit_page.log_in_to_post')}
            </div>
          )}
        </main>
      </div>
      <PostingLoader isSubmitting={isSubmitting} />
    </>
  );
};

export default SubmitContent;
