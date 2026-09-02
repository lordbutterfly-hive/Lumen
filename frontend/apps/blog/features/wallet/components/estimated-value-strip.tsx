'use client';

import { useTranslation } from '@/blog/i18n/client';
import { useHiveMarketPrices } from '../hooks/use-hive-market-prices';
import { formatUsd } from '../lib/format-amount';
import { WalletFigures } from '../lib/wallet-derived';

/**
 * USD value of every token this account holds (liquid + savings + net HP for
 * HIVE, liquid + savings for HBD), priced off the same CoinGecko feed as the
 * rail's price cards. Renders "—" instead of a number while prices are
 * loading/unavailable rather than guessing.
 */
export default function EstimatedValueStrip({ figures }: { figures: WalletFigures }) {
  const { t } = useTranslation('common_blog');
  const { data: prices, isLoading, isError } = useHiveMarketPrices();

  /**
   * ★ OWN stake only (2026-08-09). This used `netHp`, which adds HP delegated IN
   * — so an account holding 0.000 HP of its own showed 93% of its "Estimated
   * Account Value" as somebody else's stake, revocable at any moment.
   *
   * ★★★ …BUT `movableHp` OVERCORRECTED (2026-08-18, owner: "I have 133,000 HIVE,
   * it should be ~$5,050 and it shows $4,600").
   *
   * `movableHp` is `vestingHp - delegatedOutHp` (wallet-derived.ts:62). Removing
   * delegated-IN was right; removing delegated-OUT was not. HP you delegate away
   * is still YOUR stake — you cannot move it until you revoke the delegation, but
   * you own it, it returns to you, and it belongs in what the account is WORTH.
   * "Movable" answers "how much can I power down right now", which is a different
   * question from "what is this account worth" and is why that figure is correct
   * for the Delegate and Power-Down dialogs and wrong here.
   *
   * Measured against the owner's account, 2026-08-18 (HIVE $0.03803):
   *   liquid 59,464.630 + savings 0.100 + HP owned 74,915.926 = 134,380.656 HIVE
   *   delegated out: 12,854.703 HP — 17.2% of the stake, silently dropped
   *   with movableHp -> $4,638   (the reported figure)
   *   with vestingHp -> $5,126   (the expected figure)
   *
   * So: `vestingHp`. Not `netHp` (adds 7,503 HP that is not ours), not
   * `movableHp` (drops 12,855 HP that is).
   */
  const totalHive = figures.liquidHive.plus(figures.savingsHive).plus(figures.vestingHp);
  const totalHbd = figures.liquidHbd.plus(figures.savingsHbd);

  const hasPrices = !isLoading && !isError && !!prices;
  // ★ HBD AT ITS REAL PRICE, NOT AT ITS PEG (2026-08-18). This multiplied by a
  // hardcoded 1 while the hook right above already fetches `hbdUsd`. HBD is only
  // soft-pegged and was trading at $0.941 when this was written, so a pegged $1
  // overstates every HBD holding by whatever the peg is currently missing by.
  const valueUsd = hasPrices
    ? totalHive.toNumber() * prices.hiveUsd + totalHbd.toNumber() * prices.hbdUsd
    : null;

  return (
    <div
      // ★ Preventive mobile-overflow fix (2026-08-14), same anti-pattern as
      // hive-token-card.tsx/hbd-token-card.tsx/staked-hive-block.tsx right
      // next to it on this page: an unwrapped `justify-between` row pairing
      // wrapping prose against an unbreakable tabular-nums figure. Not one of
      // the reported symptoms — at real-world account values it fits the
      // ~294px content box unwrapped — but it's the identical shape as the
      // three that didn't, so it gets the same `flex-wrap` rather than
      // waiting for a whale account to file the same bug again.
      className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-panel border border-line-9 bg-surface-5 px-6 py-4"
      data-testid="wallet-estimated-value"
    >
      <div>
        <div className="text-[16px] leading-[24px] font-semibold text-ink-2">{t('wallet.estimated_value.title')}</div>
        <div className="mt-0.5 text-[14px] leading-[22px] text-ink-10">{t('wallet.estimated_value.description')}</div>
      </div>
      {/* ★ W-4: this figure was #2f7d4f. A balance is a neutral fact, not good
          news — the same $5,147.82 renders identically whether it went up or
          down today. Green is reserved for a DELTA (the price card's 24h change
          chip, a credit in the activity ledger); a holding is body colour. */}
      <span className="font-num font-semibold text-[28px] leading-[36px] text-ink-2">
        {valueUsd === null ? '—' : formatUsd(valueUsd)}
      </span>
    </div>
  );
}
