/**
 * `anonymousCachePolicy` invariants, plain assertions, no test runner (this
 * repo has none; same style as lib/request-budget.test.ts).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/anonymous-cache-policy.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHY THIS EXISTS (BUILDMAP-PUBLIC-WALLET-2026-09-09, D6/S6, section 4.8):
 * pins the new `wallet` class (`/@name/wallet`, s-maxage=60, swr=300, the
 * shortest window in this file because it is money) alongside every existing
 * class this file already decided, so a later edit to the account branch
 * cannot silently widen the wallet class to cover a query, a session cookie,
 * a QA bypass header, an unsupported locale, a non GET method, a too short
 * handle, or a sub path of the wallet page, and cannot silently narrow or
 * change the home/topic/profile/profile-list/post classes this file already
 * shipped.
 */
import { anonymousCachePolicy, type CachePolicyInput } from './anonymous-cache-policy';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

const WALLET_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';

function baseInput(overrides: Partial<CachePolicyInput> & { pathname: string }): CachePolicyInput {
  return {
    method: 'GET',
    hasSession: false,
    hasQuery: false,
    hasQaHeader: false,
    localeCookie: null,
    ...overrides
  };
}

// 1. THE WALLET CLASS ITSELF: an anonymous, query less, cookie less GET on a
//    well formed handle's wallet page carries the exact header string, and
//    is labelled 'wallet' for the X-Lumen-Cache-Policy header and the logs.
{
  const result = anonymousCachePolicy(baseInput({ pathname: '/@lumen.beat/wallet' }));
  check('/@name/wallet is cacheable', result.cacheable === true);
  check('/@name/wallet klass is wallet', result.klass === 'wallet');
  check('/@name/wallet carries the exact wallet cache-control string', result.cacheControl === WALLET_CACHE_CONTROL);
}

// 2. A QUERY STRING TAKES THE WALLET PAGE PRIVATE. `?tab=magi` and `?tab=
//    meritum` are real, personal-shaped page states (T3 in the build map).
check(
  '/@name/wallet with a query string is NOT cacheable',
  anonymousCachePolicy(baseInput({ pathname: '/@lumen.beat/wallet', hasQuery: true })).cacheable === false
);

// 3. A SESSION COOKIE TAKES IT PRIVATE (T2 in the build map): a signed in
//    reader must never have their own page cached for anyone else.
check(
  '/@name/wallet with a session cookie is NOT cacheable',
  anonymousCachePolicy(baseInput({ pathname: '/@lumen.beat/wallet', hasSession: true })).cacheable === false
);

// 4. A QA BYPASS HEADER TAKES IT PRIVATE: our own checks must see the origin,
//    never a cached copy.
check(
  '/@name/wallet with the QA header is NOT cacheable',
  anonymousCachePolicy(baseInput({ pathname: '/@lumen.beat/wallet', hasQaHeader: true })).cacheable === false
);

// 5. AN UNSUPPORTED LOCALE COOKIE SPELLING TAKES IT PRIVATE: only the nine
//    exact codes this app ships are safe for a shared proxy to key on.
check(
  '/@name/wallet with a bad locale cookie is NOT cacheable',
  anonymousCachePolicy(baseInput({ pathname: '/@lumen.beat/wallet', localeCookie: 'pl-PL' })).cacheable === false
);

// 6. A NON GET METHOD TAKES IT PRIVATE.
check(
  'POST /@name/wallet is NOT cacheable',
  anonymousCachePolicy(baseInput({ pathname: '/@lumen.beat/wallet', method: 'POST' })).cacheable === false
);

// 7. A TOO SHORT HANDLE IS NOT A WALLET PAGE AT ALL: ACCOUNT needs 3 to 16
//    characters after the @, so /@ab/wallet never reaches the wallet branch.
check(
  '/@ab/wallet (2 character handle) is NOT cacheable',
  anonymousCachePolicy(baseInput({ pathname: '/@ab/wallet' })).cacheable === false
);

// 8. A SUB PATH OF THE WALLET PAGE IS A DIFFERENT PAGE, NOT COVERED.
check(
  '/@name/wallet/x is NOT cacheable',
  anonymousCachePolicy(baseInput({ pathname: '/@lumen.beat/wallet/x' })).cacheable === false
);

// 9. CASE INSENSITIVE, LIKE THE EXISTING PROFILE SUB PAGES: /@name/WALLET is
//    the same page as /@name/wallet.
{
  const result = anonymousCachePolicy(baseInput({ pathname: '/@lumen.beat/WALLET' }));
  check('/@name/WALLET is cacheable', result.cacheable === true);
  check('/@name/WALLET klass is wallet', result.klass === 'wallet');
}

// 10. EXISTING CLASSES, UNCHANGED BY THIS EDIT.
{
  const home = anonymousCachePolicy(baseInput({ pathname: '/' }));
  check('home is still cacheable', home.cacheable === true);
  check('home klass is still home', home.klass === 'home');
  check(
    'home cache-control is unchanged (s-maxage=30, swr=60)',
    home.cacheControl === 'public, max-age=0, s-maxage=30, stale-while-revalidate=60'
  );
}
{
  const topic = anonymousCachePolicy(baseInput({ pathname: '/topics/photography' }));
  check('topic is still cacheable', topic.cacheable === true);
  check('topic klass is still topic', topic.klass === 'topic');
  check(
    'topic cache-control is unchanged (s-maxage=60, swr=120)',
    topic.cacheControl === 'public, max-age=0, s-maxage=60, stale-while-revalidate=120'
  );
}
{
  const profile = anonymousCachePolicy(baseInput({ pathname: '/@lumen.beat' }));
  check('profile is still cacheable', profile.cacheable === true);
  check('profile klass is still profile', profile.klass === 'profile');
  check(
    'profile cache-control is unchanged (s-maxage=300, swr=3600)',
    profile.cacheControl === 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600'
  );
}
{
  const profileList = anonymousCachePolicy(baseInput({ pathname: '/@lumen.beat/followers' }));
  check('profile-list is still cacheable', profileList.cacheable === true);
  check('profile-list klass is still profile-list', profileList.klass === 'profile-list');
  check(
    'profile-list cache-control is unchanged (s-maxage=600, swr=3600)',
    profileList.cacheControl === 'public, max-age=0, s-maxage=600, stale-while-revalidate=3600'
  );
}
{
  const post = anonymousCachePolicy(baseInput({ pathname: '/hive-167922/@lumen.beat/some-real-post-permlink' }));
  check('post is still cacheable', post.cacheable === true);
  check('post klass is still post', post.klass === 'post');
  check(
    'post cache-control is unchanged (s-maxage=300, swr=3600)',
    post.cacheControl === 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600'
  );
}

// 11. THE WALLET BRANCH DOES NOT SWALLOW THE OTHER ACCOUNT SUB PAGES: an
//     actual profile sub page still gets its own class, not 'wallet' and not
//     'none'.
check(
  '/@name/comments is still profile-list, not wallet',
  anonymousCachePolicy(baseInput({ pathname: '/@lumen.beat/comments' })).klass === 'profile-list'
);

// 12. AN UNKNOWN ACCOUNT SUB PAGE THAT IS NOT 'wallet' AND NOT A KNOWN
//     PROFILE SUB PAGE STAYS NOT CACHEABLE, EXACTLY AS BEFORE THIS EDIT.
check(
  '/@name/settings is NOT cacheable (unknown sub page, unchanged)',
  anonymousCachePolicy(baseInput({ pathname: '/@lumen.beat/settings' })).cacheable === false
);

if (failures === 0) {
  console.log('\nanonymous-cache-policy: ALL CHECKS PASSED');
  process.exit(0);
} else {
  console.error(`\nanonymous-cache-policy: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
