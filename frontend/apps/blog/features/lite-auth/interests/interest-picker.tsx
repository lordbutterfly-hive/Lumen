'use client';

import { FC, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogClose, DialogContentBare, DialogDescription, DialogTitle } from '@ui/components/dialog';
import { Button } from '@ui/components/button';
import { Icons } from '@ui/components/icons';
import { cn } from '@ui/lib/utils';

/**
 * ★★★ THE SIGNUP INTEREST PICKER.
 *
 * recsys has accepted `explicit_interest_tags` since it was written and NOTHING
 * ever supplied them. Measured 2026-08-06 against a real trust snapshot: every
 * result for a fresh lite account came back `popular_fallback`, identically for
 * every reader, because a lite account reached the ranker with no follows, no
 * interests and no history. The engine was right; the product never asked.
 *
 * ★ WHY THE WAIT IS HERE AND NOWHERE ELSE. Building a viewer's first ranked feed
 * costs ~14s (recsys assembles their profile, then every ranked post is fetched
 * from Hive). Paying that on every login is not a product. Paying it ONCE, right
 * here, where the reader has just chosen their interests and is being told their
 * feed is being built, is honest and even reassuring. After this the feed is
 * cached per viewer and served stale-while-revalidate, so every later visit is
 * instant.
 */

// TODO i18n — staged copy, same precedent as app-header's LABELS.
const COPY = {
  title: 'What are you into?',
  subtitle: 'Pick a few and your feed is built around them. You can change these any time.',
  building: 'Building your feed…',
  buildingSub: 'Finding writers you might like. This only happens once.',
  skip: 'Skip for now',
  close: 'Close',
  cta: (n: number, min: number) => (n < min ? `Pick ${min - n} more` : `Continue with ${n}`),
  counter: (n: number, max: number) => `${n} of ${max}`
};

interface InterestOption {
  id: string;
  label: string;
  icon: string;
  /**
   * Section heading. Optional so a server that predates the grouped taxonomy
   * (or a cached response from one) still renders — those options fall into a
   * single unlabelled section rather than disappearing.
   */
  group?: string;
  tags: string[];
}

/**
 * Group the options into sections, IN THE ORDER THE SERVER SENT THEM.
 *
 * ★ WHY SECTIONS (2026-08-09). The taxonomy went from 23 topics to 48, built
 * from the measured tag frequencies of 38,478 real root posts, because six
 * interests cannot describe what a person reads. A flat wrap of 48 pills is a
 * worse thing to choose from than 23 was — the reader scans a wall and picks
 * from the first row. Sections keep the coverage and give the eye somewhere to
 * land.
 *
 * Order comes from the array, not from a second list: the taxonomy keeps each
 * group's entries contiguous, so first-appearance order IS the intended order
 * and there is nothing here that can fall out of sync with it.
 */
function sectionsOf(options: InterestOption[]): { group: string; items: InterestOption[] }[] {
  const sections: { group: string; items: InterestOption[] }[] = [];
  for (const option of options) {
    const group = option.group ?? '';
    const last = sections.find((s) => s.group === group);
    if (last) last.items.push(option);
    else sections.push({ group, items: [option] });
  }
  return sections;
}

/**
 * `openSignal` lets something OUTSIDE onboarding open this — the "Edit
 * interests" control in the right rail. Bumping the number opens the dialog
 * with the reader's current picks preselected.
 *
 * ★ WHY IT IS NEEDED. The automatic rule fires only for a reader with zero
 * posts and zero comments, once, ever. Without a manual way in, everyone who
 * already writes here — including every Hive account with a history — could
 * NEVER tell Lumen what they are interested in, and their ranked feed had no
 * way to improve. A one-shot modal with no second door is a dead end.
 */
const InterestPicker: FC<{ openSignal?: number }> = ({ openSignal = 0 }) => {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<InterestOption[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [max, setMax] = useState(20);
  const [min, setMin] = useState(3);
  const [saving, setSaving] = useState(false);
  const autoOpened = useRef(false);

  // ★ NO CLIENT AUTH STATE. `useUserClient()` was measured reporting logged-OUT
  // for a session the same page's `/api/users/me` reported logged-IN — the
  // header rendered "Log in" while authenticated — so a picker gated on it never
  // rendered at all. `/api/lite/interests` resolves the session SERVER-side and
  // returns `eligible`, which is the only trustworthy answer here.
  /**
   * ★ ONE REQUEST, NOT TWO (2026-08-10) — MEASURED.
   *
   * This was a bare `fetch` inside a mount effect, and `reactStrictMode` is on, so
   * React ran the effect twice and both calls went out: measured on one signed-out
   * page load, `/api/lite/interests` at t=10.8s and again at t=11.0s, 8ms apart,
   * both returning the same 7141 bytes. The effect's `cancelled` flag only stopped
   * the second RESULT from being applied; the request had already been sent and had
   * already taken its turn on a single-threaded server that the feed was queued
   * behind. Going through react-query dedupes it at the key: two subscribers, one
   * request, and a remount inside the stale window costs nothing at all.
   */
  const { data: body } = useQuery({
    queryKey: ['liteInterests'],
    queryFn: async () => {
      const res = await fetch('/api/lite/interests');
      if (!res.ok) throw new Error(`interests ${res.status}`);
      return (await res.json()) as {
        interests?: InterestOption[];
        selected?: string[];
        max?: number;
        min?: number;
        eligible?: boolean;
        asked?: boolean;
        blankSlate?: boolean;
      };
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // The picker is an enhancement to onboarding, never a blocker.
    retry: 0
  });

  useEffect(() => {
    if (!body) return;
    setOptions(body.interests ?? []);
    setPicked(body.selected ?? []);
    setMax(body.max ?? 20);
    setMin(body.min ?? 3);
    // ★ WHEN THE PICKER FIRES (owner rule, 2026-08-08). Three conditions,
    // all of them the server's answer, never the client's guess:
    //   `eligible`   — a real signed-in reader, LITE OR HIVE, whose picks
    //                  we have somewhere to store.
    //   `!asked`     — we have never asked. Not "selected is empty": that
    //                  would re-prompt forever anyone who deliberately
    //                  skipped.
    //   `blankSlate` — zero posts and zero comments. Someone who has
    //                  already written here has shown us what they are
    //                  into; interrupting them with a questionnaire is
    //                  noise.
    // One shot. The effect now depends on `body`, and a later refetch hands back a
    // new object — without this, a reader who dismissed the picker could have it
    // reopen on them.
    if (autoOpened.current) return;
    if (body.eligible && !body.asked && body.blankSlate) {
      autoOpened.current = true;
      setOpen(true);
    }
  }, [body]);

  // Opened deliberately from the rail. Skips every gate above on purpose: the
  // reader asked for it, so "already asked" and "has written before" are not
  // reasons to refuse them.
  useEffect(() => {
    if (openSignal > 0) setOpen(true);
  }, [openSignal]);

  const toggle = (id: string) => {
    setPicked((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : prev.length >= max ? prev : [...prev, id]
    );
  };

  const save = async (interests: string[]) => {
    setSaving(true);
    try {
      await fetch('/api/lite/interests', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': '1' },
        body: JSON.stringify({ interests })
      });
      // Force the ranked feed to rebuild NOW, behind this spinner, with the
      // picks included. Without `refresh=1` the reader would land on the generic
      // feed they had a moment ago and the picker would look like it did nothing.
      await fetch('/api/feed/for-you?limit=20&refresh=1').catch(() => undefined);
    } finally {
      setSaving(false);
      setOpen(false);
      // The feed page reads through the same cache we just filled.
      if (typeof window !== 'undefined') window.location.reload();
    }
  };

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (v || saving) return;
        // ★ DISMISSING IS A DECISION, AND IT HAS TO STICK (2026-08-08).
        //
        // Making this closeable by clicking away fixed the app being held hostage,
        // but only "Skip for now" recorded the choice — so clicking away closed it
        // and it came straight back on the NEXT page load, and the one after that,
        // blocking the page each time. That is arguably worse than the original
        // trap: it looks like the app is broken rather than busy.
        //
        // Closing it any way at all now records the same "asked, declined" state
        // the Skip button records, so it is asked once and never again.
        setOpen(false);
        void save([]);
      }}
    >
      <DialogContentBare
        /**
         * ★★★ THE PRIMARY ACTION WAS BELOW THE FOLD (2026-08-10, T-4) — MEASURED.
         *
         * This was `max-h-[88vh] ... overflow-y-auto p-7` inside a wrapper that
         * pins its child to `items-start`. In an 855px viewport that is a 752px
         * box starting at y=0: not centred, and with 48 pills between the title
         * and the footer, "Skip for now" and "Continue with N" sat past the
         * bottom edge. Scrolling to reach the only two buttons in a modal is the
         * definition of a dialog that does not fit.
         *
         * It is a COLUMN now: title fixed at the top, footer fixed at the bottom,
         * and only the pills scroll (`min-h-0` is what lets the middle child
         * actually shrink inside a flex column, without it the footer is pushed
         * out again). The wrapper centres it, and `max-h` leaves room for the
         * `p-4` gutter so the box never touches the window edge.
         */
        wrapperClassName="items-center p-4 sm:p-6"
        className="relative flex max-h-[min(760px,90vh)] w-[min(680px,94vw)] flex-col overflow-hidden rounded-[16px] bg-white shadow-xl"
        // ★ CLICKING AWAY MUST DISMISS IT (2026-08-07).
        //
        // This was `onInteractOutside={(e) => e.preventDefault()}` — a modal that
        // could only be closed by finding its own button. A Radix modal also sets
        // `pointer-events: none` on the whole page and lays a full-screen overlay
        // over it, so until the reader found that button EVERY post, link and vote
        // control in the app was dead to the touch.
        //
        // Measured: on first sign-in the overlay is up, `document.body` has
        // pointer-events:none, and a click on any post is swallowed. The owner hit
        // exactly this and reasonably concluded the product was broken. Several QA
        // testers dismissed it as onboarding noise and never realised it was the
        // cause of the "nothing is clickable" reports.
        //
        // The picker still matters — those choices feed the ranker — so it still
        // appears. It just no longer holds the app hostage. Only an in-flight save
        // blocks dismissal, because interrupting that would lose the answer.
        onInteractOutside={(e) => { if (saving) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (saving) e.preventDefault(); }}
      >
        {saving ? (
          <div className="flex flex-col items-center justify-center gap-4 px-7 py-16 text-center">
            {/* The one honest wait in the product. */}
            <div
              aria-hidden
              className="h-10 w-10 animate-spin rounded-full border-[3px] border-[#ecebe6] border-t-[#c0392b]"
            />
            <DialogTitle className="font-serif text-[22px] leading-[34px] font-bold text-[#161511]">
              {COPY.building}
            </DialogTitle>
            <DialogDescription className="font-sans text-[14px] leading-[22px] text-[#6b7280]">
              {COPY.buildingSub}
            </DialogDescription>
          </div>
        ) : (
          <>
            {/* pr-14 keeps the title clear of the close button in the corner. */}
            <div className="shrink-0 px-7 pb-4 pr-14 pt-7">
              <DialogTitle className="font-serif text-[26px] font-bold leading-[34px] text-[#161511]">
                {COPY.title}
              </DialogTitle>
              <DialogDescription className="mt-1.5 max-w-[52ch] font-sans text-[15px] leading-[24px] text-[#6b7280]">
                {COPY.subtitle}
              </DialogDescription>
              {/* ★ NOTHING SAID HOW TO LEAVE (2026-08-10, T-3). Escape worked and
                  clicking away worked, and the dialog advertised neither, so the
                  only visible way out was to answer the question. Every other
                  dialog in the app has this control (see `DialogContent`'s own
                  auto-injected one); this one uses `DialogContentBare`, which
                  deliberately injects nothing, and never grew its own.
                  It is a real `DialogClose`, so it goes through the same
                  `onOpenChange` path as clicking away and records the same
                  "asked, declined" state rather than silently re-prompting. */}
              <DialogClose
                aria-label={COPY.close}
                className="absolute right-4 top-4 rounded-full p-2 text-[#9ca3af] transition-colors hover:bg-[#f4f5f7] hover:text-[#161511] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c0392b]"
              >
                <Icons.x className="h-[18px] w-[18px]" />
              </DialogClose>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-2">
              {sectionsOf(options).map((section) => (
                <div key={section.group || 'all'} className="mb-5">
                  {section.group ? (
                    <h3 className="mb-2 font-sans text-[12px] font-semibold uppercase tracking-[0.08em] text-[#9ca3af]">
                      {section.group}
                    </h3>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {section.items.map((o) => {
                      const on = picked.includes(o.id);
                      const full = !on && picked.length >= max;
                      return (
                        <button
                          key={o.id}
                          type="button"
                          aria-pressed={on}
                          disabled={full}
                          onClick={() => toggle(o.id)}
                          /**
                           * ★ NO EMOJI, AND THE SELECTED STATE IS THE BRAND'S RED
                           * (2026-08-10, T-1/T-2).
                           *
                           * 45 of the 50 pills carried an emoji from the taxonomy's
                           * `icon` field. Those glyphs are drawn by the operating
                           * system, so the same screen renders Apple's, Google's and
                           * Microsoft's art side by side, at three different weights,
                           * none of which is Lora or Open Sans. In a product whose
                           * whole surface is two typefaces and a restrained palette,
                           * that one row read as a different app.
                           *
                           * The taxonomy keeps its `icon` field: it costs nothing,
                           * it is what the API already returns, and this is the only
                           * thing that ever rendered it.
                           *
                           * Selected was `#161511` — the body ink, which is also the
                           * text colour of every UNSELECTED pill, so "chosen" and
                           * "not chosen" were the same colour in different places.
                           * `#c0392b` is the mark the rest of the product uses for
                           * "this one", and it is the only red on screen.
                           */
                          className={cn(
                            'rounded-full border px-4 py-2.5 font-sans text-[14px] leading-[22px] transition-colors',
                            on
                              ? 'border-[#c0392b] bg-[#c0392b] font-medium text-white'
                              : 'border-[#e4e6e9] bg-white text-[#161511] hover:border-[#c0392b] hover:text-[#c0392b]',
                            full && 'cursor-not-allowed opacity-40'
                          )}
                        >
                          {o.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex shrink-0 items-center justify-between gap-4 border-t border-[#ebedf0] px-7 py-5">
              <button
                type="button"
                onClick={() => save([])}
                className="font-sans text-[14px] leading-[22px] text-[#9ca3af] underline-offset-2 hover:text-[#161511] hover:underline"
              >
                {COPY.skip}
              </button>
              <div className="flex items-center gap-3">
                <span className="font-sans text-[13px] leading-[20px] text-[#9ca3af]">
                  {COPY.counter(picked.length, max)}
                </span>
                <Button
                  type="button"
                  disabled={picked.length < min}
                  onClick={() => save(picked)}
                  className="rounded-[10px] bg-[#c0392b] px-5 py-2.5 font-sans text-[14px] leading-[22px] font-semibold text-white hover:bg-[#a83224] disabled:opacity-40"
                >
                  {COPY.cta(picked.length, min)}
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContentBare>
    </Dialog>
  );
};

export default InterestPicker;
