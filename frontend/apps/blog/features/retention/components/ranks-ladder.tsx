'use client';

import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useTranslation } from '@/blog/i18n/client';
import { LeagueEmblem } from '../emblems/league-emblem';
import { TIERS, TIER_ORDER, TOTAL_RANKS } from '../lib/tiers';
import { useViewerRetention } from '../hooks/use-viewer-retention';
import type { LeagueTier } from '../types';
import { tierScale, useRankMeaning, useRankNaming, useRankProgress } from './rank-scale';
import { RetentionStats } from './retention-stats';

/**
 * ★ /ranks — THE WHOLE LADDER, ON ONE PAGE.
 *
 * Original brief (owner, 2026-08-08): "no idea what that is, what it does, how it
 * works... theres nothing telling me how many levels there are, what they do why i
 * should care."
 *
 * ★ AND THEN IT ANSWERED ALL FOUR IN 592 WORDS (owner, 2026-08-09: "the text cant be
 * written like ai slop"). What was here: a title, a 36-word subtitle, a 34-word intro,
 * three explainer cards, a 70-word ceiling apology, a 44-word section titled "What does
 * not move you. At all.", nine rungs each with a blurb AND an instruction, and a
 * 56-word paragraph about demotion.
 *
 * ★ MEASURED, NOT CLAIMED. This said "around 180 words now"; a UX agent counted the
 * real DOM and got **207** for the signed-out shell and **257** logged in with a
 * data-heavy account. So the honest figure is ~207 of chrome plus ~50 of the reader's
 * own numbers, against 592 — a bit over a third, not a third. That is the SECOND
 * flattering word count in this feature (profile-league-card.tsx claimed 35 and
 * measured 62), both from quoting the prose subtotal as if it were the surface. Nine
 * rung descriptions are most of what remains and they are the page's whole purpose, so
 * the number is defensible; quoting a smaller one was not.
 *
 * Four things were cut and each cut has a reason:
 *   - THE CEILING NOTICE. Nothing left to apologise for: the reputation proxy is gone
 *     and all nine rungs are reachable, so ~70 words of explaining why three of them
 *     were not simply do not apply.
 *   - "What does not move you. At all." (44 words). That is the system defending
 *     itself against an accusation nobody made. One line survives, as a line.
 *   - THE THREE EXPLAINER CARDS (~130 words). The subtitle already says the rank is
 *     the lowest of three numbers, which is the entire mechanism.
 *   - NINE "Way out:" INSTRUCTIONS. Replaced by one number on the reader's own row.
 *     Telling somebody to "post one thing, literally one" is homework; "1 more
 *     person" is information.
 *
 * Built entirely off TIER_ORDER, so nothing here hardcodes a name, a count or an
 * order. The ladder was renamed on 2026-08-09 and this file needed no edit.
 */

function LadderRow({ tier, current }: { tier: LeagueTier; current: boolean }) {
  const { t } = useTranslation('common_blog');
  const { name, scale } = useRankNaming(tier);
  const meaning = useRankMeaning(tier);

  return (
    <li
      data-testid={`ranks-row-${tier}`}
      data-current={current || undefined}
      className={`flex items-start gap-3.5 rounded-[14px] border p-3.5 transition-colors ${
        current ? 'border-[#161511] bg-[#faf9f6]' : 'border-[#ebebeb] bg-white'
      }`}
    >
      <span className="mt-0.5 shrink-0">
        <LeagueEmblem tier={tier} size="popover" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <h3 className="font-sans text-[18px] font-semibold leading-tight text-[#161511]">{name}</h3>
          <span className="font-sans text-[13px] font-medium tabular-nums text-[#6b7280]">{scale}</span>
          {current ? (
            <span className="rounded-full bg-[#161511] px-2 py-0.5 font-sans text-[11.5px] font-semibold uppercase tracking-[0.05em] text-white">
              {t('retention.ranks.you_are_here')}
            </span>
          ) : null}
        </div>
        {meaning ? (
          <p className="mt-1 font-serif text-[15.5px] leading-normal text-[#3f4650]">{meaning}</p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * ★ NEVER SILENT FOR A SIGNED-IN READER. This used to `return null` whenever
 * `summary` was absent — which for a lite account was ALWAYS, because the chain hook
 * is disabled for them. A person standing on the page whose entire job is to say
 * where they stand was told nothing at all. Every no-data path now says which one it
 * is.
 */
function YouAreHere() {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const { summary, isLoading, isError } = useViewerRetention();

  if (!user.isLoggedIn) {
    return (
      <p className="mt-4 font-sans text-[15px] leading-normal text-[#6b7280]" data-testid="ranks-signed-out">
        {t('retention.ranks.signed_out')}
      </p>
    );
  }
  if (!summary) {
    return (
      <p
        className="mt-4 font-sans text-[15px] leading-normal text-[#6b7280]"
        data-testid={isError ? 'ranks-position-error' : 'ranks-position-loading'}
      >
        {/* A failed read is stated, never rendered as an absent rank — an empty space
            reads as "you have no rank", which is a different and worse claim than "we
            could not work it out". And "working it out" is only said while something
            really is in flight (see ViewerRetention.isLoading): a permanent spinner
            is its own lie. */}
        {isLoading && !isError ? t('retention.ranks.loading') : t('retention.ranks.unavailable')}
      </p>
    );
  }

  return <YourPosition summary={summary} />;
}

/** Split out so `useRankProgress` never sits behind the guard above. */
function YourPosition({ summary }: { summary: NonNullable<ReturnType<typeof useViewerRetention>['summary']> }) {
  const { t } = useTranslation('common_blog');
  const { position, total } = tierScale(summary.rank.tier);
  const progress = useRankProgress(summary);
  const { core, glow } = TIERS[summary.rank.tier].color;

  return (
    <section className="mt-6 rounded-[18px] border border-[#ebebeb] bg-white p-5" data-testid="ranks-your-position">
      <div className="flex items-center gap-4">
        <LeagueEmblem tier={summary.rank.tier} size="popover" />
        <div className="min-w-0 flex-1">
          <p className="font-sans text-[12.5px] font-semibold uppercase tracking-[0.06em] text-[#9ca3af]">
            {t('retention.ranks.your_position')}
          </p>
          <p className="mt-0.5 font-sans text-[22px] font-semibold leading-tight text-[#161511]">
            {t(TIERS[summary.rank.tier].labelKey)}
            <span className="ml-2 text-[15px] font-medium tabular-nums text-[#6b7280]">
              {t('retention.scale', { position, total })}
            </span>
          </p>
        </div>
      </div>

      {/* The reader's own bar, at the TOP of the page rather than buried nine rows
          down. This is what they came for. */}
      {progress.distance ? (
        <div className="mt-4" data-testid="ranks-your-progress" data-pct={progress.pct}>
          {/* `drawnPct`, not `pct` — 0% into a band is the ordinary case and an empty bar
              reads as a load failure. The true value is on `data-pct` and `aria-valuenow`;
              see useRankProgress. */}
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
          <p className="mt-2 font-sans text-[14px] font-semibold text-[#3f4650]">
            {progress.distance}
            {progress.target ? (
              <span className="font-normal text-[#6b7280]"> {t('retention.to_next', { tier: progress.target })}</span>
            ) : null}
          </p>
        </div>
      ) : (
        <p className="mt-4 font-sans text-[14px] font-semibold text-[#3f4650]">{t('retention.at_top')}</p>
      )}

      {/* `showFootnote` is gone: the sample note is a tooltip on the one line it describes,
          so every surface carries it and none of them can drop it. This surface used to
          pass `false` and therefore showed a scope-free headcount. */}
      <RetentionStats summary={summary} className="mt-4" />
    </section>
  );
}

export default function RanksLadder() {
  const { t } = useTranslation('common_blog');
  const total = TOTAL_RANKS;
  const { summary } = useViewerRetention();
  const currentTier = summary?.rank.tier;

  return (
    <div className="mx-auto max-w-[720px] pb-16" data-testid="ranks-page">
      <header>
        <h1 className="font-sans text-[34px] font-bold leading-tight tracking-[-0.02em] text-[#161511]">
          {t('retention.ranks.title', { total })}
        </h1>
        <p className="mt-2.5 font-serif text-[17.5px] leading-normal text-[#3f4650]">
          {t('retention.ranks.subtitle')}
        </p>
      </header>

      <YouAreHere />

      {/* Floor → apex, deliberately. A ladder that opens on the apex tells the person
          at the bottom how far away they are before it tells them anything else. */}
      <ol className="mt-8 flex flex-col gap-2.5" data-testid="ranks-ladder">
        {TIER_ORDER.map((tier) => (
          <LadderRow key={tier} tier={tier} current={tier === currentTier} />
        ))}
      </ol>

      <p className="mt-6 font-sans text-[14px] leading-normal text-[#6b7280]" data-testid="ranks-wont">
        {t('retention.ranks.wont')}
      </p>

      {/* Demotion, stated once, factually, in the one place a person came to READ
          about the ladder — and nowhere else. Nothing in this app notifies, badges or
          toasts a rank going down. */}
      <p className="mt-3 font-sans text-[14px] leading-normal text-[#6b7280]" data-testid="ranks-down">
        <span className="font-semibold text-[#3f4650]">{t('retention.ranks.down_title')}</span>{' '}
        {t('retention.ranks.down_body')}
      </p>
    </div>
  );
}
