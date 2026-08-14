import type { Metadata } from 'next';
import { Link } from '@hive/ui';
import LeftRail from '@/blog/features/layouts/left-rail';

export const metadata: Metadata = {
  title: 'Page not found'
};

// TODO i18n — staged copy, same precedent as app-header's LABELS.
const COPY = {
  code: '404',
  title: 'That page is not here',
  body: 'The link may be wrong, or the page may have been moved or deleted. Both ways back are below.',
  home: 'Go to the home feed',
  communities: 'Browse communities'
};

const PRIMARY =
  'inline-flex h-10 items-center justify-center rounded-[14px] bg-surface-brand-12 px-5 font-sans text-[14px] leading-[22px] font-semibold text-ink-27 transition-colors hover:bg-surface-brand-15';
const SECONDARY =
  'inline-flex h-10 items-center justify-center rounded-[14px] border border-line-11 px-5 font-sans text-[14px] leading-[22px] font-semibold text-ink-7 transition-colors hover:bg-surface-16';

/**
 * ★★★ THE 404 WAS THE ONE PAGE NOT BUILT IN THIS PRODUCT (2026-08-10).
 *
 * Every wrong link, every deleted post and every auth-gated route reached while
 * signed out landed on the stock template: `text-6xl` in the default sans over
 * `text-muted-foreground`, a shadcn `bg-primary` button, and no left rail. It
 * read as a framework error page rather than as Lumen, and it was a dead end in
 * the literal sense: the only navigation on screen was the header, so the way
 * back to Wallet, Creators, Witnesses, Proposals or Settings was the browser
 * button.
 *
 * Same two-column shell as `/ranks` (nav + content, no right rail), Lora for the
 * headline, Open Sans for everything else, the brand red for the primary action.
 */
export default function NotFound() {
  return (
    <div
      className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11"
      data-testid="not-found-page"
    >
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-surface-26 md:block"
        aria-hidden
      />

      <aside className="sticky top-24 hidden h-fit bg-background-secondary md:block">
        <LeftRail />
      </aside>

      <main className="min-w-0 pt-6">
        <p className="font-sans text-[12px] font-bold uppercase tracking-[0.14em] text-ink-brand-6">
          {COPY.code}
        </p>
        <h1 className="mt-3 max-w-[16ch] font-serif text-[34px] font-bold leading-[44px] text-ink-2">
          {COPY.title}
        </h1>
        <p className="mt-4 max-w-[46ch] font-serif text-[15px] leading-[26px] text-ink-10">
          {COPY.body}
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Link href="/" className={PRIMARY}>
            {COPY.home}
          </Link>
          <Link href="/communities" className={SECONDARY}>
            {COPY.communities}
          </Link>
        </div>
      </main>
    </div>
  );
}
