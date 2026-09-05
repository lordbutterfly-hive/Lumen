'use client';

import { Link } from '@hive/ui';

import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useServerAccountTier } from '@/blog/features/wallet/lib/server-account-tier-context';
import { useTranslation } from '@/blog/i18n/client';
import DialogLogin from '@/blog/components/dialog-login';
import PageMasthead from '@/blog/features/layouts/page-masthead';
import { useWalletAccount } from '../hooks/use-wallet-account';
import { useTokenAccounts } from '@/blog/features/creator-tokens/live/use-token-accounts';
import HiveTokenCard from './hive-token-card';
import HbdTokenCard from './hbd-token-card';
import SavingsVault from './savings-vault';
import EstimatedValueStrip from './estimated-value-strip';
import AccountHistoryList from './account-history-list';
import { useAccountHistory } from '../hooks/use-account-history';
import { useDelegations } from '../hooks/use-delegations';

/**
 * The wallet's two button shapes, defined once (W-2 / W-3). Every action button
 * on this page used to carry its own radius — 10px, 11px and 12px all rendered
 * side by side — and the primary ones were #2f7d4f, the SUCCESS colour doing
 * duty as an action colour, which gave the app a third primary-button colour.
 * The system radius for a row or a button is 14px and the action colour is the
 * brand red.
 */
const PRIMARY_BUTTON_CLASS =
  'rounded-card bg-surface-brand-12 px-5 py-2.5 text-[14px] leading-[22px] font-medium text-ink-27 transition-colors hover:bg-surface-brand-17';
const SECONDARY_BUTTON_CLASS =
  'lm-press rounded-card border border-line-11 px-4 py-2 text-caption font-medium text-ink-7 transition-colors hover:bg-surface-16';

/**
 * Center column: fetches the logged-in user's real balances (see
 * hooks/use-wallet-account.ts) and renders the HIVE / HBD token cards,
 * Savings Vault and the estimated-value strip. Handles the logged-out,
 * loading and error states the design didn't need to cover.
 *
 * ★ W-1: every branch below opens with the SHARED masthead
 * (features/layouts/page-masthead.tsx), not a bare <h1>. Measured before the
 * fix: the h1's own wrapper was borderRadius 0, background transparent,
 * padding 0 — the exact "no shell at all" shape /witnesses was already
 * corrected for. No `mark` prop: the wallet has no assigned glyph and R5
 * forbids inventing one.
 */
export default function WalletContent() {
  const { t, i18n } = useTranslation('common_blog');
  const { user, clientAnswered } = useUserClient();
  /**
   * ★★★ THE PAGE ALREADY KNEW; THIS COMPONENT DID NOT ASK IT (2026-08-11).
   *
   * `app/wallet/page.tsx` reads the session cookie on the server and redirects
   * a signed-out reader before this ever renders — so anyone who reaches here
   * IS signed in, confirmed server-side. This component still gated its own
   * "logged out" branch on raw `useUserClient()`, which cannot answer during
   * SSR and reports signed-out on the client for 3-5s until `/api/users/me`
   * returns — so a reader the server had already cleared to be here was shown
   * "Log in to see your Hive wallet" on the one page whose entire premise is
   * "you are signed in". `useSessionIdentity` (the same helper the header and
   * left rail use) carries the server's already-correct answer instead of
   * re-guessing "signed out" until the client catches up.
   */
  const identity = useSessionIdentity();
  // Hooks cannot be conditional — read unconditionally, used only in the
  // fallback branch of `isLite` below.
  const serverAccountTier = useServerAccountTier();
  // A keyless Lumen account has no Hive account, so there is nothing on chain to
  // look up. Passing '' disables the account queries (`enabled: !!username` in
  // use-wallet-account.ts) — without that the page fetched a name that does not
  // exist, got an empty result back, and threw inside the figure derivation
  // before any of the honest states below could render. The whole page was a
  // blank error, reached from a link that is always on screen in the left rail.
  /**
   * ★★★ `isLite` NOW HAS AN EARLY, CORRECT ANSWER TOO (C-B, 2026-09-05).
   *
   * This used to read only `user.account_tier` (client-only, undefined until
   * `/api/users/me` answers or a localStorage seed already supplies it) and
   * default to `false` while unknown — safe ONLY because the fetch below was
   * ALSO gated on the equally-client-only `user.username`, so both facts were
   * always wrong (empty username, `isLite` false) or both right, together, on
   * the same render. Switching the fetch to `identity.username` below (the
   * whole point of this fix — it resolves from the server session cookie, at
   * the FIRST render) breaks that pairing: `identity.username` is correct
   * immediately, but a wrong `isLite` default would then fire a real Hive
   * balance/history/delegation fetch for a Lumen handle that is not a Hive
   * account — the exact crash class the comment above already exists to
   * prevent, just relocated to the API's own error path instead of a client
   * throw (see `/api/wallet/summary/route.ts`: a missing account still
   * resolves, via a caught 502, to `isError: true`).
   *
   * `useServerAccountTier()` carries the SAME cookie read `identity.username`
   * already trusts (`lib/server-session.ts`'s `accountTier`, threaded down by
   * `app/layout.tsx`), so it is correct on that same first render. Precedence
   * mirrors `useSessionIdentity`'s own: once the client has actually answered
   * (`clientAnswered`) trust it outright — it is the only source that can see
   * a same-session upgrade; a returning visitor's localStorage-seeded
   * `user.isLoggedIn` is next; only with NEITHER does this fall back to the
   * server tier.
   */
  const isLite = clientAnswered || user.isLoggedIn ? user.account_tier === 'lite' : serverAccountTier === 'lite';
  /**
   * ★ THE WALLET PAGE NOW ASKS WHICH KIND OF LITE ACCOUNT THIS IS (owner, 2026-08-19).
   *
   * It used to answer every lite account with one sentence: "No wallet yet - a Lumen
   * account has no Hive wallet of its own." That is TRUE for a Google-only account and
   * FLATLY FALSE for someone who signed in with an Ethereum or Bitcoin wallet - the
   * security page shows them their own address on the same session, while this page told
   * them they had no wallet at all.
   *
   * `useTokenAccounts` is the same source `/wallet/tokens` and the Meritum eligibility
   * notice already use, so this page stops being the only surface in the app that
   * believes "wallet" means "Hive wallet".
   */
  const tokenAccounts = useTokenAccounts();
  const walletIdentities = tokenAccounts.accounts.filter((a) => a.kind !== 'hive');
  /**
   * ★★★ `identity.username`, NOT `user.username` (C-B, 2026-09-05, the
   * identity-gate waterfall). `user.username` cannot answer during SSR and
   * stays '' until `/api/users/me` resolves, so this fetch — and the two
   * below — never even STARTED until that request landed, on a page the
   * server had already redirected a signed-out reader away from.
   * `identity.username` carries the server session's own answer from the
   * first render (see `useSessionIdentity`), so the balance/history/
   * delegation reads now fire immediately instead of waiting behind a
   * request whose answer this page's own auth gate had already made
   * redundant.
   */
  const { account, figures, dynamicGlobal, isError } = useWalletAccount(
    isLite ? '' : identity.username
  );

  /**
   * ★★★ START THESE NOW, NOT AFTER THE BALANCES LAND (2026-08-18, owner:
   * "wallet took 6 seconds").
   *
   * `AccountHistoryList` and the delegations panel live below the
   * `isLoading` early-return, so their queries were not even MOUNTED until the
   * balance summary resolved — a strictly serial second round trip, on a page
   * where neither depends on the summary at all (history takes a username and a
   * language; delegations takes a username). The price cards in
   * `wallet-right-rail.tsx` already fire unconditionally for exactly this
   * reason; this makes the rest of the page behave the same way.
   *
   * Same query keys and same arguments as the components below, so React Query
   * dedupes: this warms the cache, it does not add a request. The components
   * still own their own loading and error states.
   */
  const historyLang = i18n.resolvedLanguage ?? 'en';
  useAccountHistory(isLite ? '' : identity.username, historyLang);
  useDelegations(isLite ? '' : identity.username);

  if (!identity.isLoggedIn) {
    return (
      <div data-testid="wallet-content-logged-out">
        <PageMasthead title={t('wallet.page_title')}>
          <p className="max-w-[620px] font-ui text-caption text-ink-10">
            {t('wallet.login_required')}
          </p>
        </PageMasthead>
        <DialogLogin>
          <button type="button" className={PRIMARY_BUTTON_CLASS}>
            {t('wallet.login_button')}
          </button>
        </DialogLogin>
      </div>
    );
  }

  // Must sit ABOVE the loading branch: a disabled react-query stays in the
  // loading status forever (fetchStatus idle), which is the same ordering the
  // logged-out branch above already depends on.
  if (isLite) {
    /**
     * ★ THREE STATES, NOT ONE - and the loading one matters. `canHold`/`accounts` default
     * to empty BEFORE the lookup answers, so rendering the "no wallet" sentence eagerly
     * would flash "you have nothing" at someone who has a wallet. Same first-paint
     * mistake `meritum-eligibility.tsx` documents having made once already.
     */
    const walletsResolved = !tokenAccounts.isLoading && !tokenAccounts.failed;
    const hasWallet = walletsResolved && walletIdentities.length > 0;

    if (hasWallet) {
      return (
        <div data-testid="wallet-content-lite-wallet">
          <PageMasthead title={t('wallet.wallet_title')}>
            <p className="max-w-[620px] font-ui text-caption text-ink-10">
              {t('wallet.wallet_body')}
            </p>
          </PageMasthead>
          <ul className="mb-5 flex flex-col gap-2" data-testid="wallet-linked-identities">
            {walletIdentities.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-3 rounded-card border border-line-9 bg-surface-1 px-4 py-3"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="font-ui text-[14px] leading-[22px] font-medium text-ink-2">
                    {a.kind === 'evm' ? t('wallet.chain_evm') : t('wallet.chain_btc')}
                  </span>
                  {/* The address is the account tokens are held under. Shown in FULL
                      rather than a friendly label, because it is the thing a reader has to
                      keep access to.
                      ★ IT USED TO BE `truncate` (QA, 2026-08-20). On a 390px viewport that
                      cut a Bitcoin address to `bc1qewdludr3fpy3k903hqave02ue4xm9ha...` with
                      no title, no copy control and no way to expand — so the one string the
                      sentence above tells you to keep was unreadable on a phone, and the
                      code comment claiming "in full-ish" was not true there. Wrapping is
                      the right trade: a monospace address over two lines is still an
                      address; half an address is not. */}
                  <span className="break-all font-mono text-caption text-ink-10" title={a.address ?? a.id}>
                    {a.address ?? a.id}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/wallet/tokens" className={PRIMARY_BUTTON_CLASS} data-testid="wallet-your-tokens-link">
              {t('wallet.your_tokens_link')} →
            </Link>
            <Link href="/upgrade" className={SECONDARY_BUTTON_CLASS}>
              {t('wallet.lite_upgrade')}
            </Link>
          </div>
        </div>
      );
    }

    return (
      <div data-testid="wallet-content-lite">
        <PageMasthead title={t('wallet.lite_title')}>
          <p className="max-w-[620px] font-ui text-caption text-ink-10">
            {t('wallet.lite_body')}
          </p>
        </PageMasthead>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/upgrade" className={PRIMARY_BUTTON_CLASS}>
            {t('wallet.lite_upgrade')}
          </Link>
          {/* ★ A lite account has no HIVE wallet, but it CAN hold creator tokens —
              /wallet/tokens is written for exactly this account type and says so.
              This early return sat above the full-account branch that carries the
              only "Your tokens" link in the app, so for lite users the page was
              reachable by typed URL alone (found in live QA, 2026-08-07). */}
          <Link
            href="/wallet/tokens"
            className={SECONDARY_BUTTON_CLASS}
            data-testid="wallet-your-tokens-link"
          >
            {t('wallet.your_tokens_link')} →
          </Link>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div data-testid="wallet-content-error">
        <PageMasthead title={t('wallet.page_title')}>
          <p className="text-caption text-destructive">{t('global.something_went_wrong')}</p>
        </PageMasthead>
      </div>
    );
  }

  // ★ Gate on data PRESENCE, not isLoading (T3g fix, 2026-09-04). React Query v4
  // reports isLoading:true even when initialData (the SSR seed) is present, so
  // gating on isLoading defeated the seeded masthead -- it painted "loading" then
  // resolved, the exact flash this optimization exists to kill (see
  // feedback_isloading_lies_with_initialdata; same fix shipped to profile 09-03).
  // The seed provides account+figures so this paints immediately; the balance
  // still revalidates behind it (the query is seeded initialDataUpdatedAt:0).
  if (!account || !figures) {
    return (
      <div data-testid="wallet-content-loading">
        <PageMasthead title={t('wallet.page_title')}>
          <p className="text-caption text-ink-10">{t('wallet.loading')}</p>
        </PageMasthead>
      </div>
    );
  }

  return (
    <div data-testid="wallet-content">
      <PageMasthead
        title={t('wallet.page_title')}
        // /wallet/tokens (the creator-token portfolio) had zero inbound links
        // anywhere in the app despite rendering real, wallet-identity-aware
        // content. It is still this page's entry point to it; it now rides the
        // masthead's own actions slot instead of a hand-built header row.
        actions={
          <Link href="/wallet/tokens" className={SECONDARY_BUTTON_CLASS} data-testid="wallet-your-tokens-link">
            {t('wallet.your_tokens_link')} →
          </Link>
        }
      >
        <p className="max-w-[620px] font-ui text-caption text-ink-10">
          {/* ★ `identity.username`, NOT `user.username` (C-B, 2026-09-05) —
              NOT just the perf fix, a correctness fix. `account`/`figures` are
              now fetched keyed on `identity.username` (above), which resolves
              before `user.username` does; without this change, this branch
              could be reached — real balances rendered — while `user.username`
              was STILL '', printing "wallet for " with no name and handing an
              empty username to every card below. Both names are the same
              person once either has resolved; this just reads the one that is
              actually driving the data on screen. */}
          {t('wallet.masthead_meta', { username: identity.username })}
        </p>
      </PageMasthead>

      <HiveTokenCard username={identity.username} figures={figures} dynamicGlobal={dynamicGlobal} />
      <HbdTokenCard username={identity.username} liquidHbd={figures.liquidHbd} />

      <SavingsVault
        username={identity.username}
        savingsHive={figures.savingsHive}
        savingsHbd={figures.savingsHbd}
        liquidHive={figures.liquidHive}
        liquidHbd={figures.liquidHbd}
        rewardHbd={figures.rewardHbd}
        hasClaimableRewards={figures.hasClaimableRewards}
        savingsHbdLastInterestPayment={account.savings_hbd_last_interest_payment}
        dynamicGlobal={dynamicGlobal}
      />

      <EstimatedValueStrip figures={figures} />

      <AccountHistoryList username={identity.username} />
    </div>
  );
}
