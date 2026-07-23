'use client';

import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useTranslation } from '@/blog/i18n/client';
import DialogLogin from '@/blog/components/dialog-login';
import { useWalletAccount } from '../hooks/use-wallet-account';
import HiveTokenCard from './hive-token-card';
import HbdTokenCard from './hbd-token-card';
import SavingsVault from './savings-vault';
import EstimatedValueStrip from './estimated-value-strip';

/**
 * Center column: fetches the logged-in user's real balances (see
 * hooks/use-wallet-account.ts) and renders the HIVE / HBD token cards,
 * Savings Vault and the estimated-value strip. Handles the logged-out,
 * loading and error states the design didn't need to cover.
 */
export default function WalletContent() {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const { account, figures, dynamicGlobal, chain, isLoading, isError } = useWalletAccount(user.username);

  if (!user.isLoggedIn) {
    return (
      <div className="flex flex-col items-start gap-3 py-10">
        <h1 className="font-sans text-[32px] font-bold tracking-[-0.02em] text-[#161511]">
          {t('wallet.page_title')}
        </h1>
        <p className="text-[15px] text-[#6b7280]">{t('wallet.login_required')}</p>
        <DialogLogin>
          <button
            type="button"
            className="rounded-[10px] bg-[#2f7d4f] px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-[#256640]"
          >
            {t('wallet.login_button')}
          </button>
        </DialogLogin>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="py-10">
        <h1 className="mb-2 font-sans text-[32px] font-bold tracking-[-0.02em] text-[#161511]">
          {t('wallet.page_title')}
        </h1>
        <p className="text-[15px] text-destructive">{t('global.something_went_wrong')}</p>
      </div>
    );
  }

  if (isLoading || !account || !figures) {
    return (
      <div className="py-10">
        <h1 className="mb-2 font-sans text-[32px] font-bold tracking-[-0.02em] text-[#161511]">
          {t('wallet.page_title')}
        </h1>
        <p className="text-[15px] text-[#6b7280]">{t('wallet.loading')}</p>
      </div>
    );
  }

  return (
    <div className="pt-[26px]" data-testid="wallet-content">
      <div className="mb-[22px]">
        <h1 className="font-sans text-[32px] font-bold tracking-[-0.02em] text-[#161511]">
          {t('wallet.page_title')}
        </h1>
      </div>

      <HiveTokenCard username={user.username} figures={figures} dynamicGlobal={dynamicGlobal} chain={chain} />
      <HbdTokenCard username={user.username} liquidHbd={figures.liquidHbd} />

      <SavingsVault
        username={user.username}
        savingsHive={figures.savingsHive}
        savingsHbd={figures.savingsHbd}
        liquidHive={figures.liquidHive}
        liquidHbd={figures.liquidHbd}
        rewardHbd={figures.rewardHbd}
        hasClaimableRewards={figures.hasClaimableRewards}
        savingsHbdLastInterestPayment={account.savings_hbd_last_interest_payment}
        dynamicGlobal={dynamicGlobal}
      />

      <EstimatedValueStrip figures={figures} />
    </div>
  );
}
