'use client';

import { LeagueEmblem } from '../emblems/league-emblem';
import { TIERS } from '../lib/tiers';
import { useProfileRetention } from '../hooks/use-viewer-retention';
import { useRankNaming } from './rank-scale';
import styles from './profile-league-chip.module.css';

/**
 * The small rank chip beside a profile's display name.
 *
 * ★ LIVES HERE, NOT IN profile-identity.tsx (owner ruling, 2026-08-08). It used
 * to be a private `LeagueChip` inside that file, rendering `Beacon IV` — the
 * exact string the owner could not decode ("i see beacon 4. no idea what that
 * is"). Owning it in the retention feature means the "never show a rank without
 * its scale" rule is enforced in ONE place instead of re-argued on every surface
 * that happens to want a rank on it.
 *
 * Renders `Beacon · rank 7 of 9`. No division numeral — divisions no longer
 * exist in the model. Nothing here marks a demotion: a lower rung renders with
 * exactly the same neutral treatment as a higher one.
 */

export interface ProfileLeagueChipProps {
  username: string;
  /** False for a Lumen lite account: it has no chain tenure to look up. */
  chainAccount?: boolean;
  className?: string;
}

export function ProfileLeagueChip({ username, chainAccount = true, className }: ProfileLeagueChipProps) {
  // A lite profile's rank exists, but only its OWNER may read it — the lite
  // route is session-scoped by construction. See useProfileRetention.
  const { data: summary } = useProfileRetention(username, chainAccount);
  if (!summary) return <ChipSkeleton className={className} />;
  return <ChipBody tier={summary.rank.tier} className={className} />;
}

/**
 * ★★★ THE LOADING STATE HOLDS THE BOX OPEN (measured, 2026-08-18).
 *
 * This component used to `return null` until `summary` arrived, then mount at full
 * height. Measured on `/@mipiano` by attributing every `layout-shift` entry to its source
 * node, that pop-in is the LARGEST layout shift on the profile page: CLS 0.074 at
 * 1400px and 0.156 at 390px, moving the reputation button and every row beneath it.
 *
 * It is the same species as the accordion-that-animated-on-mount: not an image, not a
 * font, just a component that occupies nothing and then suddenly occupies something. The
 * profile page was one of the routes the image-dimension audit kept pointing at, and an
 * image-abort A/B proved no `<img>` contributes a single pixel of it. This does.
 *
 * ★ IT RESERVES HEIGHT EXACTLY AND WIDTH APPROXIMATELY, ON PURPOSE. The height is
 * deterministic - same border, same padding, same 22px emblem, same 22px line box - so
 * the vertical push, which is the whole of the shift that moves other ROWS, goes to
 * zero. The width cannot be exact: the label is `Name · rank N of 9`, and both the tier
 * name and the word "rank" are translated, so any fixed pixel width would be wrong in
 * some locale. `12ch` is sized from the font's own character width rather than a guess in
 * pixels, so it lands close in every locale and scales if the type does.
 *
 * ★ NOT `aria-busy` OR A SPINNER. A rank chip is not information the reader asked for
 * and is not worth announcing as loading; it either turns up or it does not. The
 * placeholder is `aria-hidden` so a screen reader is told nothing at all rather than
 * being told about an empty box.
 */
function ChipSkeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="profile-league-chip-skeleton"
      className={`inline-flex items-center gap-2 rounded-card border border-transparent py-1 pl-1.5 pr-3 ${
        className ?? ''
      }`}
    >
      {/* 22px, the exact `size="nav"` emblem box (SIZE_PX.nav in league-emblem.tsx). */}
      <span className="h-[22px] w-[22px] shrink-0 rounded-full bg-surface-12" />
      <span className="h-[22px] w-[12ch] rounded-control bg-surface-12" />
    </span>
  );
}

/**
 * Illumination spec §2 ("Rank as luminosity") — the ramp, copied verbatim. Deliberately
 * a lookup, not a formula: the curve is hand-tuned to be "slow at the bottom... or the
 * lowest rank looks like a state rather than a floor", so interpolating between the
 * given points would silently redraw it. Only 1..9 are defined — rank 0 (Unranked) is
 * never looked up here; see the `lit` guard below.
 */
const RANK_LUMINOSITY: Record<number, number> = {
  1: 0.06,
  2: 0.16,
  3: 0.27,
  4: 0.38,
  5: 0.5,
  6: 0.62,
  7: 0.74,
  8: 0.87,
  9: 1
};

function ChipBody({ tier, className }: { tier: keyof typeof TIERS; className?: string }) {
  const { name, scale, position } = useRankNaming(tier);

  // ★ RANK 0 STAYS UNLIT (coordinator ruling, 2026-08-20). `position` is 0..9 — rank 0
  // (Unranked) is a real, reachable state, not a stale edge case (see the "1..9" comment
  // on `LeagueRank.rankNumber` in types.ts, which predates rank 0 and is out of date).
  // §2's ramp is defined for 1..9 only and is deliberately slow at the bottom already;
  // stretching it to cover 0 as well would put an unranked account ON the floor instead
  // of below it. So `position === 0` renders exactly as before this pass: the flat
  // `bg-surface-12` fill, no gradient, no glow, `--l` never set.
  const lit = position > 0;
  const l = lit ? RANK_LUMINOSITY[position] : 0;

  return (
    <span
      title={`${name} · ${scale}`}
      // Only the FILL changes (spec §2's own words) — `rounded-card`, the border, and the
      // padding are exactly what this chip shipped with; illumination spec §7 forbids any
      // geometry change and the coordinator's ruling repeats it for this file specifically.
      // `bg-surface-12` (flat grey) is swapped for `styles.repBadge` (the token-driven
      // gradient + glow) only when a real rank lights it; unranked keeps the flat fill.
      className={`inline-flex items-center gap-2 rounded-card border border-line-9 py-1 pl-1.5 pr-3 ${
        lit ? styles.repBadge : 'bg-surface-12'
      } ${className ?? ''}`}
      // `--l` is set inline, in the same render that adds `styles.repBadge`, straight off
      // the ramp above — never from reputation, payout or a client-side guess (spec §2).
      // `profile-league-chip.module.css` also defaults `--l: 0` on the class itself, so
      // the "class applied, `--l` unset" failure mode (see that file's header) cannot
      // occur even if a future edit adds the class somewhere that forgets this prop.
      style={lit ? ({ '--l': l } as React.CSSProperties) : undefined}
      data-testid="profile-league-chip"
    >
      <LeagueEmblem tier={tier} size="nav" />
      <span className="font-sans text-[14px] leading-[22px] font-bold text-ink-2">
        {name}
        <span aria-hidden="true" className="mx-1 font-medium text-ink-21">
          ·
        </span>
        {/* THE SCALE IS NOT OPTIONAL. A rank without it is just a word. */}
        <span className="font-medium tabular-nums text-ink-10" data-testid="profile-league-chip-scale">
          {scale}
        </span>
      </span>
    </span>
  );
}
