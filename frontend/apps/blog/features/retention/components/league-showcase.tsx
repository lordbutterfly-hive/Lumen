'use client';

import { Link } from '@hive/ui';
import { Popover, PopoverContent, PopoverTrigger } from '@ui/components/popover';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useTranslation } from '@/blog/i18n/client';
import { ManabarRing } from '@/blog/features/layouts/site-header/manabar-ring';
import { LeagueEmblem } from '../emblems/league-emblem';
import { TIERS } from '../lib/tiers';
import { type RetentionSummaryResponse } from '../hooks/use-retention';
import { useViewerRetention } from '../hooks/use-viewer-retention';
import { useAccountRankCopy, useRankNaming, useRankProgress } from './rank-scale';
import { RetentionStats } from './retention-stats';
import { RetentionFeedback } from './retention-feedback';
import { StreakFlame } from './streak-flame';

// The navbar/left-rail status block: a calm emblem + thin ring + tier name.
// The ring color is the TIER core (never green/red) and its fill is
// `rank.progressToNext` — progress through the BINDING arm's band, i.e. the one
// thing that actually has to move for the next rank. It deliberately does NOT
// draw `rank.standing`; see the note at `ringPct` for the measurement that
// retired that. Click opens a Radix popover
// card with the big emblem, the rank AND ITS SCALE, the facts behind it, and a
// way through to the full ladder. Rendered only when logged in.
//
// ★ 2026-08-08, owner: "right now i see beacon 4. no idea what that is, what it
// does, how it works... theres nothing telling me how many levels there are."
// Three changes here, all from that one sentence:
//   1. the rank never appears without its position — "rank 6 of 9" sits under
//      the name in the rail and beside it in the popover;
//   2. the division roman numeral is GONE (it was the "4" that read as a level
//      and counted backwards inside a tier nobody could place);
//   3. the popover says what the rung MEANS, what gets you off it, shows the
//      real numbers behind it, and links to /ranks — so the block answers "what
//      is this" where it is, rather than in a FAQ nobody opens.
//
// PRODUCT DECISION (2026-07-30, FRONTEND-REMAINING-2026-07-30.md row 1.3): the
// HABIT layer (Level/XP/daily-tasks) has no real backend — `use-retention.ts`
// only overwrites `streakDays`/`activeWeeks` from the server, the rest is
// `mockSummary()`'s hardcoded constants for every user, forever. Rather than
// invent an XP economy, that entire layer is hidden here (Lv pill, EXP bar,
// Daily 5 checklist all removed from this component) until a real task ledger
// exists. `exp-bar.tsx` / `daily-tasks-popover-content.tsx` are kept, unused,
// for that future wiring — do not re-add them without a real data source.

export function LeagueShowcase() {
  const { user } = useUserClient();
  // ★ WHICHEVER LADDER APPLIES TO THIS VIEWER. A lite account has no chain
  // tenure, so the chain route can never answer for it — but the Lumen-native
  // ladder can, and used to be fetched by nothing at all. See
  // use-viewer-retention.ts.
  const { summary } = useViewerRetention();

  // Headless; renders no DOM. Mounted here rather than threaded through a layout
  // somebody else owns, and deliberately OUTSIDE the guard below: a lite account
  // has no league block to show and is exactly who the feedback moments are for.
  if (!user.isLoggedIn || !summary) return <RetentionFeedback />;

  return (
    <>
      <RetentionFeedback />
      <ShowcaseBlock summary={summary} />
    </>
  );
}

/** Split out so the rank hooks never sit behind the guard above. */
function ShowcaseBlock({ summary }: { summary: RetentionSummaryResponse }) {
  const { t } = useTranslation('common_blog');
  const { rank, streakDays } = summary;
  const { name, scale } = useRankNaming(rank.tier);
  // This popover is ALWAYS the signed-in reader's own standing (useViewerRetention
  // above), so the voice is 'own'.
  const { meaning, kind } = useAccountRankCopy(summary, 'own');
  const progress = useRankProgress(summary);
  const core = TIERS[rank.tier].color.core;
  // ★ 2026-08-08: this drew `rank.standing`, and a ring around a rank emblem
  // reads as "progress toward the next rank". `standing` is not that — it is a
  // weighted AVERAGE of the three arms (0.55 engagement + 0.25 active weeks +
  // 0.20 tenure) while the rank itself is the MIN of them. The two disagree
  // whenever one arm lags, which is the normal case: measured live on
  // @blocktrades, the ring showed **65%** while honest progress on the binding
  // arm was **25%** — a 40-point overstatement of progress that does not exist.
  // Worse at the bottom: an old dormant account saturates the tenure arm and
  // gets a 20%-full ring while pinned at rung 1 by an arm sitting at zero.
  //
  // `progressToNext` is progress through the BINDING arm's band — the arm that
  // actually has to move — and `types.ts` already calls it "the honest progress
  // number". Use it. `standing` stays on the wire; it is a composite score and
  // must never again be rendered as a progress affordance.
  //
  // ★ AND IT CAN NOW ACTUALLY FILL. Under the reputation proxy this ring was
  // ceiling-limited: an account pinned at the top awardable rung had a bar that could
  // never complete, which is why the file used to carry two ceiling hooks and a
  // branch to explain it. Every arm is reachable now, so the ring means what a ring
  // means.
  //
  // ★ AND IT DRAWS `drawnPct`, WHICH IS `pct` WITH A PAINT FLOOR. Landing on a rung puts
  // the reader at 0% of the next band, so a bare `pct` renders as a completely empty track
  // — which a tester read as "it failed to load" rather than "just arrived". The true
  // figure goes out on `data-pct` below so nothing has to trust the paint.
  const ringPct = progress.drawnPct;
  // `streakDays` is chain-derived. There is no client "ticked today" flag any
  // more, so the flame's lit/unlit state is driven by the honest count instead.
  const streakActive = streakDays > 0;

  return (
    <li className="px-1 pb-2">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="league-showcase-trigger"
            data-pct={progress.pct}
            className="flex w-full items-center gap-2.5 rounded-xl px-[10px] py-2 text-left transition-colors hover:bg-[#f1f3f5]"
          >
            <span className="relative inline-flex shrink-0 items-center justify-center">
              <ManabarRing percentage={ringPct} color={core} size={34} thickness={3} />
              <span className="absolute inset-0 flex items-center justify-center">
                <LeagueEmblem tier={rank.tier} size="nav" />
              </span>
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-sans text-[14px] font-semibold text-[#161511]">{name}</span>
              {/* THE SCALE IS NOT OPTIONAL — a rank without it is just a word. */}
              <span
                className="truncate font-sans text-[11.5px] font-medium tabular-nums text-[#6b7280]"
                data-testid="league-showcase-scale"
              >
                {scale}
              </span>
            </span>
          </button>
        </PopoverTrigger>

        <PopoverContent
          side="right"
          align="start"
          className="w-[340px] rounded-[18px] border border-[#ebebeb] bg-white p-5 text-[#161511] shadow-lg"
        >
          <div className="flex items-center gap-3">
            <LeagueEmblem tier={rank.tier} size="popover" />
            <div className="min-w-0">
              <p className="font-sans text-[17px] font-semibold leading-tight">{name}</p>
              <p className="mt-0.5 font-sans text-[13px] font-medium tabular-nums text-[#6b7280]">{scale}</p>
              {/* The floor flag travels with the number, never separately —
                  a bare 32 where the server only proved "at least 32" is the
                  same lie the active-weeks line was fixed for. */}
              <StreakFlame
                days={streakDays}
                active={streakActive}
                isLowerBound={summary.provenance?.coverage?.streakDaysIsLowerBound === true}
                className="mt-1"
              />
            </div>
          </div>

          {meaning ? (
            <p className="mt-3.5 font-serif text-[15.5px] leading-normal text-[#3f4650]">{meaning}</p>
          ) : null}
          {/* The countable, not a paragraph of advice. Same rule as the profile card:
              a distance is only a true thing to say when something is being measured
              and there is somewhere above to go. */}
          {kind === 'progress' && progress.distance ? (
            <p
              className="mt-2 font-sans text-[13.5px] font-semibold text-[#3f4650]"
              data-testid="league-showcase-distance"
            >
              {progress.distance}
              {progress.target ? (
                <span className="font-normal text-[#6b7280]">
                  {' '}
                  {t('retention.to_next', { tier: progress.target })}
                </span>
              ) : null}
            </p>
          ) : kind === 'top' ? (
            <p className="mt-2 font-sans text-[13.5px] font-semibold text-[#3f4650]">{t('retention.at_top')}</p>
          ) : null}

          <RetentionStats summary={summary} className="mt-3.5" />

          <Link
            href="/ranks"
            className="mt-3.5 inline-block font-sans text-[13.5px] font-semibold text-[#c0392b] hover:underline"
            data-testid="league-showcase-ranks-link"
          >
            {t('retention.ranks.see_all')}
          </Link>
        </PopoverContent>
      </Popover>
    </li>
  );
}
