'use client';

import { FC, useEffect, useState } from 'react';
import { Dialog, DialogContentBare, DialogDescription, DialogTitle } from '@ui/components/dialog';
import { Button } from '@ui/components/button';
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

  // ★ NO CLIENT AUTH STATE. `useUserClient()` was measured reporting logged-OUT
  // for a session the same page's `/api/users/me` reported logged-IN — the
  // header rendered "Log in" while authenticated — so a picker gated on it never
  // rendered at all. `/api/lite/interests` resolves the session SERVER-side and
  // returns `eligible`, which is the only trustworthy answer here.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/lite/interests');
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled) return;
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
        if (body.eligible && !body.asked && body.blankSlate) setOpen(true);
      } catch {
        /* the picker is an enhancement to onboarding, never a blocker */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
        className="max-h-[88vh] w-[min(680px,94vw)] overflow-y-auto rounded-[16px] bg-white p-7 shadow-xl"
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
          <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
            {/* The one honest wait in the product. */}
            <div
              aria-hidden
              className="h-10 w-10 animate-spin rounded-full border-[3px] border-[#ecebe6] border-t-[#161511]"
            />
            <DialogTitle className="font-serif text-[22px] font-bold text-[#161511]">
              {COPY.building}
            </DialogTitle>
            <DialogDescription className="font-sans text-[14px] text-[#6b7280]">
              {COPY.buildingSub}
            </DialogDescription>
          </div>
        ) : (
          <>
            <DialogTitle className="font-serif text-[26px] font-bold leading-tight text-[#161511]">
              {COPY.title}
            </DialogTitle>
            <DialogDescription className="mt-1.5 font-sans text-[14.5px] text-[#6b7280]">
              {COPY.subtitle}
            </DialogDescription>

            {sectionsOf(options).map((section) => (
              <div key={section.group || 'all'} className="mt-5">
                {section.group ? (
                  <h3 className="mb-2 font-sans text-[11.5px] font-semibold uppercase tracking-[0.08em] text-[#9ca3af]">
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
                        className={cn(
                          'flex items-center gap-2 rounded-full border px-4 py-2.5 font-sans text-[14px] transition-colors',
                          on
                            ? 'border-[#161511] bg-[#161511] text-white'
                            : 'border-[#e4e6e9] bg-white text-[#161511] hover:border-[#161511]',
                          full && 'cursor-not-allowed opacity-40'
                        )}
                      >
                        <span aria-hidden>{o.icon}</span>
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            <div className="mt-7 flex items-center justify-between gap-4">
              <button
                type="button"
                onClick={() => save([])}
                className="font-sans text-[13.5px] text-[#9ca3af] underline-offset-2 hover:text-[#161511] hover:underline"
              >
                {COPY.skip}
              </button>
              <div className="flex items-center gap-3">
                <span className="font-sans text-[13px] text-[#9ca3af]">
                  {COPY.counter(picked.length, max)}
                </span>
                <Button
                  type="button"
                  disabled={picked.length < min}
                  onClick={() => save(picked)}
                  className="rounded-[10px] bg-[#161511] px-5 py-2.5 font-sans text-[14px] font-semibold text-white hover:bg-[#2a2823] disabled:opacity-40"
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
