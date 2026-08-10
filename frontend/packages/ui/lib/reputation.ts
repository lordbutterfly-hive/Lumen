/**
 * Calculates human-readable reputation score from Hive blockchain reputation value.
 *
 * The reputation on Hive blockchain is stored as a large number that needs to be
 * converted to a human-readable score (typically between -25 and 75+).
 *
 * Formula: reputation = (log10(abs(raw_reputation)) - 9) * 9 + 25
 *
 * ★ IT ROUNDS. IT USED TO FLOOR, AND THAT WAS OFF BY ONE AGAINST hive.blog FOR ABOUT
 * HALF OF ALL ACCOUNTS (owner, 2026-08-09, observed directly on the site: the badge
 * shows 80 for a reputation of 79.77, and the hover shows 79.77).
 *
 * This is not cosmetic and it is not local to one surface. `accountReputation` is the
 * app's ONLY reputation formatter — the feed byline (`post-list-item.tsx`), the author
 * hover popover (`user-popover-card.tsx`, `popover-card-data.tsx`) and the legacy
 * profile chrome all call it — so every one of them printed a number one lower than
 * hive.blog whenever the fractional part was at or above .5. The correct fix is here
 * rather than at any call site, because the alternative is a profile badge reading 80
 * next to a byline reading 79 for the same person on the same page.
 *
 * Hivemind's `bridge.get_profile` returns reputation ALREADY converted (e.g. 79.77),
 * which is why the `isHumanReadable` branch exists: it detects a pre-converted value
 * and formats it instead of running log10 over a number that is not raw. Keep that
 * branch — the two code paths must agree, and they only do if both round.
 *
 * For the precise value behind the badge (the hover), use `accountReputationPrecise`.
 *
 * @param input - Raw reputation from the blockchain, or an already-converted score
 * @returns Human-readable reputation score, rounded to the nearest integer
 *
 * @example
 * accountReputation('95832978796820') // 72
 * accountReputation(79.77)            // 80  (was 79 before 2026-08-09)
 * accountReputation(0)                // 25  (default for new accounts)
 * accountReputation(-1000000000)      // negative score
 */
const isHumanReadable = (input: number): boolean => {
  return Math.abs(input) > 0 && Math.abs(input) <= 100;
};

/** The score as a real number, before rounding. Shared by both exports. */
const reputationScore = (input: string | number): number => {
  const value = typeof input === 'string' ? Number(input) : input;

  // Already converted by hivemind (or by us): pass it through untouched.
  if (isHumanReadable(value)) return value;

  if (!Number.isFinite(value) || value === 0) return 25;

  const neg = value < 0;
  let level = Math.log10(Math.abs(value));
  level = Math.max(level - 9, 0);
  if (neg) level *= -1;
  return level * 9 + 25;
};

export const accountReputation = (input: string | number): number => {
  return Math.round(reputationScore(input));
};

/**
 * The same score with decimals kept — what hive.blog reveals on hover.
 *
 * Two places must not use this: anywhere the integer badge is drawn (they would
 * disagree), and anywhere a number is compared for equality. It exists so a tooltip
 * can be more precise than the badge without either of them being wrong.
 *
 * `decimals` defaults to 2 because that is the precision hivemind itself publishes;
 * asking for more would invent digits.
 */
export const accountReputationPrecise = (input: string | number, decimals = 2): string => {
  const score = reputationScore(input);
  return score.toFixed(decimals);
};

export default accountReputation;
