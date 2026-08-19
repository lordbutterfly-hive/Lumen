import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@ui/components/dialog';
import { ReactNode } from 'react';
import { Link } from '@hive/ui';
import ClipboardCopy from './copy-from-input';
import { Icons } from '@ui/components/icons';
import { useTranslation } from '@/blog/i18n/client';
import { blogUrl } from '@hive/ui/config/public-vars';
import FacebookShare from './share-post-facebook';
import LinkedInShare from './share-post-linkedin';
import RedditShare from './share-post-reddit';
import TwitterShare from './share-post-twitter';

/**
 * ════ SHARE ════
 *
 * ★★★ REBUILT OUT OF THE hive.blog IDIOM (owner, 2026-08-18: "the post card needs
 * updating. its still on old hiveblog design" -> "all of it").
 *
 * What this was: a `text-3xl` heading over a `border-b-2`, then two stacked copy fields,
 * then SIX external links rendered as literal `{'•'}` bullet characters in flex rows,
 * every one of them coloured `text-destructive` - raw Tailwind red-500, a colour that
 * appears nowhere in Lumen's palette. It read as a 2016 blog footer, and the four social
 * networks were not even in here: they lived as a separate bordered icon strip out on the
 * post's action row, which is the single most dated element on the page.
 *
 * ★ THE NETWORKS MOVED IN HERE RATHER THAN BEING DELETED. Collapsing the action row to
 * one Share control is the whole point of the redesign, but this dialog only offered
 * copy-link and copy-markdown - so removing the strip without moving its four buttons
 * would have quietly deleted the ability to share to Facebook, X, LinkedIn or Reddit.
 * Nothing about what a reader can DO changed here; only where they reach it.
 *
 * ★ THE EXTERNAL FRONTENDS ARE A GRID OF CHIPS, NOT A BULLET LIST. Six links that all do
 * the same kind of thing are a set, and a set reads as a set. They also stop being red:
 * red is Lumen's action colour, and "open this post on waivio" is not an action worth
 * shouting.
 */
export function SharePost({ children, path, title }: { children: ReactNode; path: string; title: string }) {
  const { t } = useTranslation('common_blog');

  /**
   * The other Hive frontends, and the block explorers. One shape for both, because to a
   * reader they are the same offer: "see this somewhere else".
   */
  const ALTERNATIVES = [
    { host: 'peakd.com', testId: 'share-dialog-peakd' },
    { host: 'ecency.com', testId: 'share-dialog-ecency' },
    { host: 'waivio.com', testId: 'share-dialog-waivio' }
  ];
  const EXPLORERS = [
    { host: 'hiveblocks.com' },
    { host: 'hive.ausbit.dev' },
    { host: 'hiveblockexplorer.com' }
  ];

  const chip =
    'flex items-center justify-between gap-2 rounded-control border border-line-9 px-3 py-2 font-sans text-caption text-ink-8 transition-colors hover:border-line-brand-10 hover:bg-surface-brand-5 hover:text-ink-brand-6';

  return (
    <Dialog>
      {/* ★ KEYBOARD-UNREACHABLE TRIGGER FIX (2026-08-13, O5 a11y build map item 2).
          Radix's `DialogTrigger` renders a real `<button type="button">` by
          default; `asChild` handed all of that to a bare `<div>` — not
          focusable, no role, no tabindex, measured live as unreachable by a
          40-press Tab walk. `title` is also a weak, hover-only accessible
          name (not announced consistently), so it becomes a real
          `aria-label` on the new button rather than just moving as-is. */}
      <DialogTrigger asChild>
        <button type="button" aria-label={t('post_content.footer.share_form.share_this_link')}>
          {children}
        </button>
      </DialogTrigger>

      <DialogContent className="flex flex-col gap-6 sm:max-w-[560px]" data-testid="share-post-dialog">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl font-semibold text-ink-2">
            {t('post_content.footer.share_form.share_this_link')}
          </DialogTitle>
        </DialogHeader>

        <div className="flex w-full flex-col gap-4">
          <ClipboardCopy
            copyText={blogUrl(path)}
            label={t('post_content.footer.share_form.url_to_this_post')}
            testId="share-dialog-copy-url"
          />
          <ClipboardCopy
            copyText={`[${title}](${blogUrl(path)})`}
            label={t('post_content.footer.share_form.markdown_code_for_a_link_to_this_post')}
            testId="share-dialog-copy-markdown"
          />
        </div>

        {/* The four networks, moved here from the action row's bordered icon strip. */}
        <div className="flex flex-col gap-2">
          <h3 className="font-sans text-label font-semibold uppercase tracking-wide text-ink-14">
            {t('post_content.footer.share_form.share_this_link')}
          </h3>
          <div
            className="flex items-center gap-1 rounded-control border border-line-9 px-2 py-1.5"
            data-testid="share-dialog-networks"
          >
            <FacebookShare url={path} />
            <TwitterShare title={title} url={path} />
            <LinkedInShare title={title} url={path} />
            <RedditShare title={title} url={path} />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="font-sans text-label font-semibold uppercase tracking-wide text-ink-14">
            {t('post_content.footer.share_form.open_in_alternative')}
          </h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {ALTERNATIVES.map((a) => (
              <Link
                key={a.host}
                target="_blank"
                href={`https://${a.host}${path}`}
                className={chip}
                data-testid={a.testId}
              >
                <span className="truncate">{a.host}</span>
                <Icons.forward className="h-3.5 w-3.5 shrink-0" />
              </Link>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="font-sans text-label font-semibold uppercase tracking-wide text-ink-14">
            {t('post_content.footer.share_form.open_in')}
          </h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {EXPLORERS.map((e) => (
              <Link key={e.host} target="_blank" href={`https://${e.host}${path}`} className={chip}>
                <span className="truncate">{e.host}</span>
                <Icons.forward className="h-3.5 w-3.5 shrink-0" />
              </Link>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
