'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from '@/blog/i18n/client';

/**
 * Live "2d 14h" label. The remaining-time string is computed only inside
 * useEffect (never during render) so the server pass and hydration can't
 * mismatch on Date.now().
 */
export default function Countdown({ closesAt, className }: { closesAt: number; className?: string }) {
  const { t } = useTranslation('common_blog');
  const [label, setLabel] = useState('');

  useEffect(() => {
    const tick = () => {
      let ms = closesAt - Date.now();
      if (ms < 0) ms = 0;
      const days = Math.floor(ms / 86_400_000);
      const hours = Math.floor(ms / 3_600_000) % 24;
      const minutes = Math.floor(ms / 60_000) % 60;
      setLabel(
        days > 0
          ? t('prediction_market.countdown.days_hours', { days, hours })
          : hours > 0
            ? t('prediction_market.countdown.hours_minutes', { hours, minutes })
            : t('prediction_market.countdown.minutes', { minutes })
      );
    };
    tick();
    const interval = setInterval(tick, 30_000);
    return () => clearInterval(interval);
  }, [closesAt, t]);

  return <span className={className}>{label}</span>;
}
