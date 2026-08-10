'use client';

import { Link } from '@hive/ui';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useTranslation } from '@/blog/i18n/client';
import { LeagueEmblem } from '../emblems/league-emblem';
import { TIERS } from '../lib/tiers';
import { voiced, type RetentionVoice } from '../lib/viewer-copy';
import { type RetentionSummaryResponse } from '../hooks/use-retention';
import { useProfileRetention } from '../hooks/use-viewer-retention';
import { useAccountRankCopy, useRankNaming, useRankProgress } from './rank-scale';
import { RetentionStats } from './retention-stats';

/**
 * Profile status card: the emblem, the rank AND ITS POSITION, one line about what
 * the rung means, ONE honest progress bar with a countable beside it, then the real
 * numbers.
 *
 * ★ WHAT THIS CARD USED TO BE (2026-08-09, owner: "the text cant be written like ai
 * slop"). Roughly 180 words: a 20-word rung blurb, four fact lines including a 40-word
 * anti-farm lecture, a footnote, a heading "What's actually holding you here", THREE
 * abstract percentage meters, and a paragraph of advice telling the reader to go and
 * get read by strangers.
 *
 * ★ AND WHAT IT MEASURES NOW, HONESTLY. This claimed "~35 words", which a UX agent
 * measured against the real DOM and found to be 62 (@gtg) and 64 (@lordbutterfly). The
 * 35 was the PROSE — rung name, scale, meaning, distance — and the rest is the stats
 * block, which is text too. So: ~15 words of prose and ~45 of numbers, against 180
 * words that were almost entirely prose. The ratio is the point, not the total, and
 * quoting the smaller figure as "the card" was the kind of flattering arithmetic this
 * rewrite exists to remove.
 *
 * ★ THREE METERS BECAME ONE BAR, AND THAT IS A SMALLER CLAIM RATHER THAN LESS
 * INFORMATION. The rung is MIN(engagement, tenure, presence), so exactly one arm is
 * holding you at any moment and the other two percentages are decoration. Worse, the
 * engagement meter was measurably wrong: it drew the raw reputation proxy while the
 * rung used that proxy AFTER a breadth multiplier, overstating by up to 60%
 * (reputation 76 with 3 credited givers showed 64% where the arm sat at 27%). One
 * bar on the binding arm, plus "12 more people", says the true thing in less space.
 *
 * ★ AND THE ADVICE IS GONE. "Get read by people who don't already know you" is the
 * platform handing the reader its own job. The count replaces it.
 *
 * NOTHING HERE MARKS A DEMOTION. If the rank has dropped, this card shows the lower
 * rung with the same neutral copy every rung gets. No arrow, no "you've fallen", no
 * colour change. That is the entire demotion design.
 */

export interface ProfileLeagueCardProps {
  username: string;
  /** False for a Lumen lite account: it has no chain tenure to look up. */
  chainAccount?: boolean;
  className?: string;
}

export function ProfileLeagueCard({ username, className, chainAccount = true }: ProfileLeagueCardProps) {
  // A lite profile HAS a rank (the Lumen-native ladder), but only its owner may
  // read it — see useProfileRetention. Before this, `chainAccount: false` meant
  // "no rank exists", which was never true; it meant "the chain cannot answer".
  const { data: summary } = useProfileRetention(username, chainAccount);
  // ★ WHOSE PROFILE IS THIS, REALLY. Every second-person string on this card was
  // rendering on strangers' profiles and to signed-out readers — "{{count}} people
  // have engaged with your posts" on somebody else's page, seen by a tester on 4 of
  // 4 accounts. Names are lowercased upstream, and a signed-out reader is never the
  // owner.
  const { user } = useUserClient();
  const voice: RetentionVoice =
    user.isLoggedIn && user.username.toLowerCase() === (username || '').toLowerCase() ? 'own' : 'other';
  if (!summary) return null;
  // Split so the rank hooks below never sit behind that guard.
  return <LeagueCardBody summary={summary} className={className} voice={voice} />;
}

function LeagueCardBody({
  summary,
  className,
  voice
}: {
  summary: RetentionSummaryResponse;
  className?: string;
  voice: RetentionVoice;
}) {
  const { t } = useTranslation('common_blog');
  const tier = summary.rank.tier;
  const naming = useRankNaming(tier);
  // Not the rung's generic meaning: this card has an account in hand, so it asks
  // about the account — specifically whether "nobody has found you yet" is true of
  // it, or whether it is an old account that has gone quiet.
  const copy = useAccountRankCopy(summary, voice);
  const progress = useRankProgress(summary);
  const { core, glow } = TIERS[tier].color;

  return (
    <section
      className={`rounded-[18px] border border-[#ebebeb] bg-white p-6 ${className ?? ''}`}
      data-testid="profile-league-card"
      data-voice={voice}
      data-standing={copy.kind}
    >
      <div className="flex items-center gap-4">
        <LeagueEmblem tier={tier} size="profile" />
        <div className="min-w-0">
          <h2 className="font-sans text-[22px] font-semibold leading-tight text-[#161511]">{naming.name}</h2>
          {/* THE SCALE, ALWAYS. A rung name without it is just a word. */}
          <p
            className="mt-1 font-sans text-[14px] font-medium tabular-nums text-[#6b7280]"
            data-testid="profile-league-scale"
          >
            {naming.scale}
          </p>
          {copy.meaning ? (
            <p className="mt-2 max-w-[420px] font-serif text-[15.5px] leading-normal text-[#3f4650]">
              {copy.meaning}
            </p>
          ) : null}
        </div>
      </div>

      {/* ── The bar and the countable ────────────────────────────────────────
          Only for the cases where a distance is a true thing to state. An old
          silent account is not on its way up, and a blank account has nothing
          being measured, so both get their sentence and no bar. */}
      {copy.kind === 'progress' ? (
        <div className="mt-5" data-testid="profile-league-progress" data-pct={progress.pct}>
          {/* ★ THE TRUE PERCENTAGE IS ON THE ELEMENT; THE FLOOR IS ONLY ON THE WIDTH.
              See useRankProgress: 0% into a band is the ordinary case and an empty bar
              was being read as a load failure, which made the whole card read as broken.
              `aria-valuenow` carries the real figure so a screen reader is never told the
              rendered lie, and `data-pct` lets a test assert on the value rather than on
              the paint. */}
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-[#f1f3f5]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.pct}
            aria-label={progress.distance}
          >
            <div
              className="h-full rounded-full transition-[width] duration-500 ease-out"
              style={{ width: `${progress.drawnPct}%`, background: `linear-gradient(90deg, ${core}, ${glow})` }}
            />
          </div>
          {/* The countable, with the arm named in the noun: "4 more ACTIVE weeks", not
              "4 more weeks", which left a tester guessing it meant posting. */}
          <p
            className="mt-2 font-sans text-[14px] font-semibold text-[#3f4650]"
            data-testid="profile-league-distance"
          >
            {progress.distance}
            {progress.target ? (
              <span className="font-normal text-[#6b7280]"> {t('retention.to_next', { tier: progress.target })}</span>
            ) : null}
          </p>
        </div>
      ) : copy.kind === 'blank' ? (
        <p className="mt-4 font-sans text-[14px] text-[#6b7280]" data-testid="profile-league-blank">
          {t(voiced('retention.blank', voice))}
        </p>
      ) : copy.kind === 'top' ? (
        <p className="mt-4 font-sans text-[14px] font-semibold text-[#3f4650]" data-testid="profile-league-top">
          {t('retention.at_top')}
        </p>
      ) : null}

      {/* The numbers the route computes and nothing used to show. */}
      <RetentionStats summary={summary} className="mt-5" voice={voice} />

      <Link
        href="/ranks"
        className="mt-5 inline-block font-sans text-[14px] font-semibold text-[#c0392b] hover:underline"
        data-testid="profile-league-ranks-link"
      >
        {t('retention.ranks.see_all')}
      </Link>
    </section>
  );
}
