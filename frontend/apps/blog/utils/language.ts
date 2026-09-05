import { getCookie } from '@ui/lib/utils';

import { getStorageItem, setStorageItem, StorageTTL } from '@ui/lib/storage-with-ttl';
import { languages } from '@/blog/i18n/settings';
import { localeCookieForChoice } from '@/blog/lib/locale-cookie';

export const LOCALE_KEY = 'NEXT_LOCALE';

export const getLanguage = () => {
  if (typeof window === 'undefined') return 'en';
  // Language preference is permanent (no TTL)
  return getStorageItem<string>(LOCALE_KEY) || getCookie(LOCALE_KEY) || 'en';
};

/**
 * ★★★ PICKING ENGLISH DELETES THE COOKIE, IT DOES NOT WRITE ONE (2026-09-05).
 *
 * The cookie exists to tell the server and the edge that this reader is NOT on
 * the default language. Writing `NEXT_LOCALE=en` says nothing the absence of
 * the cookie does not already say (every reader treats absence as `en`; see
 * lib/locale-cookie.ts for each one, with file and line) and it costs the
 * reader the Cloudflare edge cache, because the Free plan cannot vary a cache
 * key on a cookie and the owner's anonymous-HTML rule therefore excludes any
 * request that carries `NEXT_LOCALE`.
 *
 * The CHOICE is not lost by not writing it: the localStorage record below is
 * permanent, is what `getLanguage()` reads first, and is what the mount effect
 * in features/layouts/site-header/client-effects.tsx uses to tell a deliberate
 * English reader from someone who was simply handed the old default cookie.
 *
 * Switching AWAY from English is unchanged: a real cookie at `path=/`, which
 * the root layout and i18n read on the very next render (the switcher calls
 * `router.refresh()`).
 */
export const setLanguage = (locale: string) => {
  if (!languages.includes(locale)) return;
  document.cookie = localeCookieForChoice(locale);
  // Language preference is permanent (no TTL)
  setStorageItem(LOCALE_KEY, locale, StorageTTL.PERMANENT);
};
