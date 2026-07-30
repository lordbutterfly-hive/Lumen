'use client';

import DialogLogin from '@/blog/components/dialog-login';
import { useTranslation } from '@/blog/i18n/client';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import SetProxyDialog from './set-proxy-dialog';

interface WitnessesProxyCardProps {
  isLoggedIn: boolean;
  hasProxy: boolean;
  proxyAccount: string;
}

const BUTTON_CLASS =
  'w-full rounded-[11px] border border-[#e4e6e9] bg-white px-4 py-[11px] font-sans text-[13.5px] font-semibold text-[#3f4650] transition-colors hover:bg-[#f6f7f8]';

/**
 * Right-rail "Set a proxy" card. Delegating votes and clearing a proxy
 * both go through `SetProxyDialog`, which broadcasts a real
 * `account_witness_proxy` operation — this card never dead-ends.
 */
export default function WitnessesProxyCard({ isLoggedIn, hasProxy, proxyAccount }: WitnessesProxyCardProps) {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  // A lite account has no Hive keys — the mutation backstop already refuses this
  // (use-set-proxy-mutation.ts -> refuseIfLite), but the dialog used to open fully,
  // run a real account-exists lookup, and only refuse on the final Submit click.
  const isLite = isLoggedIn && user.account_tier === 'lite';

  return (
    <div data-testid="witnesses-proxy-card">
      <div className="mb-1.5 font-sans text-[14.5px] font-bold text-[#161511]">
        {t('witnesses.proxy_card.title')}
      </div>
      <p className="mb-3.5 font-serif text-[12.5px] leading-[1.5] text-[#6b7280]">
        {isLite
          ? t('witnesses.lite_cannot_vote')
          : hasProxy
            ? t('witnesses.proxy_card.current_description', { proxy: proxyAccount })
            : t('witnesses.proxy_card.description')}
      </p>

      {!isLoggedIn ? (
        <DialogLogin>
          <button type="button" className={BUTTON_CLASS} data-testid="witnesses-proxy-login-cta">
            {t('witnesses.proxy_card.set_button')}
          </button>
        </DialogLogin>
      ) : isLite ? (
        <button
          type="button"
          disabled
          title={t('witnesses.lite_cannot_vote')}
          className={`${BUTTON_CLASS} cursor-not-allowed opacity-60`}
          data-testid="witnesses-proxy-lite-blocked"
        >
          {hasProxy ? t('witnesses.proxy_card.clear_button') : t('witnesses.proxy_card.set_button')}
        </button>
      ) : hasProxy ? (
        <SetProxyDialog
          mode="clear"
          currentProxy={proxyAccount}
          trigger={
            <button type="button" className={BUTTON_CLASS} data-testid="witnesses-proxy-clear-cta">
              {t('witnesses.proxy_card.clear_button')}
            </button>
          }
        />
      ) : (
        <SetProxyDialog
          mode="set"
          trigger={
            <button type="button" className={BUTTON_CLASS} data-testid="witnesses-proxy-set-cta">
              {t('witnesses.proxy_card.set_button')}
            </button>
          }
        />
      )}
    </div>
  );
}
