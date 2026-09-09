'use client';

/**
 * Read-only copy of features/wallet/components/meritum/meritum-panel.tsx,
 * narrowed to one account named by the URL.
 *
 * WHAT WAS REMOVED AND WHY. The private panel embeds the ENTIRE private
 * `/wallet/tokens` portfolio (`YourTokensBody`): asks, reclaim, rating, and
 * Buy/Sell/Send on every holding, all signed with the session's own keys.
 * None of that belongs on someone else's wallet: S1 forbids any signing
 * surface on this page, D3 excludes asks from the public Meritum tab, and D8
 * drops Buy/Sell/Send from a public holding row. This panel keeps only the
 * "own market" row (what this account itself has launched, if anything) and
 * a plain list of what it holds, using its own read-only hooks
 * (usePublicPortfolio, not use-live-portfolio; the plural useTokenPriceChips,
 * not the singular useTokenPriceChip) so the session-only wallet-identity
 * lookup is never imported (D11). No holdings/asks tab bar, no reclaim
 * banner, no exit-note paragraph: that copy was written to "you".
 */

import { Link } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import PageMasthead from '@/blog/features/layouts/page-masthead';
import { CreatorTokenLaurel } from '@/blog/features/creator-tokens/ui/creator-token-laurel';
import { useTokenPriceChips } from '@/blog/features/creator-tokens/live/use-token-price-chips';
import { healthWordFor } from '@/blog/features/creator-tokens/market/market-health';
import { usdPrice } from '@/blog/features/creator-tokens/market/format';
import { routeHandle } from '@/blog/features/creator-tokens/live/adapt';
import { usePublicPortfolio } from '@/blog/features/creator-tokens/live/use-public-portfolio';
import PublicHoldingRow from './public-holding-row';

const SECONDARY_BUTTON_CLASS =
  'lm-press rounded-card border border-line-11 px-4 py-2 text-caption font-medium text-ink-7 transition-colors hover:bg-surface-16';

const Notice = ({ children, testId }: { children: React.ReactNode; testId: string }) => (
  <div className="rounded-card border border-dashed border-line-11 px-5 py-6 text-center font-ui text-[14px] leading-[22px] text-ink-14" data-testid={testId}>
    {children}
  </div>
);

export default function PublicMeritumPanel({ username, target }: { username: string; target: 'hive' | 'lite' }) {
  const { t } = useTranslation('common_blog');

  // Own-market row: is this account itself a creator with a live market?
  // Same batched read the private panel used before it read the singular
  // chip, only widened here to always ask about exactly one handle.
  const { prices: ownPrices } = useTokenPriceChips(target === 'hive' ? [username] : []);
  const own = ownPrices.get(username);
  const ownReady = own && own.status === 'ready' && own.priceUsd !== null ? own : null;

  const portfolio = usePublicPortfolio(username, target === 'hive');
  const { prices: holdingPrices } = useTokenPriceChips(portfolio.holdings.map((h) => h.creator));

  return (
    <div data-testid="public-wallet-meritum">
      <PageMasthead
        title={t('wallet.tabs.meritum')}
        actions={
          <Link href="/creators" className={SECONDARY_BUTTON_CLASS} data-testid="public-wallet-meritum-discover-link">
            {t('wallet.meritum.discover')} →
          </Link>
        }
      >
        <p className="max-w-[620px] font-ui text-caption text-ink-10">{t('wallet.public.meritum_masthead_meta')}</p>
      </PageMasthead>

      {target === 'lite' ? (
        <Notice testId="public-wallet-meritum-lite">{t('wallet.public.lite_meritum')}</Notice>
      ) : (
        <>
          {ownReady ? (
            <div
              className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-panel border border-line-16 bg-surface-warn-2 px-5 py-4"
              data-testid="public-meritum-own"
            >
              <CreatorTokenLaurel size={22} className="shrink-0 text-ink-brand-6" />
              <div className="min-w-0 flex-1">
                <div className="text-[15px] leading-[24px] font-medium text-ink-2">
                  {t('wallet.public.meritum_own')} <span className="text-ink-8">· @{username}</span>
                </div>
                {ownReady.health !== null && healthWordFor(ownReady.health) !== null ? (
                  <div className="font-ui text-caption uppercase tracking-label text-ink-warn-3">{healthWordFor(ownReady.health)}</div>
                ) : null}
              </div>
              <div className="text-right">
                <div className="font-num text-[16px] leading-[24px] font-semibold tabular-nums text-ink-2">
                  {usdPrice(ownReady.priceUsd as number)}
                </div>
                <div className="text-label font-medium uppercase tracking-label text-ink-14">{t('wallet.meritum.own_price')}</div>
              </div>
              <Link
                href={`/creators/${routeHandle(username)}`}
                className={SECONDARY_BUTTON_CLASS}
                data-testid="public-meritum-own-view-market"
              >
                {t('wallet.public.meritum_view_market')} →
              </Link>
            </div>
          ) : null}

          {portfolio.unavailable ? (
            <Notice testId="public-wallet-meritum-unavailable-build">{t('wallet.public.meritum_unavailable_build')}</Notice>
          ) : portfolio.isLoading ? (
            <Notice testId="public-wallet-meritum-loading">{t('wallet.public.meritum_loading')}</Notice>
          ) : portfolio.holdingsUnavailable ? (
            <Notice testId="public-wallet-meritum-unavailable">{t('wallet.public.meritum_unavailable')}</Notice>
          ) : portfolio.holdings.length === 0 ? (
            <Notice testId="public-wallet-meritum-none">{t('wallet.public.meritum_none')}</Notice>
          ) : (
            <div data-testid="public-wallet-meritum-holdings">
              <p className="mb-3 font-ui text-caption text-ink-10">
                {t('wallet.public.meritum_holdings_intro', { count: portfolio.holdings.length })}
              </p>
              <div className="flex flex-col gap-2">
                {portfolio.holdings.map((h) => (
                  <PublicHoldingRow key={`${h.holder}:${h.creator}`} holding={h} price={holdingPrices.get(h.creator)} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
