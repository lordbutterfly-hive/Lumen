'use client';

import { FC } from 'react';
import { useTranslation } from '@/blog/i18n/client';
import { BackAction, HoldAction, Notice } from './launch-controls';
import type { MeritumLaunchBlock } from './use-meritum-launch';
import { MagiFundingHelp } from '@/blog/features/creator-tokens/live/magi-fuel-gauge';

/**
 * STEP 3 — the terms ledger, the optional first buy, and the strike.
 *
 * ★ THE HOLD IS THE CONFIRMATION. The wizard this replaces needed a second
 * "yes, really" click because one click fired an irreversible on-chain
 * registration, and a restored draft could drop a reader onto that button
 * having never seen steps 1 or 2. A 1100ms deliberate hold is a stronger gate
 * than a second click, so there is no second dialog here — but every gate that
 * decided whether that click was even allowed is still checked, and any one of
 * them disables the hold rather than letting it buy a guaranteed on-chain
 * failure.
 */

export interface LaunchStepTermsProps {
  cap: number;
  commission: string;
  firstBuy: string;
  onFirstBuy: (value: string) => void;
  /** Why the strike is refused, or null. */
  block: MeritumLaunchBlock | null;
  blockMessage: string | null;
  /** True when a chain read failed, so a retry can be offered. */
  canRetryRead: boolean;
  onRetryRead: () => void;
  alreadyHasMarket: boolean;
  /** Set while the write is in flight, so the reader is not told to hold again. */
  pending: boolean;
  /** A redacted failure message from the last attempt, or null. */
  failure: string | null;
  onHoldBegin: () => void;
  onHoldRelease: () => void;
  onBack: () => void;
}

/**
 * Does this failure mean "you could not pay for it"? Matched on the wallet's and
 * the contract's own wording rather than a code, because the refusal can come
 * from either side — the Magi contract refusing the reserve payment, or the
 * chain refusing the call for want of resource credits.
 */
function isFundingFailure(message: string): boolean {
  return /insufficient|not enough|balance|resource credit|\brc\b|too low|cannot afford/i.test(message);
}

const LaunchStepTerms: FC<LaunchStepTermsProps> = ({
  cap,
  commission,
  firstBuy,
  onFirstBuy,
  block,
  blockMessage,
  canRetryRead,
  onRetryRead,
  alreadyHasMarket,
  pending,
  failure,
  onHoldBegin,
  onHoldRelease,
  onBack
}) => {
  const { t } = useTranslation('common_blog');

  const terms = [
    { id: 'launch', label: t('meritum_launch.term_launch_label'), value: t('meritum_launch.term_launch_value') },
    { id: 'listed', label: t('meritum_launch.term_listed_label'), value: t('meritum_launch.term_listed_value') },
    { id: 'cut', label: t('meritum_launch.term_cut_label'), value: t('meritum_launch.term_cut_value', { pct: commission }) },
    {
      id: 'supply',
      label: t('meritum_launch.term_supply_label'),
      value: t('meritum_launch.term_supply_value', { cap: cap.toLocaleString('en-US') })
    },
    { id: 'stop', label: t('meritum_launch.term_stop_label'), value: t('meritum_launch.term_stop_value') },
    /*
      ★ SAY THE IRREVERSIBLE PART OUT LOUD (2026-08-15, money council).
      The wizard this replaced required a second confirmation reading "This
      launches your token on the chain. It can't be undone." Replacing that
      click with the 1100ms hold was deliberate and is better — but the
      substitution silently dropped the WORDS as well as the dialog. A hold
      guards against an ACCIDENTAL press; it does not tell anyone what pressing
      it commits them to. The terms list explained billing, supply and wind-down
      and never once said the launch cannot be undone.
    */
    { id: 'final', label: t('meritum_launch.term_final_label'), value: t('meritum_launch.term_final_value') }
  ];

  return (
    <div className="mt-step">
      {/* One 1px gap per rule, over a line-coloured backdrop. No borders to
          double up where the list meets what is above and below it. */}
      <dl className="mt-6 flex flex-col gap-px bg-meritum-line-card">
        {terms.map((term) => (
          <div key={term.id} className="flex flex-wrap items-baseline gap-x-[22px] gap-y-1.5 bg-meritum-card px-0.5 py-[15px]">
            <dt className="flex-none basis-[164px] text-label font-bold uppercase tracking-[0.13em] text-meritum-ink-3">
              {term.label}
            </dt>
            <dd className="min-w-0 flex-1 basis-60 font-serif text-14 text-meritum-ink-2">{term.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-[22px] flex flex-wrap items-center justify-between gap-[18px] rounded-2xl border border-meritum-line-card bg-meritum-rail px-5 py-[18px]">
        <div className="min-w-[min(100%,230px)] flex-1 basis-64">
          <div className="text-14 font-bold text-meritum-ink">{t('meritum_launch.first_buy_title')}</div>
          <p className="mt-1 max-w-[42ch] font-serif text-caption text-meritum-ink-muted">
            {t('meritum_launch.first_buy_body')}
          </p>
        </div>
        <div className="flex items-baseline gap-[5px]">
          <span className="font-serif text-20 text-meritum-ink-faint" aria-hidden="true">
            $
          </span>
          {/*
            ★ LOW 10 (2026-08-16) — same fix as the offer price input in
            `launch-step-offers.tsx`: the fixed `w-[84px] text-right` box
            clipped a long typed value (`999999999` rendered as `9999`, scrolled
            out of view) and left a gap between `$` and a short one
            (right-aligned text sitting at the far edge of a box wider than the
            value). `w-[10ch]` + `maxLength={9}` means the box never needs to
            scroll for anything `sanitizeMoneyInput` would let through, and
            `text-left` puts the digits right after the `$`.
          */}
          <input
            type="text"
            value={firstBuy}
            onChange={(e) => onFirstBuy(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            maxLength={9}
            aria-label={t('meritum_launch.first_buy_aria')}
            className="w-[10ch] min-w-0 border-0 bg-transparent text-left font-serif text-30 font-semibold tabular-nums text-meritum-ink outline-none placeholder:text-meritum-ink-faint"
          />
        </div>
      </div>

      {/* Every refusal says WHY, on screen. A `title` never appears on touch
          and is never read out, which is how the wizard shipped a dead control
          with its only explanation in a tooltip. */}
      {block === 'lite' ? <Notice>{t('meritum_launch.gate_lite')}</Notice> : null}
      {block === 'signed-out' ? (
        <Notice>
          {t('meritum_launch.gate_signed_out')}{' '}
          <a href="/login" className="font-semibold text-meritum-ink-link hover:underline">
            {t('meritum_launch.gate_sign_in')}
          </a>
        </Notice>
      ) : null}
      {/* Still reading the chain. Plain tone and NO retry button on purpose:
          this clears itself in a moment, and offering a retry for a request
          that is still in flight teaches the reader to hammer it. */}
      {block === 'checking-market' ? <Notice>{t('meritum_launch.gate_checking_market')}</Notice> : null}
      {canRetryRead ? (
        <Notice tone="alert">
          {t('meritum_launch.gate_unknown_market')}{' '}
          <button type="button" onClick={onRetryRead} className="font-semibold underline">
            {t('meritum_launch.gate_retry')}
          </button>
        </Notice>
      ) : null}
      {alreadyHasMarket ? (
        <Notice>
          {t('meritum_launch.gate_has_market')}{' '}
          <a href="/creators/studio" className="font-semibold text-meritum-ink-link hover:underline">
            {t('meritum_launch.gate_open_studio')}
          </a>
        </Notice>
      ) : null}
      {failure ? (
        <Notice tone="alert">
          {t('meritum_launch.failed_title')} {failure}
          {/* ★★★ A FUNDING FAILURE MUST SAY HOW TO FUND (2026-08-18, owner).
              Taking the first token yourself SPENDS: the launch buys `firstBuy`
              worth of your own market, and on Magi HBD is ALSO the resource
              credit, so a creator can fail for the cost, for the RCs, or both.
              "Launch did not go through" alone leaves them with no idea that a
              deposit is the answer, or how much to send. */}
          {isFundingFailure(failure) ? (
            <div className="mt-3">
              <p className="mb-2 text-caption">
                {firstBuy.trim() !== ''
                  ? `Your first buy costs ${firstBuy} HBD. Send that to your Magi account plus a little extra — on Magi, HBD also pays the resource credits every action needs, so deposit a bit more than the buy itself.`
                  : 'Send HBD to your Magi account before launching — on Magi, HBD also pays the resource credits that every action needs.'}
              </p>
              <MagiFundingHelp kind="hive" />
            </div>
          ) : null}
        </Notice>
      ) : null}
      {blockMessage ? (
        <p className="mt-5 text-caption font-semibold text-meritum-ink-brand" role="status">
          {blockMessage}
        </p>
      ) : null}

      <div className="mt-[26px] flex flex-wrap items-center gap-5">
        <HoldAction
          label={pending ? t('meritum_launch.hold_pending') : t('meritum_launch.hold_to_strike')}
          disabled={block !== null || pending}
          title={blockMessage ?? undefined}
          onBegin={onHoldBegin}
          onRelease={onHoldRelease}
        />
        <BackAction label={t('meritum_launch.back')} onClick={onBack} />
      </div>
    </div>
  );
};

export default LaunchStepTerms;
