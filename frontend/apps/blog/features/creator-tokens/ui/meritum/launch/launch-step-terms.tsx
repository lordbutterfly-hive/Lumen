'use client';

import { FC } from 'react';
import { useTranslation } from '@/blog/i18n/client';
import { BackAction, HoldAction, Notice } from './launch-controls';
import type { MeritumLaunchBlock } from './use-meritum-launch';

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
            <dt className="flex-none basis-[164px] text-12 font-bold uppercase tracking-[0.13em] text-meritum-ink-3">
              {term.label}
            </dt>
            <dd className="min-w-0 flex-1 basis-60 font-serif text-14 text-meritum-ink-2">{term.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-[22px] flex flex-wrap items-center justify-between gap-[18px] rounded-2xl border border-meritum-line-card bg-meritum-rail px-5 py-[18px]">
        <div className="min-w-[min(100%,230px)] flex-1 basis-64">
          <div className="text-14 font-bold text-meritum-ink">{t('meritum_launch.first_buy_title')}</div>
          <p className="mt-1 max-w-[42ch] font-serif text-13 text-meritum-ink-muted">
            {t('meritum_launch.first_buy_body')}
          </p>
        </div>
        <div className="flex items-baseline gap-[5px]">
          <span className="font-serif text-20 text-meritum-ink-faint" aria-hidden="true">
            $
          </span>
          <input
            type="text"
            value={firstBuy}
            onChange={(e) => onFirstBuy(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            aria-label={t('meritum_launch.first_buy_aria')}
            className="w-[84px] min-w-0 border-0 bg-transparent text-right font-serif text-30 font-semibold tabular-nums text-meritum-ink outline-none placeholder:text-meritum-ink-faint"
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
        </Notice>
      ) : null}
      {blockMessage ? (
        <p className="mt-5 text-13 font-semibold text-meritum-ink-brand" role="status">
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
