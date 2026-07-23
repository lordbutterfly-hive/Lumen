'use client';

import { useTranslation } from '@/blog/i18n/client';
import SetProxyDialog from './set-proxy-dialog';

/** Right-rail "Set a proxy" card — delegates governance votes via a real dialog. */
export default function ProxyCard({ currentProxy }: { currentProxy: string }) {
  const { t } = useTranslation('common_blog');

  return (
    <div className="rounded-[18px] border border-[#ebebeb] bg-white p-5" data-testid="proxy-card">
      <div className="mb-1.5 font-sans text-[14.5px] font-bold text-[#161511]">{t('proposals.proxy_card.title')}</div>
      <p className="mb-3.5 font-serif text-[12.5px] leading-normal text-[#6b7280]">
        {t('proposals.proxy_card.description')}
      </p>
      <SetProxyDialog currentProxy={currentProxy}>
        <button
          type="button"
          className="w-full rounded-[11px] border border-[#e4e6e9] bg-white p-[11px] font-sans text-[13.5px] font-semibold text-[#3f4650] transition-colors hover:bg-[#f6f7f8]"
          data-testid="proxy-card-open"
        >
          {currentProxy ? t('proposals.proxy_card.change_button') : t('proposals.proxy_card.set_button')}
        </button>
      </SetProxyDialog>
    </div>
  );
}
