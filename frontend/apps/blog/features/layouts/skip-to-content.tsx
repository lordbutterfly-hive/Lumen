'use client';

import { useTranslation } from '@/blog/i18n/client';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SKIP TO CONTENT
 *
 * The first tab stop on every page. A keyboard or screen-reader user landing
 * on any route otherwise has to tab through the whole header — wordmark,
 * search, every nav item, the notification bell, the composer, the user menu —
 * before reaching a single word of the article they came for, and again on the
 * next page, and the next. This app had no skip link at all (checked
 * 2026-08-21: no `skip`-anything in any component).
 *
 * ★ IT MUST BE VISIBLE WHEN FOCUSED, AND ONLY THEN. `sr-only` alone would
 * leave sighted keyboard users tabbing to a control they cannot see — which
 * is a WCAG 2.4.7 (focus visible) failure of its own, not a fix. The
 * `focus:not-sr-only` pair unsets every `sr-only` property (position, size,
 * clip, overflow) on focus, so the anchor has to re-declare its own box in the
 * same breath: without `focus:fixed` and coordinates it would appear at
 * whatever the un-clipped static position happens to be, which on a sticky
 * header is behind it.
 *
 * ★ EVERY VISUAL PROPERTY IS `focus:`-PREFIXED, INCLUDING THE PADDING. Written
 * unprefixed (`sr-only … px-4 py-2 …`) the padding still applies while the link
 * is hidden, because Tailwind resolves `sr-only`'s `padding: 0` against `px-4` by
 * CSS source order, not by the order they appear in `className` — measured
 * resting box: 34x18 instead of 1x1. It was not *visible* (`clip: rect(0,0,0,0)`
 * survives, and `elementFromPoint` at its centre returned the page grid, not the
 * link, so it was never a hidden click target either) but a hidden element with a
 * real box is one CSS change away from becoming one.
 *
 * ★ THE TARGET TAKES `tabIndex={-1}`. Moving the document's focus to an
 * element requires that element to be focusable; a plain `<div id=…>` is a
 * valid href target for SCROLLING but browsers will not move focus to it, so
 * the next Tab would continue from the skip link — back into the header, which
 * is exactly what the link exists to escape. `-1` makes it programmatically
 * focusable without adding a tab stop of its own.
 *
 * ★ TARGETS THE WRAPPER, NOT `<main>`. Every page shell renders its OWN
 * `<main>` (home-shell, page-shell, main-page-layout, profile-subpage-shell —
 * see the note in `app/layout.tsx`), so there is no single `<main>` to point
 * at. The wrapper `<div>` that holds `{children}` is the one node common to
 * all of them, and it sits immediately outside whichever `<main>` the route
 * renders, so focus lands one step before the content proper rather than
 * inside an arbitrary one.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const SkipToContent = () => {
  const { t } = useTranslation('common_blog');

  return (
    <a
      href="#main-content"
      data-testid="skip-to-content"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:border focus:border-border focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
    >
      {t('navigation.skip_to_content', { defaultValue: 'Skip to content' })}
    </a>
  );
};

export default SkipToContent;
