'use client';

import { useEffect, useState } from 'react';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { ManabarRing } from '@/blog/features/layouts/site-header/manabar-ring';
import { useTranslation } from '@/blog/i18n/client';
import { TIERS } from '../lib/tiers';
import { localDeadlineLabel, type DeadlineLabel } from '../lib/deadline';
import { todayHeadline } from '../lib/copy-select';
import { DAILY_GOALS, DAILY_GOAL_ORDER, type DailyGoalId } from '../lib/daily-goal';
import { useViewerRetention } from '../hooks/use-viewer-retention';
import { StreakFlame } from './streak-flame';

/**
 * ★ TODAY — the Duolingo daily loop, which this product had and then deleted.
 *
 * The 2026-07-20 build map specified two layers: a HABIT layer (daily goal, streak,
 * freeze, a ring that fills) and a LEAGUE layer (the earned public mark). The habit
 * layer shipped as a hardcoded mock — identical constants for every user, mounted
 * nowhere — and was correctly deleted on 2026-08-08. Nothing replaced it, so the
 * permanent ladder was left carrying all of the retention weight by itself, which is
 * how a reputation proxy ended up inside the engagement arm. This is the layer coming
 * back with real numbers behind it.
 *
 * WHAT IS REAL HERE AND WHAT IS PREFERENCE:
 *   acts today   — chain-derived, from the route. Unforgeable.
 *   streak       — chain-derived, with the freeze ledger applied server-side.
 *   freezes      — earned from the act-day set, spent days recorded in Postgres.
 *   the GOAL      — SERVER-HELD since 2026-08-09, because it now decides whether today
 *                  counts toward the streak. It was a client preference while it was
 *                  cosmetic; the moment it gates a chain-derived number it cannot be.
 *
 * ★ NOTHING HERE PRESSURES ANYBODY. No countdown, no "don't lose your streak", no
 * exclamation marks. When the goal is met it says so and stops; when it is not, it
 * states the deadline as a fact and mentions the banked freeze in the same breath.
 * The freeze exists so a missed day is designed in — panicking about a missed day
 * would contradict the mechanic.
 */
/**
 * Which mount this is.
 *
 * ★★ BECAUSE BOTH MOUNTS EXIST IN THE DOM AT ONCE (found 2026-08-09 in a browser session).
 * The rail copy is `hidden xl:block` and the inline copy is `xl:hidden`, so exactly one is
 * VISIBLE at any width — but CSS visibility is not existence, and both were rendering
 * `data-testid="retention-today"`, plus the same ids on the ring, the freeze lines, the
 * goal toggle and every picker button. Every one of those selectors therefore matched two
 * elements and tripped Playwright's strict mode: not a cosmetic problem, a whole surface
 * that could not be tested. The testids are scoped per surface instead of picking a winner,
 * because a test that targets "the mobile daily loop" is a test worth being able to write.
 */
export type TodaySurface = 'rail' | 'inline';

export function TodayCard({ className, surface = 'rail' }: { className?: string; surface?: TodaySurface }) {
  const { t } = useTranslation('common_blog');
  /**
   * ★ SAME RACE AS EVERY OTHER GATE THAT return-nulls A SIGNED-IN READER
   * (2026-08-12, G2). This was raw `useUserClient()`'s `user.isLoggedIn`, which
   * cannot answer during SSR and reports signed-out on the client until
   * `/api/users/me` returns — so the ENTIRE daily-loop card silently disappeared
   * for a signed-in reader for that window, not just a wrong branch inside it.
   * `identity.isLoggedIn` (server-session.tsx) answers immediately from the
   * session cookie the server already read.
   */
  const identity = useSessionIdentity();
  const { summary, refetch } = useViewerRetention();
  // ★ RESOLVED AFTER MOUNT, NEVER DURING RENDER. The deadline is a UTC instant stated in
  // the BROWSER's timezone, so computing it in the render body would make the server's
  // zone leak into the markup and mismatch on hydration. Null until the effect runs, and
  // the copy simply omits the clause while it is null — the sentence is written to stand
  // without it.
  const [deadline, setDeadline] = useState<DeadlineLabel | null>(null);
  useEffect(() => {
    setDeadline(localDeadlineLabel(Date.now()));
  }, []);
  // ★ THE GOAL COMES FROM THE SERVER NOW (2026-08-09). It used to be read from
  // localStorage, which was fine while it was cosmetic — it is not fine now that it gates
  // the streak, because a client-supplied goal would make a chain-derived number
  // forgeable. `summary.today.goal` is what the streak was actually computed against, so
  // the ring is drawn from the same value the server judged, never from a local guess
  // that could disagree with it.
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState<DailyGoalId | null>(null);
  /**
   * The goal the server just confirmed, held only until the summary catches up.
   *
   * Not a local preference and not a guess — see `choose` below. It exists because dropping
   * the streak cache on a write means the next read is a full Hive re-walk, so the confirmed
   * target would otherwise be invisible for the 20-60s that takes.
   */
  const [pendingGoal, setPendingGoal] = useState<number | null>(null);

  // Release the confirmed-goal override once the server's own answer carries it. Without this
  // the override would outlive its purpose and become the localStorage mistake by another name.
  const serverGoalRaw = summary?.today?.goal;
  useEffect(() => {
    if (pendingGoal !== null && serverGoalRaw === pendingGoal) setPendingGoal(null);
  }, [serverGoalRaw, pendingGoal]);


  if (!identity.isLoggedIn || !summary) return null;

  const today = summary.today;
  // A server predating the daily loop sends no `today` block. Render nothing rather
  // than a ring at zero, which would tell a prolific person they had done nothing.
  if (!today) return null;

  const acts = Math.max(0, today.acts);
  // The server's goal, or the one it confirmed a moment ago while the streak recomputes.
  // `pendingGoal` is dropped as soon as the summary agrees, so the two can never persistently
  // disagree — see `choose`.
  const serverGoal = Math.max(1, today.goal ?? 1);
  const target = pendingGoal !== null && pendingGoal !== serverGoal ? pendingGoal : serverGoal;
  const currentId = DAILY_GOAL_ORDER.find((id) => DAILY_GOALS[id].target === target);
  const met = acts >= target;
  const pct = Math.min(100, Math.round((acts / target) * 100));
  const core = TIERS[summary.rank.tier].color.core;
  const streakIsFloor = summary.provenance?.coverage?.streakDaysIsLowerBound === true;
  // Scoped ids: see TodaySurface. `tid('goal-picker')` → `retention-today-goal-picker`
  // on the rail and `retention-today-inline-goal-picker` inline.
  const base = surface === 'rail' ? 'retention-today' : 'retention-today-inline';
  const tid = (part: string) => `${base}-${part}`;

  // ════ WHAT TODAY ACTUALLY ASKS FOR ════
  //
  // ★★ THE GOAL GATES THE STREAK AND THE CARD DID NOT SAY SO (2026-08-09). The line was
  // `Day {{days}} holds until midnight UTC.` — written when the goal was cosmetic and left
  // unchanged when it started deciding whether today counts. A tester set "Serious" out of
  // curiosity, saw the ring go 0/1 → 0/4, and the sentence still promised the day "holds"
  // with no mention that the bar had quadrupled: "I could lose a streak to a setting I
  // picked casually." A gate the reader cannot see is a trap, however gently it is worded.
  //
  // Four cases, and the count is named whenever it is above one:
  //   met                      → "Done for today."
  //   nothing yet, no streak   → what STARTS one (never "Day 0 holds", which was reachable
  //                              and meaningless)
  //   nothing yet, has streak  → what HOLDS it
  //   goal above 1             → the number, in the sentence, not only in the ring
  //
  // The branch itself is in lib/copy-select.ts so it can be tested: two of its four cases
  // need a state a browser session does not casually produce.
  const head = todayHeadline({ met, streakDays: summary.streakDays, goal: target });
  const headline = t(head.key, head.vars);

  // The deadline, in the reader's own clock. Omitted entirely when the goal is met (there
  // is nothing left to be on time for) or before the effect has resolved a zone.
  const deadlineLine =
    met || !deadline
      ? ''
      : deadline.isMidnight
        ? t('retention.today.deadline_midnight')
        : t('retention.today.deadline', { time: deadline.time });

  const choose = async (id: DailyGoalId) => {
    setSaving(id);
    try {
      const res = await fetch('/api/retention/goal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: DAILY_GOALS[id].target })
      });
      if (!res.ok) return;
      // ★★ THE SERVER-CONFIRMED VALUE IS SHOWN IMMEDIATELY (2026-08-09, third pass on this).
      //
      // Round 1 of this bug: the goal lived in localStorage and could disagree with the server.
      // Round 2: it moved server-side, and the streak route served a 5-minute cached body, so a
      // change was invisible for minutes. Round 3, measured by a UX agent: the cache
      // invalidation works, and dropping the entry means the NEXT read takes the slow path — a
      // full Hive re-walk. They sampled 25 consecutive seconds of `data-goal="serious"` and
      // ring `0/4` after choosing Regular. Correct, and indistinguishable from broken.
      //
      // So the ring now draws the goal the SERVER just echoed back, while the streak recomputes
      // behind it. This is not the localStorage mistake returning: the value is not a local
      // guess, it is the write's own confirmed response, and it is discarded the moment
      // `summary.today.goal` catches up. What lags is the streak, which genuinely needs the
      // recompute; the target does not.
      const confirmed = Number((await res.json().catch(() => null))?.goal);
      if (Number.isFinite(confirmed) && confirmed > 0) setPendingGoal(confirmed);
      setPicking(false);
      // Re-read so the ring, the streak and the goal all end up from one computation.
      await refetch();
    } finally {
      setSaving(null);
    }
  };

  return (
    <section
      className={`rounded-[18px] border border-[#ebebeb] bg-white ${surface === 'rail' ? 'p-5' : 'p-4'} ${className ?? ''}`}
      data-testid={base}
      data-surface={surface}
      data-goal={currentId ?? String(target)}
      data-met={met || undefined}
    >
      <div className="flex items-center gap-4">
        <span className="relative inline-flex shrink-0 items-center justify-center">
          <ManabarRing percentage={pct} color={core} size={54} thickness={5} />
          <span className="absolute inset-0 flex items-center justify-center font-sans text-[13px] font-bold tabular-nums text-[#3f4650]">
            {acts}/{target}
          </span>
        </span>

        <div className="min-w-0 flex-1">
          <p className="font-sans text-[13px] font-semibold uppercase tracking-[0.06em] text-[#9ca3af]">
            {t('retention.today.title')}
          </p>
          <p
            className="mt-0.5 font-sans text-[16px] font-semibold leading-snug text-[#161511]"
            data-testid={tid('headline')}
          >
            {headline}
          </p>
          {deadlineLine ? (
            <p className="mt-0.5 font-sans text-[13px] text-[#6b7280]" data-testid={tid('deadline')}>
              {deadlineLine}
            </p>
          ) : null}
          {/* ★ THE INLINE (PHONE) CARD IS COMPACT (2026-08-09). Measured by a UX agent at
              390x844: the card owned the entire first screen and the first post started at
              y≈786 of 844 — so on a phone the daily loop had displaced the feed it is supposed
              to sit above. The ring, the headline and the deadline earn their place; the freeze
              ledger is a reassurance that can wait for the wider layout, where there is no
              feed underneath it to push away. */}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <StreakFlame days={summary.streakDays} active={summary.streakDays > 0} isLowerBound={streakIsFloor} />
            {/* The mercy, stated whenever it exists. It is the difference between a
                streak that survives a bad week and one that punishes it.
                ★ AND IT SAYS WHAT A FREEZE IS (2026-08-09). "2 freezes banked." was the
                only piece of invented vocabulary on the card, and a tester's reaction was
                exactly the one that matters: "I do not know what a freeze is. Nothing on
                screen explains it and I'm not going hunting." A mechanic whose whole job is
                to remove anxiety cannot introduce a term and then withhold it — the clause
                costs six words and turns jargon into a promise. */}
            {surface === 'rail' && today.freezesAvailable > 0 ? (
              <span className="font-sans text-[12.5px] text-[#6b7280]" data-testid={tid('freezes')}>
                {t('retention.today.freeze', { count: today.freezesAvailable })}
              </span>
            ) : null}
            {/* ★★ ONLY WHILE THE STREAK IS ACTUALLY ALIVE (found 2026-08-09 in my own verification
                output: the card read `0-day streak` and `A freeze covered yesterday. The streak
                held.` in the same breath). `freezesUsedOn` reports days a freeze covered inside the
                run that was computed — but once the run itself breaks, those days covered nothing.
                Saying "the streak held" beside a zero is the plainest self-contradiction this card
                could make, and it took a date rollover to expose it. */}
            {surface === 'rail' && summary.streakDays > 0 && today.freezesUsedRecently > 0 ? (
              <span className="font-sans text-[12.5px] text-[#6b7280]" data-testid={tid('freeze-used')}>
                {t('retention.today.freeze_used')}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* The picker is closed by default: a person who never opens it is measured
          against the smallest bar, which is the honest default. */}
      <button
        type="button"
        onClick={() => setPicking((v) => !v)}
        className="mt-3 font-sans text-[13px] font-semibold text-[#c0392b] hover:underline"
        data-testid={tid('goal-toggle')}
      >
        {t('retention.today.goal_title')}
      </button>

      {picking ? (
        <div className="mt-2.5" data-testid={tid('goal-picker')}>
          <div className="flex flex-wrap gap-2">
            {DAILY_GOAL_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => choose(id)}
                aria-pressed={currentId === id}
                disabled={saving !== null}
                className={`rounded-[11px] border px-3.5 py-2 text-left font-sans transition-colors ${
                  currentId === id
                    ? 'border-[#161511] bg-[#faf9f6]'
                    : 'border-[#e4e6e9] bg-white hover:bg-[#f4f5f7]'
                }`}
              >
                <span className="block text-[13.5px] font-semibold text-[#161511]">
                  {t(`retention.today.goal.${id}`)}
                </span>
                <span className="block text-[12px] text-[#6b7280]">{t(`retention.today.goal.${id}_sub`)}</span>
              </button>
            ))}
          </div>
          {/* Says which acts count, because the answer is not obvious and the reason is
              not arbitrary: a Hive user's vote never touches this server, so a goal fed
              by votes would be completable by lite users and not by them. */}
          <p className="mt-2 font-sans text-[12px] leading-snug text-[#9ca3af]">{t('retention.today.goal_hint')}</p>

        </div>
      ) : null}
    </section>
  );
}
