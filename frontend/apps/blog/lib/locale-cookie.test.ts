/**
 * `locale-cookie` invariants - plain assertions, no test runner (this repo has
 * none; same style as lib/feed/posts-prefetch-budget.test.ts).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/locale-cookie.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHY THIS EXISTS: the whole edge-cache win is the ABSENCE of one cookie, and
 * absence is the hardest thing to notice regressing. Three ways it dies
 * silently: (a) somebody restores the "no cookie, so plant the default" line
 * and every returning visitor is DYNAMIC again with nothing visibly broken;
 * (b) the switcher starts writing `en` again, or the mount stops expiring a
 * legacy one, so an English reader pays the origin round trip forever;
 * (c) the delete string stops matching the write string's path or name, so it
 * expires nothing and the cookie is immortal.
 */
import {
  localeCookieWrite,
  localeCookieDelete,
  localeCookieForChoice,
  localeCookieMountAction
} from './locale-cookie';
import { defaultLocale, languages, cookieName } from '../i18n/settings';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

// 1. THE MOUNT DECISION. A cookie-less visitor must stay cookie-less: this is
//    the entire behavioural claim of the change.
check(
  'no cookie -> do nothing (never plant the default)',
  localeCookieMountAction({ cookieValue: '', cookieCount: 0 }) === 'none'
);
// ★ AND A DEFAULT-VALUED COOKIE IS EXPIRED UNCONDITIONALLY (owner call,
//    2026-09-05). There is deliberately NO input describing where it came
//    from: a reader who chose English on purpose is expired too, because the
//    cookie carries nothing its absence does not (localStorage keeps the
//    choice) and keeping it would cost that reader the edge cache forever.
check(
  'a leftover default cookie -> expire it',
  localeCookieMountAction({ cookieValue: 'en', cookieCount: 1 }) === 'delete'
);
check(
  'the same holds for whatever defaultLocale is, not just the literal en',
  localeCookieMountAction({ cookieValue: defaultLocale, cookieCount: 1 }) === 'delete'
);
check(
  'the decision reads nothing but the cookie: the same input is always delete',
  new Array(3).fill(0).every(() => localeCookieMountAction({ cookieValue: defaultLocale, cookieCount: 1 }) === 'delete')
);

// 2. A NON-DEFAULT COOKIE IS NEVER TOUCHED. This is the reader who switched to
//    Polish; the reload must still be Polish, whatever else we do for speed.
check(
  'a pl cookie survives untouched',
  localeCookieMountAction({ cookieValue: 'pl', cookieCount: 1 }) === 'none'
);
check(
  'every non-default language is left alone',
  languages
    .filter((l) => l !== defaultLocale)
    .every(
      (l) => localeCookieMountAction({ cookieValue: l, cookieCount: 1 }) === 'none'
    )
);

// 3. DUPLICATES WIN OVER EVERYTHING. `getCookie` returns '' when the cookie is
//    duplicated, so a count test that ran SECOND would be shadowed by the
//    absence test above and the cleanup would never run - which is precisely
//    the bug in the code this replaces.
check(
  'two cookies -> clean up first, even though getCookie reported absence',
  localeCookieMountAction({ cookieValue: '', cookieCount: 2 }) === 'clear-duplicates'
);
check(
  'three cookies -> still a cleanup, whatever value is visible',
  localeCookieMountAction({ cookieValue: 'pl', cookieCount: 3 }) === 'clear-duplicates'
);
check(
  'negative control: the same input with count 1 does NOT ask for a cleanup',
  localeCookieMountAction({ cookieValue: '', cookieCount: 1 }) === 'none'
);

// 4. THE COOKIE STRINGS. Name, path and SameSite must match between write and
//    delete or the delete expires nothing (a delete that misses the path is
//    silent: no error, cookie still there, reader still DYNAMIC).
check('write names the cookie', localeCookieWrite('pl').startsWith(`${cookieName}=pl;`));
check('write is site-wide', localeCookieWrite('pl').includes('path=/'));
check('write is SameSite=Lax', localeCookieWrite('pl').includes('SameSite=Lax'));
check('delete names the cookie', localeCookieDelete().startsWith(`${cookieName}=;`));
check('delete expires it', localeCookieDelete().includes('Max-Age=0'));
check('delete defaults to the site root', localeCookieDelete().endsWith('path=/'));
check('delete honours a narrow path for the duplicate cleanup', localeCookieDelete('/@alice').endsWith('path=/@alice'));
check(
  'write and delete agree on name and attributes (only the value and Max-Age differ)',
  localeCookieDelete('/').replace('; Max-Age=0', '') === localeCookieWrite('')
);

// 5. THE SWITCHER. Choosing English must DELETE; choosing anything else must
//    WRITE. If this inverts, English readers are permanently uncached.
check('choosing the default deletes the cookie', localeCookieForChoice(defaultLocale) === localeCookieDelete('/'));
check('choosing the default writes no value', !/NEXT_LOCALE=en/.test(localeCookieForChoice(defaultLocale)));
check(
  'choosing any other language writes that language',
  languages
    .filter((l) => l !== defaultLocale)
    .every((l) => localeCookieForChoice(l) === localeCookieWrite(l))
);

// 6. THE CONTRACT WITH THE EDGE. The proxy keys on a header derived from this
//    cookie and maps ABSENCE to the literal default (Caddyfile @nolocale), so
//    the set of cacheable cookie values and the default must stay in step with
//    lib/anonymous-cache-policy.ts's CACHEABLE_LOCALES.
check('the default locale is one of the shipped languages', languages.includes(defaultLocale));
check('the cookie name is the one every reader looks for', cookieName === 'NEXT_LOCALE');

if (failures === 0) {
  console.log('\nlocale-cookie: ALL CHECKS PASSED');
  process.exit(0);
} else {
  console.error(`\nlocale-cookie: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
