'use client';

import { FC } from 'react';
import { useTranslation } from '@/blog/i18n/client';
import { Notice, PrimaryLink, SecondaryLink } from './launch-controls';

/**
 * THE STRUCK PANEL — shown only once the launch write has actually returned.
 *
 * ★★★ THIS PANEL IS GATED ON THE RESULT, NOT ON THE ANIMATION. The strike runs
 * on a timer, so the coin turns oxblood 2400ms after the hold completes whether
 * or not the chain has answered. "Your token is live." is a factual claim about
 * a market, so the flow holds this panel back until `register` has resolved,
 * and calls the coin's `reset()` if it rejected.
 *
 * Two things can be true at once here and both are said out loud: the market
 * opened but a named offer did not post, or the market opened but the first buy
 * could not be filled. Neither undoes the launch, and neither may be silent.
 */

export interface LaunchStruckProps {
  /** Bare account name. Builds the token-page link. */
  account: string;
  openingPrice: string;
  commission: string;
  /** The market opened but one or more named offers did not post. */
  offersFailed: boolean;
  /** The market opened but the requested first buy could not be filled. */
  firstBuySkipped: boolean;
}

const LaunchStruck: FC<LaunchStruckProps> = ({
  account,
  openingPrice,
  commission,
  offersFailed,
  firstBuySkipped
}) => {
  const { t } = useTranslation('common_blog');

  const facts = [
    { id: 'price', value: openingPrice, label: t('meritum_launch.struck_price_label') },
    { id: 'mint', value: t('meritum_launch.struck_demand_value'), label: t('meritum_launch.struck_demand_label') },
    { id: 'cut', value: commission, label: t('meritum_launch.struck_cut_label') }
  ];

  return (
    <div className="mt-step">
      {/* Stat tiles, not a description list. See `launch-step-account.tsx`. */}
      <div className="mt-[26px] grid grid-cols-3 gap-[34px] border-t border-meritum-line-card pt-[22px]">
        {facts.map((fact) => (
          <div key={fact.id}>
            <div className="font-serif text-26 font-semibold tabular-nums text-meritum-ink">{fact.value}</div>
            <div className="mt-1 font-serif text-12 text-meritum-ink-muted">{fact.label}</div>
          </div>
        ))}
      </div>

      <p className="mt-[22px] max-w-[52ch] font-serif text-15 text-meritum-ink-2">{t('meritum_launch.struck_body')}</p>

      {firstBuySkipped ? <Notice>{t('meritum_launch.first_buy_skipped')}</Notice> : null}
      {offersFailed ? <Notice>{t('meritum_launch.offers_failed')}</Notice> : null}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <PrimaryLink href={`/creators/${account}`} label={t('meritum_launch.cta_token_page')} />
        <SecondaryLink href="/creators/studio" label={t('meritum_launch.cta_studio')} />
      </div>
    </div>
  );
};

export default LaunchStruck;
