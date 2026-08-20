'use client';

import { Link } from '@hive/ui';

import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
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
  'rounded-card bg-surface-brand-12 px-5 py-2.5 text-[14px] leading-[22px] font-semibold text-ink-27 transition-colors hover:bg-surface-brand-17';
const SECONDARY_BUTTON_CLASS =
  'lm-press rounded-card border border-line-11 px-4 py-2 text-caption font-semibold text-ink-7 transition-colors hover:bg-surface-16';

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
  const { user } = useUserClient();
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
  // A keyless Lumen account has no Hive account, so there is nothing on chain to
  // look up. Passing '' disables the account queries (`enabled: !!username` in
  // use-wallet-account.ts) — without that the page fetched a name that does not
  // exist, got an empty result back, and threw inside the figure derivation
  // before any of the honest states below could render. The whole page was a
  // blank error, reached from a link that is always on screen in the left rail.
  //
  // `isLite` still reads the plain client value, not `identity` — the server
  // session only carries isLoggedIn/username, not account tier. While the
  // client hasn't answered yet, `isLite` defaults false, `user.username` is
  // still '', and the account query below stays disabled — which the existing
  // isLoading branch already renders as a neutral "loading" masthead rather
  // than guessing a tier. That is correct: it never shows a lite reader the
  // full-balance UI or a full reader the lite UI, it just waits one beat.
  const isLite = user.account_tier === 'lite';
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
  const { account, figures, dynamicGlobal, isLoading, isError } = useWalletAccount(
    isLite ? '' : user.username
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
  useAccountHistory(isLite ? '' : user.username, historyLang);
  useDelegations(isLite ? '' : user.username);

  if (!identity.isLoggedIn) {
    return (
      <div data-testid="wallet-content-logged-out">
        <PageMasthead title={t('wallet.page_title')}>
          <p className="max-w-[620px] font-serif text-caption text-ink-10">
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
            <p className="max-w-[620px] font-serif text-caption text-ink-10">
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
                  <span className="font-sans text-[14px] leading-[22px] font-semibold text-ink-2">
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
          <p className="max-w-[620px] font-serif text-caption text-ink-10">
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

  if (isLoading || !account || !figures) {
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
        <p className="max-w-[620px] font-serif text-caption text-ink-10">
          {t('wallet.masthead_meta', { username: user.username })}
        </p>
      </PageMasthead>

      <HiveTokenCard username={user.username} figures={figures} dynamicGlobal={dynamicGlobal} />
      <HbdTokenCard username={user.username} liquidHbd={figures.liquidHbd} />

      <SavingsVault
        username={user.username}
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

      <AccountHistoryList username={user.username} />
    </div>
  );
}
