import { getCookie } from '@ui/lib/utils';
import { FC, useEffect, useState } from 'react';

interface TimeAgoProps {
  date: string | number | Date;
  /** Optional language code. Falls back to NEXT_LOCALE cookie or 'en' */
  lang?: string;
}

// Move intervals outside the function to avoid recreation
const TIME_INTERVALS: [number, Intl.RelativeTimeFormatUnit][] = [
  [31536000, 'year'],
  [2592000, 'month'],
  [604800, 'week'],
  [86400, 'day'],
  [3600, 'hour'],
  [60, 'minute'],
  [1, 'second']
];

const getTimeAgoString = (date: Date, lang: string = 'en'): string => {
  try {
    // ★ EVERY RELATIVE TIME IN THE APP WAS WRONG BY THE VIEWER'S UTC OFFSET
    // (2026-08-07). The old code did:
    //
    //     new Date().toLocaleString('en-US', { timeZone: 'UTC' })
    //
    // which produces a NAIVE string like "8/7/2026, 6:31:23 PM" — no timezone
    // marker at all — and then re-parsed it with `new Date(...)`, which
    // interprets a naive string in the BROWSER'S LOCAL zone. So "now" was
    // silently shifted by the local offset: at UTC+2, posts up to two hours old
    // all rendered "now", and a 21-hour-old post read "19 hours ago".
    //
    // `Date.now()` is already an absolute instant. There is nothing to convert:
    // a timezone only matters when FORMATTING a wall-clock time, never when
    // subtracting two instants.
    const timestamp = new Date(date).getTime();
    const diff = Math.floor((Date.now() - timestamp) / 1000);

    if (isNaN(diff)) {
      return 'Invalid date';
    }

    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });

    for (const [secondsInUnit, unit] of TIME_INTERVALS) {
      const value = Math.floor(diff / secondsInUnit);
      if (value > 0) {
        return rtf.format(-value, unit);
      }
    }

    return rtf.format(0, 'second');
  } catch (error) {
    return 'Invalid date';
  }
};

const TimeAgo: FC<TimeAgoProps> = ({ date, lang }) => {
  const [timeAgo, setTimeAgo] = useState<string>('');
  // Use provided lang prop, fall back to cookie or 'en'
  const userLang = lang || getCookie('NEXT_LOCALE') || 'en';

  useEffect(() => {
    const updateTimeAgo = () => {
      setTimeAgo(getTimeAgoString(new Date(date), userLang));
    };

    updateTimeAgo();
    const interval = setInterval(updateTimeAgo, 60000); // Update every minute

    return () => clearInterval(interval);
  }, [date, userLang]);

  return <span title={new Date(date).toLocaleString(userLang)}>{timeAgo}</span>;
};

export default TimeAgo;
