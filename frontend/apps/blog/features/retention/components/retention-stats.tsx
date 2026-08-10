'use client';

import { useTranslation } from '@/blog/i18n/client';
import {
  headcountOfGivers,
  postsBehindGivers,
  type RetentionSummaryResponse
} from '../hooks/use-retention';
import { voiced, type RetentionVoice } from '../lib/viewer-copy';
import { reachTrend } from '../lib/copy-select';

/**
 * ★ THE INTERESTING NUMBERS (owner ruling, 2026-08-09).
 *
 * Replaces `retention-facts.tsx`, which rendered four sentences and one of them was
 * a forty-word anti-farm lecture printed as a bullet in a stats list:
 *
 *   "1111 of them count toward your rank — votes from accounts with little stake
 *    behind them are credited only a few at a time, or a swarm of new accounts could
 *    buy a rung."
 *
 * That explanation is true and it belongs in a tooltip, not in the place a person
 * came to read a number about themselves. Everything here leads with the figure.
 *
 * WHAT IS HERE, AND WHY:
 *   people who voted on you — the engagement arm's own input, with the global blacklist
 *                         and the engagement exclusion list applied at the source
 *   people who found you this week — nothing on Hive tells anybody this
 *   feeds reached       — nor this, and it is the only figure that carries a direction
 *   busiest weekday     — free once history is stored, and quietly delightful
 *   longest streak      — a fact about you, unlike "0-day streak" which is a fact
 *                         about this week
 *
 * ★★ WHAT THIS FILE USED TO ADVERTISE AND NO LONGER SHIPS. The list above once opened
 * with "votes received — computed by the route since forever, read by nothing" and called
 * "N of M posts landed" THE SINGLE MOST USEFUL LINE ON THE PAGE. Both are deleted, and the
 * confidence of that claim is the lesson: on Hive a vote total measures trail
 * subscriptions, and the "N of M" sample could not come out any way but N of N for anyone
 * with an audience. The most useful line on the page was the one that could not vary.
 *
 * ═══ TWO HONESTY RULES, BOTH LEARNED THE HARD WAY ═══
 *
 * 1. ABSENT, NEVER ZERO. Every optional field is read with a `typeof === 'number'`
 *    guard and omitted when missing. `?? 0` would turn "we could not measure this"
 *    into "this is zero", which is a claim about the reader rather than about us.
 *
 * 2. A FLOOR IS NEVER PRINTED AS A MEASUREMENT. `activeWeeks` is clock-truncated
 *    whenever `coverage.activeWeeksIsLowerBound`, and `longestStreakDays` is a floor
 *    unless `coverage.historyComplete`. Both render "at least" / "+" forms. A daily
 *    poster since 2018 used to be served 11 of 26 weeks and shown a bare 11. A
 *    number presented tighter than it really is, is a lie with better typography.
 */

export interface StatLine {
  id: string;
  text: string;
  /** Optional explanation, shown on hover. Never inline in the line itself. */
  tooltip?: string;
  // `href` is gone with the best-post line, which was the only link a stat ever had.
}

/**
 * The numbers, in the order that matters to somebody looking at their own profile:
 * who read you, what happened to your posts, how far they travelled, then the
 * long-run facts. Any line that cannot be stated honestly is simply absent.
 */
export function useRetentionStatLines(
  summary: RetentionSummaryResponse | undefined,
  voice: RetentionVoice = 'own'
): StatLine[] {
  const { t } = useTranslation('common_blog');
  if (!summary) return [];

  const lines: StatLine[] = [];
  const provenance = summary.provenance;
  const stats = summary.stats;
  const coverage = provenance?.coverage;

  // ── Who voted on you ─────────────────────────────────────────────────────
  //
  // ★★ AND IT SAYS "VOTED", NOT "READ" (2026-08-09, found by re-deriving the number).
  // `stats.people` is built in the route as `givers.established + givers.unknown` out of
  // `getActiveVotes` — distinct accounts that pressed UPVOTE on the sampled posts, self
  // excluded. It is not, and has never been, a count of people who read anything. The
  // string here said "1237 people read you", which is a claim about a quantity this
  // product does measure — `feedsReached`, distinct viewers actually served the post in a
  // feed — and which is a DIFFERENT, smaller number. So the card had two honest figures
  // and one of them was wearing the other's label, in the friendlier direction. That is
  // the same class of error as printing a floor as a measurement, and it was introduced
  // by a copy rewrite that made the sentence warmer than the data.
  //
  // ★ A HEADCOUNT, NOT THE SCORED FIGURE. The two paths put different quantities in
  // `sampled.distinctGivers` and only one of them is a count of people; `giverTrust`
  // carries the headcount. Measured live on 2026-08-08: @blocktrades was shown
  // "1111 people have engaged with your posts" while 1,564 distinct accounts had
  // actually upvoted him. `headcountOfGivers` is the one place either path is read.
  const people = stats?.people ?? headcountOfGivers(provenance);
  if (typeof people === 'number' && people > 0) {
    // ★★ THE SAMPLE SIZE IS IN THE VISIBLE SENTENCE NOW, NOT ONLY IN THE HOVER (2026-08-09,
    // second correction to this one line).
    //
    // It said "voted on your recent posts" with `Counted across the last 2 posts` on a `title`.
    // A UX agent measured what "recent" actually spans and it is not comparable between
    // accounts: @gtg's two posts cover 143 DAYS (2026-07-18 and 2026-03-20) while @tarazkp's
    // eight cover 7 — and both feed the same 1,200-person threshold. A denominator that varies
    // by two orders of magnitude cannot live in a tooltip, and on a touch device it did not
    // exist at all.
    //
    // Pluralisation is on `count` = THE POSTS, because that is the noun that can be 1 ("your
    // last post"). The headcount rides along as `people`, and the case where the headcount
    // ITSELF is 1 gets its own key rather than rendering "1 people".
    const overPosts = stats?.peopleOverPosts ?? postsBehindGivers(provenance);
    const base = people === 1 ? 'retention.stats.people_solo' : 'retention.stats.people';
    lines.push({
      id: 'people',
      text:
        typeof overPosts === 'number' && overPosts > 0
          ? t(voiced(base, voice), { people, count: overPosts })
          : // No sample size on the wire: fall back to the count alone rather than printing
            // "your last 0 posts". Older server, not a measurement of zero.
            t(voiced(base, voice), { people, count: 1 }),
      tooltip: sampleNote(t, summary)
    });

    // The first-time-giver line. Absent until the server has watched this account
    // for longer than the window, because `first_seen` means "first seen by us" —
    // on a fresh build every giver looks new. The route enforces that; this only
    // renders what it is given.
    if (typeof stats?.newPeople === 'number' && stats.newPeople > 0) {
      // NOT voiced: "N of them for the first time this week" has no first or third person
      // in it, and the `_their` forms were byte-identical to the base — three duplicate
      // strings, counted three times against the copy budget, that no reader could ever
      // tell apart from the originals. Deleted.
      lines.push({ id: 'new-people', text: t('retention.stats.new_people', { count: stats.newPeople }) });
    }

    // ★★ THE "COUNTS TOWARD THE RANK" LINE IS DELETED, BECAUSE IT SAYS SOMETHING FALSE NOW
    // (found 2026-08-09 by a UX agent reading /ranks and the profile together: "/ranks says
    // `Not votes` then `915 of them count toward the rank`").
    //
    // It rendered "915 of them count toward the rank." and existed for a good reason — the
    // headcount and the trust-budgeted figure differ on every real account (1564/1111, 683/543,
    // 397/290), and printing the larger one alone invited the conclusion that the page inflates.
    // But votes no longer buy a rank AT ALL: the ladder is observed active days. So the line
    // disclosed a discrepancy in a number that feeds nothing, while directly contradicting the
    // explainer page. `credited_why`, its tooltip, goes too.
    //
    // The exclusion note it partly duplicated survives on the headcount's own tooltip
    // ("Curation bots and blacklisted accounts excluded"), which is where a reader comparing
    // our figure with hive.blog's actually looks.
  }

  // ════ THE VOTE-AMOUNT LINES ARE GONE (owner ruling, 2026-08-09) ════
  //
  // "vote amounts dont matter, theyre all botted." And: "you cant list votes and comments
  // and not have it for all time. if thats the case then drop it."
  //
  // Deleted here and on the wire: `votes` / `votes_at_least` (votesReceived), `best-post`
  // (bestPostVotes), and `posts-landed` (postsRead + postsWithEngagement). This block also
  // used to carry a long note explaining that all three were VOLATILE between reads —
  // measured on @tarazkp at 86,324 -> 24,528 -> 115,781 across 35 minutes with no new
  // posts — and "fixed" it with the words "at least". That was the wrong repair twice
  // over: the number is botted whatever its phrasing, and an honest floor on a meaningless
  // quantity is still a meaningless quantity taking up a line.
  //
  // The footnote went with them, and that is the important half. It read "Counted across
  // the last 8 posts" and sat BELOW a votes figure summed over hundreds of posts, so one
  // caveat named the denominator of one line and appeared to name the denominator of all
  // of them. @tarazkp read: "1731 people voted on their posts." + "At least 115800 votes
  // received." + "Counted across the last 8 posts." — arithmetic ceiling 1731 x 8 =
  // 13,848, against a claim of 115,800. Three numbers with no reading under which all
  // three are true. Scope now lives in the sentence it belongs to, per line.

  // ★ THE ONE LINE THAT CARRIES A DIRECTION (2026-08-09). "Every number is a single
  // frozen figure — no up from last week, nothing to compare against" was the clearest
  // structural gap a UX tester named, and reach is the only figure on this card whose
  // history we genuinely hold: `lumen_feed_served.served_at` lets the route count the
  // preceding window from the same scan.
  //
  // The trend renders ONLY when the previous window is present AND above zero. `prev`
  // absent means the route judged it untrustworthy (a young table makes every account
  // look like it is exploding — the `newPeople` failure), so the frozen figure is the
  // honest fallback rather than a fabricated rise.
  // The direction is a SUFFIX on the existing sentence, not a second phrasing of it. Nine
  // rewritten variants were drafted and cut: the copy-budget test showed them adding ~100
  // words to say what six short ones say, and "no change" says it best by saying nothing.
  if (typeof stats?.feedsReached === 'number' && stats.feedsReached > 0) {
    const trend = reachTrend(stats.feedsReached, stats.feedsReachedPrev);
    const headline = t('retention.stats.feeds', { count: stats.feedsReached });
    lines.push({
      id: 'feeds',
      text: trend.key ? `${headline} ${t(trend.key, { count: trend.count })}` : headline
    });
  }

  // ── WHAT KIND OF ACCOUNT THIS IS ─────────────────────────────────────────
  //
  // ★ THE MOST READABLE FACT ON THE CARD, and it was being thrown away at a merge. The route
  // walks the posts feed and the replies feed separately and then unions them into a day set;
  // the split between the two is free and it is identity-defining. Most people are certain
  // which one they are and most are wrong.
  //
  // ★ A RATIO, NEVER THE COUNTS. The underlying figures are 26-week counts and a windowed
  // count of comments may not be printed at all ("you cant list votes and comments and not
  // have it for all time"). A ratio is a shape, not a total, and it is stable whatever the
  // window — which is exactly why it is the honest thing to show. A near-1 ratio says so
  // rather than rounding to a fake asymmetry.
  const p = stats?.postsInWindow;
  const r = stats?.repliesInWindow;
  if (typeof p === 'number' && typeof r === 'number' && p + r >= 8) {
    const ratio = r >= p ? (p > 0 ? r / p : r) : p > 0 && r > 0 ? p / r : p;
    const rounded = Math.round(ratio);
    // `_one` is worded as "about equally", so a ratio that rounds to 1 states the symmetry
    // instead of claiming a 1x asymmetry, which would be a sentence with no content.
    // ★ VOICELESS, deliberately. It shipped with `_their` variants and they were cut: a
    // label-style sentence ("Replies 4x for every post.") is correct on your own profile AND
    // on a stranger's, exactly like "Longest streak: 9+ days." above it. Six strings instead
    // of twelve, and one fewer place for the voice to leak onto somebody else's page.
    lines.push({
      id: 'voice',
      text: t(r >= p ? 'retention.stats.replier' : 'retention.stats.poster', { count: Math.max(1, rounded) })
    });
  }

  // ── The long run ─────────────────────────────────────────────────────────
  if (typeof stats?.busiestWeekday === 'number') {
    lines.push({
      id: 'weekday',
      text: t(voiced('retention.stats.weekday', voice), {
        day: t(`retention.weekday.${stats.busiestWeekday}`)
      })
    });
  }

  const weeks = summary.activeWeeks;
  const windowWeeks = coverage?.windowWeeks ?? 26;
  if (typeof weeks === 'number' && weeks > 0) {
    // Absent provenance cannot prove the walk completed, so the floor phrasing is
    // the safe default rather than the exception.
    //
    // ★ EXCEPT AT THE CEILING, WHERE A FLOOR IS NOT A FLOOR (found 2026-08-09 by a UX
    // agent, verbatim: "Active at least 26 of the last 26 weeks"). "At least N of N" is a
    // sentence that hedges a maximum: there is no larger value it could be hiding, so the
    // hedge conveys nothing except that the writer was not paying attention. The exact
    // form is not a stronger claim here, it is the SAME claim in fewer words.
    const atCeiling = weeks >= windowWeeks;
    const isLowerBound = (provenance ? coverage?.activeWeeksIsLowerBound !== false : true) && !atCeiling;
    lines.push({
      id: 'weeks',
      text: isLowerBound
        ? t('retention.stats.weeks_at_least', { weeks, total: windowWeeks })
        : t('retention.stats.weeks', { weeks, total: windowWeeks })
    });
  }

  if (typeof stats?.longestStreakDays === 'number' && stats.longestStreakDays > 1) {
    // A floor unless the whole history is stored: a personal record computed from
    // six months of history is not a personal record.
    const complete = coverage?.historyComplete === true;
    lines.push({
      id: 'longest',
      text: complete
        ? t('retention.stats.longest', { count: stats.longestStreakDays })
        : t('retention.stats.longest_floor', { count: stats.longestStreakDays })
    });
  }

  // ★ DAYS LUMEN WATCHED YOU SHOW UP — the rank's own input, so the card cannot disagree with
  // itself. It used to be every stored act-day including back-walked Hive history, which put "94+
  // days" five lines under "Nothing measured yet."
  //
  // ★ AND NO "+" FLOOR ANY MORE. The floor existed because the walk truncates, so a stored day
  // count was a lower bound on real history. This is not a claim about history: it is a count of
  // days we OBSERVED, and we either observed a day or we did not. Printing "0+" would hedge a
  // number that has nothing to hedge.
  if (typeof stats?.activeDaysTotal === 'number' && stats.activeDaysTotal > 0) {
    lines.push({ id: 'active-days', text: t('retention.stats.active_days', { count: stats.activeDaysTotal }) });
  }

  // The longest silence. Published by the route only when the history is complete, because a
  // missing day inside a truncated walk is a hole in what was read and not a day off.
  if (typeof stats?.longestGapDays === 'number' && stats.longestGapDays > 1) {
    lines.push({ id: 'quiet', text: t('retention.stats.quiet', { count: stats.longestGapDays }) });
  }

  if (summary.tenureYear) {
    // ★ NAME THE RIGHT NETWORK. A lite account has no Hive account at all — that is
    // the definition of the tier — so "On Hive since 2026" is a fact about a chain
    // the reader is not on. The provenance discriminant exists for this branch.
    lines.push({
      id: 'tenure',
      text:
        provenance?.source === 'lumen'
          ? t('retention.stats.since_lumen', { year: summary.tenureYear })
          : t('retention.stats.since', { year: summary.tenureYear })
    });
  }

  return lines;
}

/**
 * How the people-count was obtained — attached to the claim, not printed under the card.
 *
 * ★ IT WAS A STANDALONE FOOTNOTE UNTIL 2026-08-09, and that is precisely how three
 * numbers with three different denominators came to share one caveat. It is now the
 * `title` on the ONE line it actually describes.
 *
 * ★ `overPosts`, NOT `postsScanned`. `postsScanned` is how deep the FEED WALK went (the
 * input to active-weeks) while the voters were read from `overPosts` posts and only those.
 * The footnote once told @acidyo "Counted across your last 160 posts" for a figure taken
 * from three. `postsBehindGivers` is the one place either path is read.
 *
 * Takes `t` rather than calling `useTranslation` so it is a plain function called from
 * inside another hook, not a second hook with its own ordering rules.
 */
function sampleNote(
  t: (key: string, vars?: Record<string, unknown>) => string,
  summary: RetentionSummaryResponse | undefined
): string | undefined {
  // `stats.peopleOverPosts` is the route's own answer and the preferred source; the
  // provenance reader stays as the fallback for a server predating it.
  const posts = summary?.stats?.peopleOverPosts ?? postsBehindGivers(summary?.provenance);
  if (typeof posts !== 'number' || posts <= 0) return undefined;
  // The chain path SAMPLES recent posts under a time budget; the lumen path reads
  // every post the account has. "the last N posts" implies a sample, so the path
  // that took no sample says so instead.
  const scope =
    summary?.provenance?.source === 'lumen'
      ? t('retention.stats.footnote_all', { count: posts })
      : t('retention.stats.footnote', { count: posts });
  // ★ AND THE EXCLUSIONS ARE STATED, on the one line they change. A reader comparing this
  // headcount against what hive.blog shows them will find ours LOWER, and a number that is
  // quietly smaller than the number next door looks broken unless it says why. The chain
  // path is the only one that reads Hive voters at all, so the lumen ladder does not claim
  // an exclusion it never had to make.
  return summary?.provenance?.source === 'lumen' ? scope : `${scope} ${t('retention.stats.bots_excluded')}`;
}

export interface RetentionStatsProps {
  summary: RetentionSummaryResponse | undefined;
  className?: string;
  /**
   * Second person ONLY when the viewer is the account owner. Defaults to 'own'
   * because the two viewer-side surfaces (left-rail popover, /ranks) are always
   * about the signed-in reader; the profile card is the one that must pass it, and
   * it is the one that was wrong.
   */
  voice?: RetentionVoice;
}

export function RetentionStats({ summary, className, voice = 'own' }: RetentionStatsProps) {
  const lines = useRetentionStatLines(summary, voice);
  if (lines.length === 0) return null;

  return (
    <div className={className} data-testid="retention-stats">
      <ul className="flex flex-col gap-1">
        {lines.map((line) => (
          <li
            key={line.id}
            className="font-sans text-[14px] leading-snug text-[#3f4650]"
            data-testid={`retention-stat-${line.id}`}
            // A native title, deliberately: this is a one-sentence aside on a
            // number, and pulling in a positioned tooltip primitive for it would
            // put the explanation back in front of the reader.
            title={line.tooltip}
          >
            {line.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
