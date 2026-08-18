'use client';

import { useTranslation } from '@/blog/i18n/client';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import SetProxyDialog from './set-proxy-dialog';

/** Right-rail "Set a proxy" card — delegates governance votes via a real dialog. */
export default function ProxyCard({ currentProxy }: { currentProxy: string }) {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  // A lite account has no Hive keys — the mutation backstop already refuses this
  // (use-proxy-mutation.ts -> refuseIfLite), but the dialog used to open fully,
  // run a real account-exists lookup, and only refuse on the final Submit click.
  const isLite = user.isLoggedIn && user.account_tier === 'lite';

  return (
    <div className="rounded-panel border border-line-9 bg-surface-1 p-5" data-testid="proxy-card">
      <div className="mb-1.5 font-sans text-[15px] leading-[24px] font-bold text-ink-2">
        {t('proposals.proxy_card.title')}
      </div>
      <p className="mb-3.5 font-serif text-[13px] leading-[20px] text-ink-10">
        {isLite ? t('proposals.lite_cannot_vote') : t('proposals.proxy_card.description')}
      </p>
      {isLite ? (
        <button
          type="button"
          disabled
          title={t('proposals.lite_cannot_vote')}
          className="w-full cursor-not-allowed rounded-control border border-line-11 bg-surface-1 p-[11px] font-sans text-[14px] leading-[22px] font-semibold text-ink-7 opacity-60"
          data-testid="proxy-card-lite-blocked"
        >
          {currentProxy ? t('proposals.proxy_card.change_button') : t('proposals.proxy_card.set_button')}
        </button>
      ) : (
        <SetProxyDialog currentProxy={currentProxy}>
          <button
            type="button"
            className="w-full rounded-control border border-line-11 bg-surface-1 p-[11px] font-sans text-[14px] leading-[22px] font-semibold text-ink-7 transition-colors hover:bg-surface-16"
            data-testid="proxy-card-open"
          >
            {currentProxy ? t('proposals.proxy_card.change_button') : t('proposals.proxy_card.set_button')}
          </button>
        </SetProxyDialog>
      )}
    </div>
  );
}
