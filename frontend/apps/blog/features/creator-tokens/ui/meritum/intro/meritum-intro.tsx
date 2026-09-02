'use client';

import { Link } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import { MeritumTicker } from '../ticker/meritum-ticker';
import MeritumHoldersBand from './meritum-holders-band';
import styles from './meritum-intro.module.css';

/**
 * SCREEN 1 OF THE MERITUM ONBOARDING — the intro card.
 *
 * React port of `handoff_meritum_onboarding/reference/Intro.dc.html`, target
 * `visuals/01-intro.png`. A warm paper card that sits at the top of
 * `/creators`, ABOVE the discovery list, and hands off to `/creators/launch`.
 *
 * ★ THE ORDER IS FIXED AND LOAD-BEARING (README "Screen 1", checklist item 81).
 * Eyebrow, headline, TAPE, subhead, CTA, then the white band. The tape sits
 * directly under the headline and carries no box and no border — it is the
 * proof that lets the subhead and the CTA make a claim, so moving it below
 * them (the obvious "cleaner" arrangement) removes the reason to read on.
 *
 * ★ WHAT THIS FILE OWNS, AND WHAT IT MUST NOT.
 *   - the tape           → `../ticker/meritum-ticker`. It renders its own 13
 *                          owner-locked items AND its own LIVE badge behind
 *                          `showLive` (default on). Do not build a second one.
 *   - colour             → `meritum-*` utilities, picked by CSS PROPERTY, never
 *                          by hex. `bg-meritum-surface-brand` (a fill) and
 *                          `text-meritum-ink-brand` (ink) are both `#c0392b`
 *                          today and diverge under dark mode on purpose.
 *   - motion             → the shared `mt-rise` classes in
 *                          `packages/tailwindcss/globals.css`, which are also
 *                          where `prefers-reduced-motion` turns them off. No
 *                          keyframe is declared anywhere in this folder.
 *   - geometry           → `./meritum-intro.module.css`.
 *
 * ★ DARK MODE. Nothing here opts out of it. Every `--meritum-*` token is an
 * alias of a palette token that already has a `.dark` value, so the card
 * re-points with the theme instead of staying cream on a dark page — which is
 * the whole reason the palette work landed before this screen did.
 *
 * TWO DELIBERATE DEPARTURES FROM THE REFERENCE, both noted at their call site:
 * the eyebrow is `text-12` not 11px (the app's scale folded 11 -> 12), and the
 * headline steps down to the 44px scale step below `md` so a 68px word cannot
 * overflow a phone.
 */

/** The CTA's trailing arrow. Decorative — the label already says where it goes. */
function ArrowIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 12h15M13 6l6 6-6 6" />
    </svg>
  );
}

export default function MeritumIntro() {
  const { t } = useTranslation('common_blog');

  return (
    /*
     * ★ THE HERO WEARS LUMEN'S OWN MASTHEAD WASH, NOT THE HANDOFF'S CREAM SLAB.
     *
     * This was `bg-meritum-paper` (a flat #fbf7f2 off `--surface-warn-2`) with a
     * `--line-warn-1` border. Measured against the running app, that was the one
     * thing making this screen read as a different product: the flat cream was
     * the single largest painted surface here (760,272px, ~72% of the card), and
     * `--surface-warn-2` is used 4x app-wide while `--line-warn-1` is used 2x —
     * i.e. the screen's identity colour was one Lumen barely uses, taken off the
     * WARNING ramp. Every other `--meritum-*` alias points at a token used
     * 17-257x, so these two were the whole mismatch.
     *
     * Lumen already has a promotional-hero treatment and it is `PageMasthead`
     * (`features/layouts/page-masthead.tsx`): the `--masthead-1..4` radial wash
     * fading to near-white, a `--line-warn-3` edge and a 3px brand-red left
     * rule. Those exact tokens are reused here, so this card now speaks the
     * app's hero language and inherits its dark-mode mapping for free.
     *
     * `--meritum-paper` itself is deliberately NOT retired: as a small chip fill
     * the cream is the established creator-token accent (token-author-chip,
     * header-token-pill, profile-token-card all use `bg-surface-warn-2`). It was
     * only wrong as a full-bleed page surface.
     */
    <section
      className={`${styles.card} border border-line-warn-3 accent-rail bg-[radial-gradient(125%_130%_at_0%_0%,rgb(var(--masthead-1))_0%,rgb(var(--masthead-2))_30%,rgb(var(--masthead-3))_58%,rgb(var(--masthead-4))_85%)]`}
    >
      {/* `mt-rise` is the 620ms entrance, transform + opacity only, and it is
          on the CONTENT rather than the card so the card's own border does not
          slide with it. */}
      <div className="mt-rise px-6 pb-12 pt-14 sm:px-11 sm:pb-[62px] sm:pt-[74px]">
        {/* ★ `text-label` (12px), NOT the reference's 11px. The type scale
            deliberately folded 11 into 12 (see `packages/tailwindcss/tailwind.config.js`;
            the class was `text-12` until the 2026-08-19 ladder made `text-label`
            the named uppercase step at the same size),
            and the handoff's ground rule is that a value differing from an app
            token by a hair loses to the token. Weight, tracking and colour are
            the reference's. */}
        <p className="font-ui text-label font-medium uppercase tracking-meritum-eyebrow text-meritum-ink-brand">
          {t('meritum.intro.eyebrow')}
        </p>

        {/* ★ `text-44` BELOW `md`. `text-meritum-display` is 68px/68px, which is
            the reference and which this screen is built around — but the word
            "Meritum" alone is ~266px at that size, and the card has 48px of its
            own padding inside a 327px content column on a 375px phone. The
            headline would overflow its own card. 44 is the next real step on
            the scale, not a guess. */}
        <h1 className="mt-[18px] max-w-[16ch] text-pretty font-ui text-44 font-medium tracking-meritum-display text-meritum-ink md:text-meritum-display">
          {t('meritum.intro.headline')}
        </h1>

        {/* ★ THE TAPE, DIRECTLY UNDER THE HEADLINE. No box, no border, and no
            LIVE badge added here — `MeritumTicker` renders its own behind
            `showLive` (default on), so adding one would double it. The label
            goes through `t()` because the badge is chrome; the 13 items inside
            the tape are owner-locked verbatim copy and stay in the component.

            ★★★ THE BADGE SAYS "EXAMPLE", NOT "LIVE" (2026-08-23, P0 carried across
            three audit runs). The 13 items are FICTIONAL and fixed — @biggusdickus,
            @pontiuspilate, @naughtiusmaximus and their dollar figures are invented
            example copy, and the real Meritum data source returns nothing on this
            build. A `● LIVE` badge above them asserted that a reader was watching
            real creators earn real money in real time. That is not a wording nit; it
            is a fabricated activity feed, and it sat directly above a "Meritum isn't
            available on this build yet" notice one section down on the same screen.
            The items themselves are owner-locked verbatim and are NOT touched. The
            label is the one string here that is chrome rather than owner copy, and it
            is a prop precisely so it can tell the truth. */}
        <MeritumTicker className="mt-[30px]" liveLabel={t('meritum.intro.example')} />

        <p className="mt-6 max-w-[44ch] font-ui text-18 text-meritum-ink-3">{t('meritum.intro.subhead')}</p>

        {/* ★ THE REAL ROUTE, NOT A PLACEHOLDER. `/creators/launch` decides on
            the server whether the visitor is signed in and sends them to the
            login door with `?next=` if not, so this link is correct for a
            logged-out reader too — which is most of the audience for a page
            whose whole job is to explain what Meritum is.
            `h-16` is the reference's 64px.

            ★ `mt-cta` (the handoff's pulsing ring) REMOVED. It measured as a
            live `rgba(192,57,43,0.275) 0 0 0 4.65px` halo on this button, and
            nothing else in Lumen carries one: the app's primary calls to action
            — "Start free" on the home masthead, "Set up in Creator Studio" in
            this page's own right rail — are flat red pills. An animated ring
            unique to one button reads as a different design system, which is
            the whole reason this pass exists. Hover/focus keep the app's
            treatment. */}
        <Link
          href="/creators/launch"
          className="mt-[34px] inline-flex h-16 items-center gap-3 whitespace-nowrap rounded-card bg-meritum-surface-brand px-10 text-18 font-medium text-meritum-ink-on-brand font-ui hover:bg-meritum-surface-brand-hover"
        >
          {t('meritum.intro.cta')}
          <ArrowIcon />
        </Link>
      </div>

      <MeritumHoldersBand />
    </section>
  );
}
