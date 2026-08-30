/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * THE CLAIMS LUMEN MAKES TO ITS USERS, LOCKED AGAINST THE CODE THAT DISPROVED THEM.
 *
 * Run:
 *   cd apps/blog && npx tsx lib/user-facing-claims.selftest.ts
 *
 * WHAT THIS PROVES, AND WHY IT WOULD HAVE CAUGHT THE DEFECTS.
 *
 * The 2026-08-28 false-text audit found seventeen sentences the product tells
 * readers that the product's own code contradicts. Its central finding was not
 * the seventeen: it was that they are ~six DECISIONS, each made correctly at one
 * call site and never swept to its siblings. Cluster A — "a failed read must
 * never render as you have none" — was right in six places and wrong in two of
 * the reported ones, plus three more this sweep found.
 *
 * So this file is deliberately organised by CLUSTER rather than by finding.
 * Section 1 is the empty-versus-failed-read rule at every site it now governs;
 * section 2 onward are the copy claims. A future edit that reintroduces the
 * defect at ANY one site fails here, which is the only structure that stops the
 * next round of this.
 *
 * ★ THE SOURCE SCANS RUN ON COMMENT-STRIPPED TEXT, AND THE STRIPPER IS ITSELF
 * TESTED. Every fix in this pass carries a ★ note quoting the retired sentence
 * verbatim, to explain why it went. An un-stripped scan would therefore find
 * every retired string inside the prose about retiring it and pass while the
 * product still lied. Section 0 proves the stripper works and that it has not
 * eaten the live code, because a scan that read nothing must FAIL, never pass.
 */

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

const { readFileSync } = require('fs') as typeof import('fs');
const { join } = require('path') as typeof import('path');

const ROOT = join(__dirname, '..');
/** The ★ notes quote the retired copy verbatim, so every scan runs on stripped source. */
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** JSX wraps differently after every prettier run; matching on collapsed whitespace survives formatting. */
const squash = (src: string): string => src.replace(/\s+/g, ' ');

interface Source {
  path: string;
  raw: string;
  code: string;
}
function load(...parts: string[]): Source {
  const raw = readFileSync(join(ROOT, ...parts), 'utf8');
  return { path: parts.join('/'), raw, code: squash(strip(raw)) };
}

const delegated = load('features', 'wallet', 'components', 'delegated-out-panel.tsx');
const walletHistory = load('features', 'wallet', 'components', 'account-history-list.tsx');
const profileCommunities = load('app', '[param]', '(user-profile)', 'communities', 'content.tsx');
const communityDir = load('app', 'communities', 'content.tsx');
const notifications = load('features', 'activity-log', 'notification-content.tsx');
const communityLayout = load('features', 'layouts', 'community', 'community-layout.tsx');
const login = load('features', 'lite-auth', 'login', 'lumen-login.tsx');
const loginDialog = load('components', 'dialog-login.tsx');
const creatorsPage = load('app', 'creators', 'page.tsx');
const helpMd = load('lib', 'markdowns', 'lumen-help.md');
// The Meritum terms ledger — F7 below now asserts which rows are ABSENT from it,
// so the file itself has to be read rather than inferred from the locale alone.
const launchTerms = load('features', 'creator-tokens', 'ui', 'meritum', 'launch', 'launch-step-terms.tsx');

const locale = JSON.parse(readFileSync(join(ROOT, 'locales', 'en', 'common_blog.json'), 'utf8'));
const s = (dotted: string): string => {
  const v = dotted
    .split('.')
    .reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), locale);
  return typeof v === 'string' ? v : '';
};

console.log('\n── 0. THE INSTRUMENT. A scan that read nothing, or that read the comments, must FAIL.\n');
{
  const ALL = [delegated, walletHistory, profileCommunities, communityDir, notifications, communityLayout, login, loginDialog, creatorsPage];
  for (const src of ALL) {
    check(`the scan read ${src.path}`, src.raw.length > 1_000, `${src.raw.length} bytes`);
    check(
      `…and stripping left the code behind in ${src.path}`,
      src.code.length > 400 && src.code.length < src.raw.length,
      `${src.code.length} of ${src.raw.length} bytes after stripping`
    );
  }
  check('the scan read lumen-help.md', helpMd.raw.length > 3_000, `${helpMd.raw.length} bytes`);
  check('the locale file parsed and is the real thing', Object.keys(locale).length > 20, `${Object.keys(locale).length} top-level keys`);

  // ★ PROOF THE STRIPPER REALLY STRIPS. Each of these retired sentences survives
  //   ONLY inside the ★ note explaining its removal.
  const stripperProofs: Array<[string, Source, string]> = [
    ['the signup screen', login, 'and your posting history comes with you'],
    ['the login dialog', loginDialog, 'Sign in to your account using your posting key'],
    ['the /creators metadata', creatorsPage, 'tab "ranks nothing"'],
    ['the community directory', communityDir, 'No results for your search'],
    ['the profile communities tab', profileCommunities, 'A FAILED READ IS NOT "NO SUBSCRIPTIONS"'],
    ['the notifications dialog', notifications, '"No notifications yet" in all six tabs, positively, as a fact.'],
    ['the community layout', communityLayout, 'every one of its six tabs stated "No notifications yet".'.slice(0, 46)],
    ['the delegations panel', delegated, '-500.000 HP']
  ];
  for (const [label, src, retired] of stripperProofs) {
    check(
      `★ the stripper removed comments in ${label} (its ★ note quotes the retired copy verbatim)`,
      src.raw.includes(retired) && !src.code.includes(retired),
      `raw:${src.raw.includes(retired)} stripped:${src.code.includes(retired)} — "${retired}"`
    );
  }

  // ★ NEGATIVE CONTROL: without this, a stripper returning '' satisfies every
  //   "is gone" assertion in this file.
  check(
    '★ NEGATIVE CONTROL: live code survived stripping in every scanned file',
    delegated.code.includes("t('wallet.delegated.none')") &&
      walletHistory.code.includes("t('wallet.history.error')") &&
      profileCommunities.code.includes('<SubscriptionList data={data} />') &&
      communityDir.code.includes('<CommunitiesListSkeleton />') &&
      notifications.code.includes('<NotificationsTabFooter') &&
      communityLayout.code.includes("queryKey: ['AccountNotification', community]") &&
      login.code.includes('createReassure:') &&
      loginDialog.code.includes('<LumenLogin embedded />') &&
      creatorsPage.code.includes('<CreatorsView intro={<MeritumIntro />} />') &&
      helpMd.raw.includes('## Will I earn anything?')
  );
}

console.log('\n── 1. CLUSTER A: a failed read is never "you have none". Every site, in order.\n');
{
  /**
   * The rule, in the words of `features/account-settings/blocked-list.tsx`:
   * "Checked BEFORE the empty state, and that ordering is the fix. `data` is
   * `undefined` on a failed read, so the empty branch below would otherwise catch
   * it and state, in plain language, that this reader has blocked nobody."
   */
  const sites: Array<{ label: string; src: Source; error: string; empty: string }> = [
    {
      label: 'the reference implementation (wallet history) still has it',
      src: walletHistory,
      error: "t('wallet.history.error')",
      empty: "t('wallet.history.empty')"
    },
    {
      label: 'F16 — the delegations panel',
      src: delegated,
      error: "t('wallet.delegated.error')",
      empty: "t('wallet.delegated.none')"
    },
    {
      label: 'swept twin — the profile communities tab',
      src: profileCommunities,
      error: "t('user_profile.social_tab.subscriptions_unavailable')",
      empty: "t('user_profile.social_tab.you_dont_have_any_subscriptions')"
    },
    {
      label: 'swept twin — the community directory',
      src: communityDir,
      error: "t('communities.load_failed')",
      empty: "t('communities.no_results')"
    },
    {
      label: 'swept twin — the community notifications dialog',
      src: notifications,
      error: "t('navigation.profile_notifications_tab_navbar.notifications_unavailable')",
      empty: "t('navigation.profile_notifications_tab_navbar.no_notifications_yet')"
    }
  ];

  for (const site of sites) {
    check(`${site.label}: renders a failure branch at all`, site.src.code.includes(site.error), site.error);
    check(`…${site.label}: still renders the empty state, which is a real state`, site.src.code.includes(site.empty), site.empty);
    check(
      `★ …${site.label}: the failure branch comes BEFORE the empty one, which IS the fix`,
      site.src.code.indexOf(site.error) < site.src.code.indexOf(site.empty),
      `error at ${site.src.code.indexOf(site.error)}, empty at ${site.src.code.indexOf(site.empty)}`
    );
    check(
      `…${site.label}: the two sentences are genuinely different`,
      site.error !== site.empty
    );
  }

  // The failure has to be READ from the query, not merely rendered somewhere.
  check('F16: the delegations hook’s isError is consulted', /const \{ data: delegatees, isFetching, isError \}/.test(delegated.code));
  check('twin: the profile subscriptions query’s isError is consulted', /const \{ data, isLoading, isError \} = useQuery/.test(profileCommunities.code));
  check('twin: the community directory query’s isError is consulted', /const \{ data: communitiesData, isFetching, isError \}/.test(communityDir.code));
  check(
    'twin: the AccountNotification query’s isError is consulted and named',
    /isError: notificationsUnavailable/.test(communityLayout.code)
  );
  check(
    '★ …and it actually travels the three hops to the renderer — a flag nobody forwards is a flag that does nothing',
    communityLayout.code.includes('notificationsUnavailable={notificationsUnavailable}') &&
      load('features', 'layouts', 'community', 'community-description.tsx').code.includes('unavailable={notificationsUnavailable}') &&
      load('features', 'layouts', 'community', 'community-simple-description.tsx').code.includes('unavailable={notificationsUnavailable}') &&
      load('features', 'activity-log', 'dialog.tsx').code.includes('unavailable={unavailable}')
  );

  // A rendered COUNT is a claim too. "Delegated to 0 accounts" on an unread list
  // is the same lie in numeric form.
  check(
    '★ F16: the delegatee COUNT is not printed as 0 when the list was never read',
    !delegated.code.includes('delegatees?.length ?? 0') && delegated.code.includes('delegatees ? t('),
    'a count of 0 from an undefined list asserts absence exactly the way the sentence did'
  );

  // Every new string exists and says what it must.
  for (const key of [
    'wallet.delegated.error',
    'wallet.delegated.loading',
    'user_profile.social_tab.subscriptions_unavailable',
    'communities.load_failed',
    'navigation.profile_notifications_tab_navbar.notifications_unavailable'
  ]) {
    check(`${key} exists and is a real sentence`, s(key).length > 20, `"${s(key)}"`);
    check(`…${key} does not itself assert absence`, !/\byou have no\b|\bno results\b|\bnone yet\b/i.test(s(key)), `"${s(key)}"`);
  }
}

console.log('\n── 2. F1: the help page no longer says creator-token trading is free.\n');
{
  const help = helpMd.raw;
  check(
    '★ THE DEFECT: "there is still no fee" is gone',
    !help.includes('and there is\n  still no fee') && !help.includes('there is still no fee'),
    'the sentence’s grammatical subject was literally "Buying and selling creator tokens"'
  );
  check('…the free thing is now scoped to SENDING the transaction', /sending\s*\n?\s*the transaction still costs nothing/.test(help));
  // params.go TradeFeeBps = 1000 (10%), MaxExitTaxBps = 2000 decaying over ExitTaxDecayBlocks = 42 days.
  check('…and the 10% trade fee is stated', /every\s*\n?\s*buy and sell on the curve pays a 10% fee/.test(help), 'params.go TradeFeeBps = 1000');
  check('…and the early-exit fee is stated with its 6-week decay', /early-exit fee on top, which fades to zero over 6 weeks/.test(help), 'params.go MaxExitTaxBps = 2000, ExitTaxDecayBlocks = 42 days');
  check(
    '★ …in the SAME vocabulary the buyer-facing token page already uses',
    readFileSync(join(ROOT, 'features', 'creator-tokens', 'ui', 'token-page', 'disclosure-copy.ts'), 'utf8').includes(
      'early-exit fee'
    ),
    'two names for one deduction is how a reader concludes there are two deductions'
  );
  // The audit verified these three against rc-budget.ts and told the fixer to keep them.
  check('…and the VERIFIED-TRUE credit facts survived the edit: 1 HBD = 1,000 credits', help.includes('holding 1 HBD gives you 1,000 credits'));
  check('…five-day return survived', help.includes('over about five days') || help.includes('about five days'));
  check('…roughly 2 HBD per purchase survived', help.includes('2 HBD of credit'));
}

console.log('\n── 3. F13: "your posting history comes with you" is scoped at both sites.\n');
{
  // The accurate statement, unchanged, at the site that got this right on 2026-08-16.
  const upgrade = load('features', 'lite-auth', 'upgrade', 'upgrade-panel.tsx');
  check(
    'the 2026-08-16 fix on the upgrade screen is untouched',
    upgrade.code.includes('stay published through Lumen’s account on chain'),
    'this file is the authority the two edits below were copied from'
  );

  check('★ THE DEFECT (signup): "history comes with you" is gone', !login.code.includes('your posting history comes with you'));
  check('…and the Lumen half, which is TRUE, is still said', /On Lumen your history follows your new name/.test(login.code));
  check(
    '★ …and the part that is false everywhere else is now said too',
    /posts written before the upgrade stay under Lumen’s account/.test(login.code),
    'tos.md:172-174 agrees: content published before that point cannot be reassigned'
  );

  check('★ THE DEFECT (help page): "comes with you" and "stay yours" are gone', !helpMd.raw.includes('history comes with you') && !helpMd.raw.includes('stay yours'));
  check('…the help page says what moves', helpMd.raw.includes('all move to your new name'));
  check('…and what does not', helpMd.raw.includes('other Hive sites will not list them under your new name'));
}

console.log('\n── 4. F5 / F6 / F7 / F15 / F17: the remaining claims.\n');
{
  // F5 — discovery-ranking.ts hid the ordering tabs because the corpus is null.
  check('★ F5: the /creators description no longer claims an order', !creatorsPage.code.includes('ranked by how reliably they deliver'));
  check('…and still describes the page', /Browse creators, hold a creator’s token, and spend it on their work\./.test(creatorsPage.code));

  // F6 — refund.go: net = gross - ExitTaxOn(...), up to MaxExitTaxBps = 2000.
  check('★ F6: the launch terms no longer promise a bare refund', !s('meritum_launch.term_stop_value').includes('Everyone holding is refunded.'));
  check('…they name the deduction', s('meritum_launch.term_stop_value').includes('less any early-exit fee'));
  check(
    '★ …and do NOT reintroduce the trade fee, which the wind-down rail does not charge',
    !/trade fee/i.test(s('meritum_launch.term_stop_value')),
    'refund.go:286-291, ratified policy: "do NOT fix it by adding tradeFeeOn here"'
  );

  /*
    F7 — market.go Retire() exists and creator-studio.tsx exposes it. This used to
    police the WORDING of the `term_final` row ("no longer say the market cannot be
    closed"). That row no longer exists: the owner deleted it on 2026-08-30 —
    "delete the line below that says you cannot send the tokens to anyone bla bla.
    thats confusing" — along with the `term_supply` row, which the same ruling's
    cap change had made false.

    REWRITTEN TO ASSERT ABSENCE AT BOTH ENDS, not left as it was. `s()` returns ''
    for a missing key, so the old first check would have gone on PASSING against a
    row that had been deleted — a check with nothing to inspect must fail, not pass.
    The two remaining rows are asserted present in the same breath, so an absence
    check can never be satisfied by a file that simply failed to load.
  */
  const launchLocale = (locale as Record<string, Record<string, unknown>>).meritum_launch ?? {};
  check(
    '★ F7: the term_final row is gone from the locale (owner, 2026-08-30)',
    !('term_final_value' in launchLocale) && !('term_final_label' in launchLocale)
  );
  check(
    '…and gone from the renderer too, not merely left untranslated',
    !launchTerms.code.includes('term_final_value') && !launchTerms.code.includes("id: 'final'")
  );
  check(
    '…the same ruling removed the Supply row, which the cap change had made false',
    !('term_supply_value' in launchLocale) && !('term_supply_label' in launchLocale) && !launchTerms.code.includes('term_supply_value')
  );
  check(
    '…VACUOUS-PASS GUARD: the rows that STAY are still rendered and still say something',
    launchTerms.code.includes('term_stop_value') &&
      launchTerms.code.includes('term_cut_value') &&
      s('meritum_launch.term_stop_value').length > 50,
    `stop row is ${s('meritum_launch.term_stop_value').length} chars`
  );

  // F15 — muted-reasons.ts LOW_REPUTATION = 3, consumed by comment-list-item and medium-post-card.
  check('★ F15: the profile tooltip no longer says reputation is unused', !s('user_profile.reputation_title').includes('does not use it for anything'));
  check('…it says what is actually true about ranking', s('user_profile.reputation_title').includes('does not rank by it'));
  check(
    '★ …and names the consequence the reader can see',
    /collapses those posts and comments behind a Reveal/.test(s('user_profile.reputation_title')),
    'lib/muted-reasons.ts:11 LOW_REPUTATION, rendered at comment-list-item.tsx and medium-post-card.tsx'
  );
  check('…and the sentence still opens by defining the number', s('user_profile.reputation_title').startsWith('Reputation {{value}}.'));

  // F17 — dialog-login.tsx renders <LumenLogin/>, whose doors are Google, BTC, EVM, Keychain.
  check('★ F17: the screen-reader description no longer names a posting key', !loginDialog.code.includes('posting key'));
  check(
    '…it names the doors this dialog actually renders',
    /Sign in with Google, a Bitcoin or Ethereum wallet, or Hive Keychain\./.test(loginDialog.code),
    'the operator ruling in this same file lists exactly these four'
  );
}

console.log('\n── 5. HOUSE STYLE. No em dashes in copy written by this pass.\n');
{
  // The owner greps for these. Only the strings this pass added or reworded are
  // in scope; the rest of the product’s existing copy is not this pass’s to change.
  const written: Array<[string, string]> = [
    ['wallet.delegated.error', s('wallet.delegated.error')],
    ['wallet.delegated.loading', s('wallet.delegated.loading')],
    ['user_profile.social_tab.subscriptions_unavailable', s('user_profile.social_tab.subscriptions_unavailable')],
    ['user_profile.social_tab.subscriptions_loading', s('user_profile.social_tab.subscriptions_loading')],
    ['communities.load_failed', s('communities.load_failed')],
    ['navigation.profile_notifications_tab_navbar.notifications_unavailable', s('navigation.profile_notifications_tab_navbar.notifications_unavailable')],
    ['navigation.profile_notifications_tab_navbar.notifications_loading', s('navigation.profile_notifications_tab_navbar.notifications_loading')],
    ['global.indexing_pending', s('global.indexing_pending')],
    ['meritum_launch.term_stop_value', s('meritum_launch.term_stop_value')],
    /* term_final_value was scanned here until 2026-08-30; the row it belonged to was
       deleted by owner ruling, and a dash scan on a key that no longer exists is a
       check with nothing to inspect. F7 above now asserts its absence instead. */
    ['user_profile.reputation_title', s('user_profile.reputation_title')]
  ];
  for (const [key, value] of written) {
    check(`${key} carries no em or en dash`, value.length > 0 && !/[—–]/.test(value), `"${value}"`);
  }
  const reassure = /createReassure:\s*'([^']*)'/.exec(login.raw)?.[1] ?? '';
  check('the scan actually found the reworded signup reassurance', reassure.length > 100, `${reassure.length} chars`);
  check('the reworded signup reassurance carries no em or en dash', reassure.length > 100 && !/[—–]/.test(reassure), reassure);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}

// This file is a MODULE, not a global script: without an export its top-level
// `checks`/`failures` collide with every sibling selftest under one tsconfig.
export {};
