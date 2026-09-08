'use client';

/**
 * The wallet's Meritum tab. Everything below the masthead IS the existing
 * `/wallet/tokens` portfolio (`YourTokensBody`, the same hooks, rows, tabs and
 * disclosures), reused rather than rebuilt (owner, 2026-09-08: "check what
 * Meritum already has built and ready before building anything new").
 *
 * What is new is only the "Your Meritum" row for a creator: it carries what the
 * removed header pill used to (laurel, handle, live price, market state word,
 * Studio link), reading through the SAME hook and cache key the pill and the
 * avatar menu use (use-token-price-chip.ts:12-17), with the same identity rule
 * the pill needed four rounds to get right (a lite creator's market is keyed by
 * their wallet DID, never the Lumen handle).
 */
import { Link } from '@hive/ui';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useTranslation } from '@/blog/i18n/client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import PageMasthead from '@/blog/features/layouts/page-masthead';
import { CreatorTokenLaurel } from '@/blog/features/creator-tokens/ui/creator-token-laurel';
import { YourTokensBody } from '@/blog/features/creator-tokens/ui/your-tokens/your-tokens-view';
import { useTokenAccounts } from '@/blog/features/creator-tokens/live/use-token-accounts';
import { useTokenPriceChip } from '@/blog/features/creator-tokens/live/use-token-price-chip';
import { healthWordFor } from '@/blog/features/creator-tokens/market/market-health';
import { usdPrice } from '@/blog/features/creator-tokens/market/format';

const SECONDARY_BUTTON_CLASS =
  'lm-press rounded-card border border-line-11 px-4 py-2 text-caption font-medium text-ink-7 transition-colors hover:bg-surface-16';
const PRIMARY_BUTTON_CLASS =
  'rounded-card bg-surface-brand-12 px-4 py-2 text-caption font-medium text-ink-27 transition-colors hover:bg-surface-brand-17';

export default function MeritumPanel() {
  const { t } = useTranslation('common_blog');
  const identity = useSessionIdentity();
  const { user } = useUserClient();
  const isLite = user.account_tier === 'lite';
  const tokenAccounts = useTokenAccounts();
  const signingAccount = tokenAccounts.accounts.find((a) => a.canSign) ?? null;
  // Identical expression to the four other sites of the same identity rule
  // (formerly header-token-pill.tsx:69-73): a lite creator's market lives under
  // the wallet DID that can sign, never the Lumen display name.
  const priceAccount = (isLite ? signingAccount?.id : identity.username) ?? identity.username;
  const chip = useTokenPriceChip(identity.isLoggedIn ? priceAccount : '');
  const hasMarket = chip.status === 'ready' && chip.priceUsd !== null;

  return (
    <div data-testid="wallet-meritum-content">
      <PageMasthead
        title={t('wallet.tabs.meritum')}
        actions={
          <>
            <Link href="/creators" className={SECONDARY_BUTTON_CLASS} data-testid="wallet-meritum-discover-link">
              {t('wallet.meritum.discover')} →
            </Link>
            {chip.status === 'none' ? (
              <Link href="/creators" className={PRIMARY_BUTTON_CLASS} data-testid="wallet-meritum-launch-link">
                {t('wallet.meritum.launch')}
              </Link>
            ) : null}
          </>
        }
      >
        <p className="max-w-[620px] font-ui text-caption text-ink-10">{t('wallet.meritum.masthead_meta')}</p>
      </PageMasthead>

      {hasMarket ? (
        <div
          className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-panel border border-line-16 bg-surface-warn-2 px-5 py-4"
          data-testid="wallet-meritum-own"
        >
          <CreatorTokenLaurel size={22} className="shrink-0 text-ink-brand-6" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] leading-[24px] font-medium text-ink-2">
              {t('wallet.meritum.own_title')} <span className="text-ink-8">· @{identity.username}</span>
            </div>
            {chip.health !== null && healthWordFor(chip.health) !== null ? (
              <div className="font-ui text-caption uppercase tracking-label text-ink-warn-3">{healthWordFor(chip.health)}</div>
            ) : null}
          </div>
          <div className="text-right">
            <div className="font-num text-[16px] leading-[24px] font-semibold tabular-nums text-ink-2">{usdPrice(chip.priceUsd as number)}</div>
            <div className="text-label font-medium uppercase tracking-label text-ink-14">{t('wallet.meritum.own_price')}</div>
          </div>
          <Link href="/creators/studio" className={SECONDARY_BUTTON_CLASS} data-testid="wallet-meritum-studio-link">
            {t('wallet.meritum.studio')} →
          </Link>
        </div>
      ) : null}

      <YourTokensBody />
    </div>
  );
}
