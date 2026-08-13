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
 *   border  1px #eee2dc, with a 3px #c0392b rule down the left edge
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
}

const PageMasthead: FC<PageMastheadProps> = ({ eyebrow, title, mark, children, actions }) => (
  <header className="relative mb-7 overflow-hidden rounded-[20px] border border-[#eee2dc] border-l-[3px] border-l-[#c0392b] bg-[radial-gradient(125%_130%_at_0%_0%,#f7c9bd_0%,#fbdfd6_30%,#fdefe9_58%,#fffdfc_85%)] px-7 pb-5 pt-7">
    {mark ? <MastheadGlyph mark={mark} /> : null}

    {eyebrow ? (
      <p className="relative z-10 mb-1.5 text-[12px] leading-[18px] font-semibold uppercase tracking-[0.14em] text-[#c0392b]/70">
        {eyebrow}
      </p>
    ) : null}

    <h1 className="relative z-10 font-serif text-[34px] font-semibold leading-[38px] tracking-[-0.015em] text-[#161511]">
      {title}
    </h1>

    {children || actions ? (
      <div className="relative z-10 mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] leading-[20px] text-[#6b7280]">
        {children}
        {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
      </div>
    ) : null}
  </header>
);

export default PageMasthead;
