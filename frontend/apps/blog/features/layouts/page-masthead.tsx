import type { FC, ReactNode } from 'react';
import MastheadGlyph, { type MastheadMark } from './masthead-glyph';

/**
 * The one page masthead. Every route header in Lumen is this component.
 *
 * ★★★ WHY IT EXISTS (2026-08-10, fuckery list X-1 + W-4).
 *
 * There were FOUR page-header treatments live at once: home and topics each had
 * their own copy of the same shell (already drifting by radius, border colour and
 * h1 size before they were reconciled by hand), `/witnesses` had no shell at all
 * — bare text on the page background, measured at borderRadius 0, background
 * transparent, padding 0, in a container that was already exactly the hero width —
 * and proposals and creators had a third thing again. A house style that has to be
 * re-typed per route is not a house style, it is a coincidence that decays.
 *
 * So the shell lives here once and takes slots. A new page header is a call to this
 * component, never a new `<header className="rounded-[20px] border...">`.
 *
 * THE SHELL, and these numbers are the spec:
 *   width   inherited from the column, never hardcoded
 *   radius  20px
 *   border  1px #eee2dc, with a 3px `line-brand-10` rule down the left edge
 *   fill    the warm radial wash (owner ruling: the gradient stays)
 *   padding 28px 28px 20px
 *   overflow hidden, so an oversized mark bleeds off the corner instead of
 *           widening the card
 *
 * ★ THE MARK IS OPTIONAL AND UNASSIGNED BY DEFAULT (R5 / D-2). Home is the pilcrow,
 * topics is the hash, and every other page has NO mark until somebody looks at that
 * page and decides. Passing no `mark` is the correct state for witnesses, proposals,
 * creators, search, wallet and profile today. Do not batch-assign marks to pages
 * nobody has reviewed.
 */

interface PageMastheadProps {
  /** Small uppercase label above the title. Optional: witnesses has none. */
  eyebrow?: string;
  title: ReactNode;
  /** Decorative watermark. Omit for any page without an assigned mark. */
  mark?: MastheadMark;
  /** The meta row under the title: description text, stats, calls to action. */
  children?: ReactNode;
  /**
   * Right-aligned controls that belong to the header rather than the page, e.g.
   * the witnesses General/Params tabs. Sits on the meta row, pushed right.
   */
  actions?: ReactNode;
  /**
   * Heading level for the title. Defaults to `h1` — the masthead IS the page
   * heading on all nine of its other consumers, and none of them should change.
   *
   * `/creators` is the exception: it now leads with the Meritum intro, whose
   * headline is the real page heading, and the masthead sits BELOW it. Two `h1`s
   * on one page is not a style nit — it breaks the document outline that screen
   * readers and search engines navigate by. Opt in per page rather than
   * demoting the shared component, so the other nine are untouched.
   */
  headingLevel?: 'h1' | 'h2';
}

const PageMasthead: FC<PageMastheadProps> = ({
  eyebrow,
  title,
  mark,
  children,
  actions,
  /*
   * PascalCase is REQUIRED here, not a style choice: JSX resolves a lowercase
   * tag name to a DOM element and only an uppercase identifier to a variable,
   * so `<heading>` would render a literal <heading> element and silently drop
   * the real heading. Hence the rename on destructure, and the disable below.
   */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  headingLevel: Heading = 'h1'
}) => (
  // The gradient stops are tokens (see --masthead-* in globals.css): a
  // `bg-[radial-gradient(...)]` is a background-IMAGE, so the colours live
  // inline and nothing else can theme them. The light values are byte-identical
  // to the hexes that were here.
  <header className="relative mb-7 overflow-hidden rounded-[20px] border border-line-warn-3 border-l-[3px] border-l-line-brand-10 bg-[radial-gradient(125%_130%_at_0%_0%,rgb(var(--masthead-1))_0%,rgb(var(--masthead-2))_30%,rgb(var(--masthead-3))_58%,rgb(var(--masthead-4))_85%)] px-7 pb-5 pt-7">
    {mark ? <MastheadGlyph mark={mark} /> : null}

    {eyebrow ? (
      // `/70` de-emphasises the eyebrow, which costs contrast: 70% of the brand
      // ink cannot clear 4.5:1 over ANY ground dark enough to be a dark masthead
      // (measured: 4.48:1 even at #231815). Light keeps the 70% it was designed
      // with; dark restores full strength, which reads as the same weight there.
      <p className="relative z-10 mb-1.5 text-[12px] leading-[18px] font-semibold uppercase tracking-[0.14em] text-ink-brand-6/70 dark:text-ink-brand-6">
        {eyebrow}
      </p>
    ) : null}

    <Heading className="relative z-10 font-serif text-[34px] font-semibold leading-[38px] tracking-[-0.015em] text-ink-2">
      {title}
    </Heading>

    {children || actions ? (
      <div className="relative z-10 mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] leading-[20px] text-ink-10">
        {children}
        {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
      </div>
    ) : null}
  </header>
);

export default PageMasthead;
