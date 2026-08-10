'use client';

import { useTranslation } from '@/blog/i18n/client';
import { TIERS, TIER_ORDER, TOTAL_RANKS, rankNumber } from '../lib/tiers';
import {
  isDormant,
  standingLineKind,
  voiced,
  type RetentionVoice,
  type StandingLineKind
} from '../lib/viewer-copy';
import type { RetentionSummaryResponse } from '../hooks/use-retention';
import type { LeagueTier } from '../types';

/**
 * ★ NEVER SHOW A RANK WITHOUT ITS SCALE (owner ruling, 2026-08-08).
 *
 * Verbatim complaint: "right now i see beacon 4. no idea what that is, what it
 * does, how it works... theres nothing telling me how many levels there are."
 * A bare rung name is a word, not a position — "Beacon" tells you nothing unless
 * you already know the ladder. Every surface that names a rank names where it sits
 * too: `Beacon · rank 6 of 9`.
 *
 * Everything here comes from lib/tiers.ts (TIER_ORDER / TOTAL_RANKS / rankNumber),
 * never from a hardcoded list of names or a hardcoded 9, so the ladder can be
 * renamed or resized without touching a single surface. It was renamed on
 * 2026-08-09 and no component needed an edit.
 *
 * ★ THE CEILING SUBSYSTEM IS GONE FROM THIS FILE (2026-08-09).
 *
 * It used to export `useLadderCeiling`, `useLadderCeilingNotice`, `isAtCeiling` and
 * a `LadderCeiling` type — ~120 lines whose entire job was to explain why three of
 * the nine rungs could not be awarded to anybody. They could not be awarded because
 * the engagement arm was a reputation proxy that saturated below the top band.
 * The arm is measured now, every rung is reachable, and there is nothing left to
 * apologise for. If you are looking for that code because a rung seems unreachable,
 * the answer is in `ENGAGEMENT_ARM` (compute-league.ts), which is a table of real
 * numbers you can read.
 *
 * Divisions are gone from the model (types.ts) and are rendered nowhere.
 */

export interface TierScale {
  /** The rank number, 0..9. Identical to the TIER_ORDER index since rank 0 was added. */
  position: number;
  /** How many rungs there are in total. */
  total: number;
}

export function tierScale(tier: LeagueTier): TierScale {
  // ★ NO `+ 1` ANY MORE. Index used to be rank-1 (index 0 = rank 1); rank 0 exists now, so the
  // index IS the rank. Leaving the increment would have printed "rank 1 of 9" for an unranked
  // account — the precise claim this change exists to stop making.
  const idx = TIER_ORDER.indexOf(tier);
  return { position: idx >= 0 ? idx : rankNumber(tier), total: TOTAL_RANKS };
}

export interface RankNaming extends TierScale {
  /** Translated rung name, e.g. "Beacon". */
  name: string;
  /** Translated scale, e.g. "rank 6 of 9". */
  scale: string;
}

/** The one place rung naming + scale copy is resolved. */
export function useRankNaming(tier: LeagueTier): RankNaming {
  const { t } = useTranslation('common_blog');
  const { position, total } = tierScale(tier);
  return {
    position,
    total,
    name: t(TIERS[tier].labelKey),
    scale: t('retention.scale', { position, total })
  };
}

/**
 * What a rung MEANS — one line, and only for the /ranks listing, where there is no
 * account in hand to be specific about.
 *
 * The companion `escape` string this used to return is deleted. There were nine of
 * them, they were instructions, and they are replaced by `useRankProgress` below,
 * which prints a number instead of telling somebody to go and do something.
 */
export function useRankMeaning(tier: LeagueTier): string {
  const { t } = useTranslation('common_blog');
  return t(TIERS[tier].blurbKey, { defaultValue: '' });
}

export interface RankProgress {
  /** 0..100 through the binding arm's band. THE TRUE VALUE — publish it, don't draw it. */
  pct: number;
  /**
   * The width to actually paint, which is `pct` except that a non-top rung never paints
   * as literally empty.
   *
   * ★ WHY THERE ARE TWO NUMBERS (2026-08-09). Landing on a rung puts you at 0% of the
   * next band, and 0% is the NORMAL case, not an edge case — a tester on @gtg (Aurora,
   * 19 active weeks, next rung at 23) read the empty bar as "it failed to load", and
   * therefore read the whole card as broken. An empty bar communicates a failure state; a
   * thin stub communicates "just arrived here", which is the truth.
   *
   * This is a floor on the RENDERED WIDTH ONLY, never on the value: `pct` stays exact and
   * goes out on `data-pct` and `aria-valuenow`, and the countable beside the bar ("4 more
   * active weeks") is what a reader actually reads the distance from. A bar that lied
   * about its number would be the reputation-proxy meter all over again.
   */
  drawnPct: number;
  /**
   * "12 more people" — the countable, already pluralised and translated. '' at the
   * top of the ladder, where there is no distance to state.
   */
  distance: string;
  /**
   * The rung that distance actually buys, or '' when it does not provably buy one.
   *
   * `nextTierGuaranteed` is false when two arms sit on the same lowest index:
   * filling one leaves the other binding, so "12 more people → Beacon" would
   * promise something the MIN cannot deliver. The count stays; the arrow goes.
   * This is "you cannot out-post a missing one", rendered.
   */
  target: string;
}

/**
 * The bar and the number beside it — the whole of what used to be three abstract
 * percentage meters plus a paragraph.
 *
 * ★ IT DRAWS `progressToNext`, NEVER `standing`. A ring or bar around a rank reads
 * as "progress toward the next rank". `standing` is not that — it is a weighted
 * AVERAGE of the three arms while the rank itself is the MIN of them, so the two
 * disagree whenever one arm lags, which is the normal case. Measured live on
 * @blocktrades: the ring showed 65% while honest progress on the binding arm was
 * 25%, a 40-point overstatement of progress that did not exist. `standing` stays on
 * the wire as a composite score and must never again be rendered as a progress
 * affordance.
 */
/** The smallest bar that reads as "a bar with a little in it" rather than "empty". */
export const MIN_DRAWN_PCT = 4;

export function useRankProgress(summary: RetentionSummaryResponse): RankProgress {
  const { t } = useTranslation('common_blog');
  const { rank } = summary;
  const pct = Math.max(0, Math.min(100, Math.round(rank.progressToNext * 100)));

  if (rank.remainingToNext === null || !rank.nextTier) {
    return { pct, drawnPct: pct, distance: '', target: '' };
  }

  return {
    pct,
    // The floor applies only when there IS a distance left to travel — at the top of the
    // ladder (the branch above) a full or empty bar is not being read as progress at all.
    drawnPct: Math.max(pct, MIN_DRAWN_PCT),
    // ★ THE UNIT NAMES THE ARM (2026-08-09). This used to render "4 more weeks", and a
    // tester's note was "four more weeks of WHAT? I'd have guessed posting." `weeks` now
    // reads "4 more active weeks" in the string itself — one word, no tooltip, no second
    // sentence. An explanatory aside was drafted here and cut: the copy budget test caught
    // that the drafted tooltips averaged 21 words against a shipped voice of under 5, and
    // the reader's actual question is answered by the noun.
    // `count` on purpose: i18next needs it to pick the singular, and "1 more people"
    // is exactly the kind of detail that makes a number look automated.
    distance: t(`retention.distance.${rank.armUnit}`, { count: rank.remainingToNext }),
    target: rank.nextTierGuaranteed ? t(TIERS[rank.nextTier].labelKey) : ''
  };
}

export interface AccountRankCopy {
  /** What this rung means FOR THIS ACCOUNT — dormancy-aware. */
  meaning: string;
  /** Which case the standing slot is in, for tests and testids. */
  kind: StandingLineKind;
  /** The account is old and absent, not new. */
  dormant: boolean;
}

/**
 * Copy for a REAL account, in the right voice.
 *
 * `useRankMeaning` above answers "what does this RUNG mean" — the right question for
 * the /ranks listing, where there is no account in hand. It is the wrong question on
 * a profile, and shipping the same answer on both produced two of the three defects
 * a tester found on 2026-08-08: @null (created 2016, zero posts ever) was told
 * "Every single person you admire on here started exactly where you are."
 */
export function useAccountRankCopy(
  summary: RetentionSummaryResponse,
  voice: RetentionVoice
): AccountRankCopy {
  const { t } = useTranslation('common_blog');
  const tier = summary.rank.tier;
  const coverage = summary.provenance?.coverage;
  const windowWeeks = coverage?.windowWeeks ?? 26;

  // Dormancy reads the Hive tenure YEAR now, not the deleted tenure arm — see isDormant. Hive
  // age no longer buys rank, but it still decides whether silence reads as "new" or "gone quiet".
  const dormant = isDormant({
    tenureYear: summary.tenureYear ?? 0,
    nowYear: new Date().getUTCFullYear(),
    activeWeeks: summary.activeWeeks,
    commentsFeedUnavailable: coverage?.commentsFeedUnavailable === true
  });

  const kind = standingLineKind({
    dormant,
    blank: (summary.provenance?.sampled?.postsScanned ?? 0) <= 0 && summary.activeWeeks <= 0,
    remainingToNext: summary.rank.remainingToNext
  });

  return {
    kind,
    dormant,
    meaning: dormant
      ? t(voiced('retention.dormant.meaning', voice), { year: summary.tenureYear, total: windowWeeks })
      : t(voiced(TIERS[tier].blurbKey, voice), { defaultValue: '' })
  };
}
