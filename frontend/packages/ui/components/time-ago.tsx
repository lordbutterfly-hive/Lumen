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

/**
 * Parse a Hive timestamp as UTC.
 *
 * ★ THE OTHER HALF OF THE TIMESTAMP BUG (2026-08-08). Earlier today the "now"
 * side of the subtraction was fixed; this is the "then" side, and it was still
 * wrong. Hive returns `created` as `"2026-08-07T09:22:12"` — a date-TIME string
 * with NO timezone marker — and per the ECMAScript spec such a string is parsed
 * as LOCAL time, not UTC. On a UTC+2 box that made every post look two hours
 * older than it is: a 13.1-hour-old post rendered "15 hours ago", measured
 * against Hive's own chain clock across a full 20-post sample.
 *
 * Appending `Z` when the string carries no zone forces the correct instant. A
 * string that already declares one (`Z` or `+02:00`) is left alone.
 */
const parseHiveDate = (value: Date | string | number): Date => {
  if (typeof value !== 'string') return new Date(value);
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  return new Date(hasZone ? value : `${value}Z`);
};

const TimeAgo: FC<TimeAgoProps> = ({ date, lang }) => {
  const [timeAgo, setTimeAgo] = useState<string>('');
  // Use provided lang prop, fall back to cookie or 'en'
  const userLang = lang || getCookie('NEXT_LOCALE') || 'en';

  useEffect(() => {
    const updateTimeAgo = () => {
      setTimeAgo(getTimeAgoString(parseHiveDate(date), userLang));
    };

    updateTimeAgo();
    const interval = setInterval(updateTimeAgo, 60000); // Update every minute

    return () => clearInterval(interval);
  }, [date, userLang]);

  return <span title={parseHiveDate(date).toLocaleString(userLang)}>{timeAgo}</span>;
};

export default TimeAgo;
