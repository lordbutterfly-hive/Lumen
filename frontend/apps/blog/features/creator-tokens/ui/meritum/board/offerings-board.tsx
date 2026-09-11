'use client';

/**
 * ★★★ THE DEPARTURES BOARD — the Meritum landing page's left rail.
 *
 * Up to ten creators, each row showing ONE of that creator's live offerings and
 * flipping to the next on a timer, the way an airport board cycles a flight.
 * Fewer than ten creators is not a degraded state, it is the honest one while
 * the product is early: the board renders however many exist, and renders
 * NOTHING at all when there are none — a landing page's rail has no room to
 * explain an empty box, and an empty box reads as broken.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FOUR LAYOUT CONSTRAINTS, each for a real failure:
 *
 * 1. IT LIVES ONLY ON THIS PAGE. It is rendered inside `CreatorsView`'s own
 *    `rightRail`, which `app/creators/page.tsx` is the only route to mount. The
 *    left rail is shared navigation on every creator-token screen and was where
 *    this shipped first -- wrong twice over: a rotating advert does not belong
 *    beside someone editing their own prices in the Studio, and 200px is not
 *    enough for a name, a price and a title without all three fighting. The
 *    right rail is 312px and already holds "Launch your Meritum", so the two
 *    read as one column of offers.
 *
 * 2. IT STAYS PUT WHEN THE PAGE SCROLLS. The shell's right `<aside>` is already
 *    `sticky top-24 h-fit`, so this inherits that for free -- and must not fight
 *    it. Nothing here sets its own `position`.
 *
 * 3. IT CANNOT CLIP. A sticky box taller than the viewport is unreachable at the
 *    bottom: the page scrolls, the box does not, and the last rows can never be
 *    read. So the LIST caps at the space actually available and scrolls
 *    internally. Expanding a description grows the list inside that cap rather
 *    than pushing the sticky box off-screen -- and the cap must account for the
 *    launch card ABOVE it, which is why it is not simply `100vh - top`.
 *
 * 4. TEXT TRUNCATES, THE PRICE NEVER DOES. Both free-text fields (the creator's
 *    name and the offering title) are `min-w-0` with truncation; the price is
 *    `tabular-nums` and always rendered whole, because a clipped price is a
 *    wrong price.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ROTATION RULE THE OWNER ASKED FOR, STATED EXACTLY: the list may not
 * rotate while a description is open. Not "the open row pauses" — the WHOLE
 * board freezes, because the rows below an open row move when anything above
 * them flips, and reading a description while the paragraph under your eyes
 * slides is the bug. `paused` is derived from `expanded.size > 0`, so it is
 * impossible for a row to be open and the timer to be running.
 *
 * It also pauses on hover and whenever the tab is hidden — the first so a
 * reader can aim at a row without it changing under the cursor, the second
 * because animating a board nobody is looking at is pure battery.
 */

import { FC, useEffect, useMemo, useRef, useState } from 'react';
import BasePathLink from '@/blog/components/base-path-link';
import { UserAvatarImg } from '@ui/components';
import { cn } from '@ui/lib/utils';
import { usdPrice } from '../../../market/format';
import { usdFromHbd, displayHandle, routeHandle } from '../../../live/adapt';
import { useOfferingBoard } from '../../../live/use-offering-board';

/** How long one offering holds the row before flipping. Staggered per row below. */
const DWELL_MS = 5_200;
/** The flap itself: short enough to read as a change, not an animation. */
const FLAP_MS = 260;

/**
 * A creator's description is fetched only when their row is OPENED, never up
 * front. Ten creators' prose on a landing page would be ten requests for text
 * nobody has asked to read yet.
 */
function useDescription(creator: string, offeringId: number, open: boolean): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setText(null);
    // ★★★ `routeHandle`, NOT THE RAW DISCOVERY KEY (caught on the first live
    // render, 2026-09-11). Discovery returns the contract's own account id,
    // `hive:godfish`; descriptions are stored under the key the STUDIO writes,
    // which is `creatorAccount` — a BARE Hive name, or a full `did:pkh:…` for a
    // wallet creator. Asking for `hive:godfish` matches no row and returns an
    // empty map, so every row would have read "No description yet." forever,
    // with no error anywhere: the read succeeds, it just finds nothing. This is
    // the silent-zero identity drift this codebase has now been bitten by four
    // times (see use-live-studio.ts's own note on a Studio keyed to the display
    // name finding no market). `routeHandle` is the SAME normaliser the link
    // above uses and the same one `/creators/[handle]` resolves back, so the
    // three agree by construction rather than by coincidence.
    fetch(`/api/creator-tokens/offering-description?creator=${encodeURIComponent(routeHandle(creator))}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { descriptions?: Record<string, string> } | null) => {
        if (!live) return;
        setText(body?.descriptions?.[String(offeringId)] ?? '');
      })
      .catch(() => {
        // Degrades to "no description", never to an error in a 200px rail.
        if (live) setText('');
      });
    return () => {
      live = false;
    };
  }, [creator, offeringId, open]);
  return text;
}

/** The shell's own `sticky top-24`, in px. The list can never be taller than what is left below it. */
const STICKY_TOP_PX = 96;
/** Breathing room under the list so it never ends flush with the window edge. */
const BOTTOM_GUTTER_PX = 24;

/**
 * ★★★ THE CAP IS MEASURED, NOT GUESSED (2026-09-11, owner: "what happens if it's
 * more than 10? won't it go under the screen and not be accessible").
 *
 * The right answer is a scroll container, which this already was — but a scroll
 * container only helps if the CONTAINER ITSELF is on screen. The first version
 * capped the list at `100vh - 22rem`, a constant standing in for "the sticky
 * offset plus the launch card above me". Measured on a 900px viewport with every
 * row expanded: the box was correctly 548px tall and correctly scrollable, and
 * its bottom sat at 972px. The last 72px of the scroller — and whatever rows were
 * in them — were below the fold of a box that does not scroll with the page.
 * Reachable in the DOM, unreachable with a mouse.
 *
 * A constant cannot know how tall the card above it is, and that card's copy can
 * change. So the list measures its own offset INSIDE the sticky aside and
 * subtracts that, plus the sticky offset, from the viewport. That expression is
 * correct at any viewport, with any number of rows, and stays correct if the
 * launch card grows.
 *
 * ★ MEASURED AGAINST THE ASIDE, NOT THE VIEWPORT. Taking `rect.top` directly
 * would read the UNPINNED position while the page is scrolled to the top, which
 * is larger than the pinned one, and would cap the list too aggressively until
 * the reader scrolled. The offset within the aside is the same whether pinned or
 * not, so `STICKY_TOP_PX + offset` is the pinned top at all times.
 */
function useViewportCap(ref: React.RefObject<HTMLElement>): number | undefined {
  const [cap, setCap] = useState<number | undefined>(undefined);
  useEffect(() => {
    const measure = () => {
      const el = ref.current;
      const aside = el?.closest('aside');
      if (!el || !aside) return;
      const offsetInAside = el.getBoundingClientRect().top - aside.getBoundingClientRect().top;
      setCap(Math.max(160, window.innerHeight - STICKY_TOP_PX - offsetInAside - BOTTOM_GUTTER_PX));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [ref]);
  return cap;
}

const BoardRow: FC<{
  creator: string;
  offerings: { offeringId: number; title: string; priceHbd: number }[];
  index: number;
  paused: boolean;
  open: boolean;
  onToggle: () => void;
}> = ({ creator, offerings, index, paused, open, onToggle }) => {
  const [slot, setSlot] = useState(0);
  const [flapping, setFlapping] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = offerings[slot % offerings.length];
  const description = useDescription(creator, current.offeringId, open);

  useEffect(() => {
    // One offering never flips, and a paused board never flips. Both are
    // absences of a timer rather than a timer that does nothing, so a paused
    // board costs no wakeups at all.
    if (paused || offerings.length < 2) return;
    // Staggered: rows must not flip in unison, or it reads as the page
    // re-rendering rather than a board updating.
    const delay = DWELL_MS + index * 420;
    timer.current = setTimeout(() => {
      setFlapping(true);
      setTimeout(() => {
        setSlot((s) => s + 1);
        setFlapping(false);
      }, FLAP_MS);
    }, delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [paused, offerings.length, index, slot]);

  return (
    <li className="border-b border-line-2 last:border-0">
      <div className="flex min-w-0 items-center justify-between gap-2 py-2">
        <BasePathLink
          href={`/creators/${routeHandle(creator)}`}
          className="flex min-w-0 flex-1 items-center gap-2 font-ui text-[13px] leading-[20px] font-semibold text-ink-2 hover:text-ink-brand-6"
          title={displayHandle(creator)}
        >
          {/* ★ THE SAME COMPONENT THE BELL AND THE FEED USE. It resolves a lite
              account through `/api/avatar` to their own initial rather than a
              shared default picture, and a wallet creator has no Hive avatar at
              all -- so this must never be a bare <img> pointed at an avatar URL.
              24px: big enough to recognise a face, small enough that the name
              beside it still gets most of the row. */}
          <UserAvatarImg
            username={routeHandle(creator)}
            pixelSize={24}
            alt={`${displayHandle(creator)} profile picture`}
          />
          <span className="min-w-0 flex-1 truncate">{displayHandle(creator)}</span>
        </BasePathLink>
        {/* Never truncated: a clipped price is a wrong price. */}
        <span className="shrink-0 font-num text-[13px] leading-[20px] tabular-nums text-ink-10">
          {usdPrice(usdFromHbd(current.priceHbd))}
        </span>
      </div>

      {/* ★ THE TITLE WRAPS, IT DOES NOT TRUNCATE (owner, 2026-09-11: "the titles
          cannot be read they get ..."). It was `truncate`, borrowed from the 200px
          left rail this board first shipped in. A service title is up to 64 bytes
          of the creator's own words and it is the whole reason the row exists —
          "Reviewing your post giving feed…" tells a reader nothing and gives them
          nothing to click toward. Names and prices still hold one line: a handle
          is short, and a clipped price is a wrong price. Only this field wraps,
          onto as many lines as it needs.

          `items-start` so the chevron stays level with the FIRST line of a title
          that now runs to two or three, rather than drifting to the vertical
          middle of a growing block. */}
      <div className="flex min-w-0 items-start gap-1 pb-2">
        <span
          className={cn(
            'min-w-0 flex-1 break-words font-ui text-caption text-ink-10 transition-all motion-reduce:transition-none',
            // The flap: the outgoing title lifts and fades, the incoming one
            // settles. `motion-reduce` drops it to a plain swap rather than
            // removing the change, which would hide the update entirely.
            flapping ? '-translate-y-1 opacity-0' : 'translate-y-0 opacity-100'
          )}
          style={{ transitionDuration: `${FLAP_MS}ms` }}
          title={current.title}
        >
          {current.title}
        </span>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? `Hide what ${displayHandle(creator)} offers` : `Show what ${displayHandle(creator)} offers`}
          className="shrink-0 rounded px-1 text-ink-14 transition-colors hover:text-ink-2"
        >
          <span aria-hidden className={cn('inline-block transition-transform', open ? 'rotate-180' : '')}>
            ▾
          </span>
        </button>
      </div>

      {/* In normal flow, so it PUSHES the rows below down rather than covering
          them — the behaviour asked for, and the one that keeps the board
          readable at 200px where an overlay would have nowhere to go. */}
      {open ? (
        <p className="pb-3 font-ui text-caption leading-[18px] text-ink-14">
          {description === null
            ? 'Loading…'
            : description === ''
              ? 'No description yet.'
              : description}
        </p>
      ) : null}
    </li>
  );
};

const OfferingsBoard: FC = () => {
  const { rows, isLoading, unavailable } = useOfferingBoard();
  const listRef = useRef<HTMLUListElement>(null);
  const cap = useViewportCap(listRef);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [hovered, setHovered] = useState(false);
  const [tabHidden, setTabHidden] = useState(false);

  useEffect(() => {
    const onVis = () => setTabHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // THE RULE: any open description freezes the entire board. See the file note.
  const paused = expanded.size > 0 || hovered || tabHidden;

  const toggle = useMemo(
    () => (creator: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(creator)) next.delete(creator);
        else next.add(creator);
        return next;
      }),
    []
  );

  // Nothing to say and no room to say it in: render nothing rather than a box.
  if (unavailable || (!isLoading && rows.length === 0)) return null;

  return (
    <section
      // The launch card's own chrome, verbatim, so the two sit as siblings
      // rather than as a card and a loose list.
      className="rounded-panel border border-line-9 bg-surface-1 p-5 shadow-[0_1px_2px_rgba(26,22,18,0.035),0_3px_12px_-6px_rgba(70,46,30,0.13)]"
      data-testid="meritum-offerings-board"
    >
      <div className="mb-1.5 font-ui text-lg font-medium text-ink-2">Meritum board</div>
      <p className="mb-3 font-ui text-[14px] leading-[22px] text-ink-10">
        What creators are selling right now.
      </p>
      {isLoading && rows.length === 0 ? (
        <p className="font-ui text-caption text-ink-14">Loading…</p>
      ) : (
        <ul
          // Constraint 3: bounded to the viewport and scrolled internally, so an
          // expanded description can never carry the sticky rail off-screen.
          // `top-24` (6rem) + the launch card and this card's own chrome above the
          // list. Generous rather than exact: too small only costs an early
          // scrollbar, too large puts rows below the fold with no way to reach them.
          className="max-h-[calc(100vh-22rem)] overflow-y-auto overscroll-contain"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          {rows.map((row, i) => (
            <BoardRow
              key={row.creator}
              creator={row.creator}
              offerings={row.offerings}
              index={i}
              paused={paused}
              open={expanded.has(row.creator)}
              onToggle={() => toggle(row.creator)}
            />
          ))}
        </ul>
      )}
    </section>
  );
};

export default OfferingsBoard;
