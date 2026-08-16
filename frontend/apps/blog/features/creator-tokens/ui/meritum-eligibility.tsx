/**
 * ★★★ ONE ANSWER TO "CAN I DO THIS, AND IF NOT WHY" (2026-08-16, owner).
 *
 * Before this, four surfaces each carried their own sentence about lite accounts
 * and all four said the same wrong thing: "this account has no Hive keys, so it
 * can't sign". That collapses two genuinely different identities into one:
 *
 *   - a GOOGLE-only lite account has no keypair at all, so Magi has no account
 *     for it. It cannot even HOLD a token. Telling that reader to "upgrade to
 *     trade" skips the part where there is nothing to trade with.
 *   - a BITCOIN or ETHEREUM lite account has a real `did:pkh` Magi identity. It
 *     CAN hold and be paid. What it cannot do is initiate a transaction, because
 *     a Magi transaction needs a signature over the transaction itself (EIP-712
 *     over the container for EVM, the transaction CID for Bitcoin) and that rail
 *     is a separate port per chain — see `use-token-accounts.ts`, where `canSign`
 *     is per ACCOUNT precisely so one chain landing cannot flip the other on.
 *
 * The notice is derived from the capability flags the rail already publishes,
 * never from a hand-written guess at the surface, and it always answers three
 * questions in order: what you CAN do here, what you CANNOT and WHY, and the one
 * link that changes it.
 *
 * ★ HONESTY NOTE, worth keeping when this file is next edited. The product
 * intent is that Bitcoin and Ethereum accounts buy and sell Meritum tokens
 * through Magi's multichain interop. TODAY THEY CANNOT: `canSign` is false for
 * every wallet identity in the code, so this copy says "not yet" rather than
 * describing a capability that does not exist. When a chain's signing rail
 * lands, `canSign` flips for that kind and the can-trade branch below starts
 * rendering on its own. Do not soften the copy ahead of the flag.
 *
 * Copy goes through `t()` per the repo rule on user-facing text (CLAUDE.md), and
 * the linked sentences are assembled from separate keys rather than a `<Trans>`
 * with embedded markup — the segments stay independently translatable and no
 * translator has to preserve an anchor tag.
 *
 * Both destinations are real routes, checked before linking them:
 *   /security — "Sign-in & recovery", where a Bitcoin or Ethereum wallet is linked
 *   /upgrade  — "Upgrade to a full Hive account"
 */
import { FC, ReactNode } from 'react';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useTranslation } from '@/blog/i18n/client';
import { useTokenAccounts } from '../live/use-token-accounts';

/** Which question the surface is asking, so the notice answers THAT one first. */
export type MeritumSurface = 'launch' | 'trade' | 'hold';

export interface MeritumEligibility {
  loggedIn: boolean;
  /** Lite account (no Hive keys) — Google-only OR wallet-bound. */
  isLite: boolean;
  /** A Magi account exists that can receive and hold tokens. False for Google-only. */
  canHold: boolean;
  /** This identity can initiate a Magi transaction. False for every wallet identity today. */
  canSign: boolean;
  /** 'btc' | 'evm' when known — used only to name the wallet in the copy. */
  walletKind?: 'btc' | 'evm' | null;
}

/**
 * `className` exists so the Meritum screens can pass their OWN palette. Dropping
 * a `surface-warn-*` box onto those pages is the exact "imported colour" defect
 * the 2026-08-15 palette pass fixed: a low-usage token painting a large surface.
 */
const Notice: FC<{
  tone: 'blocked' | 'partial';
  children: ReactNode;
  testId: string;
  className?: string;
  /**
   * ★ Renders a <span> with NO box. Required, not cosmetic: `token-market-view`
   * drops this inside a <p>, and a <div> in a <p> is invalid markup that React
   * re-parents during hydration.
   */
  inline?: boolean;
}> = ({ tone, children, testId, className, inline }) =>
  inline ? (
    <span data-testid={testId} className={className}>
      {children}
    </span>
  ) : (
  <div
    data-testid={testId}
    className={
      className
        ? className
        : tone === 'blocked'
        ? 'rounded-[14px] border border-line-warn-2 bg-surface-warn-4 px-4 py-3 text-[13px] leading-[20px] text-ink-warn-3'
        : 'rounded-[14px] border border-line-16 bg-surface-23 px-4 py-3 text-[13px] leading-[20px] text-ink-8'
    }
  >
    {children}
  </div>
  );

const Action: FC<{ href: string; children: ReactNode }> = ({ href, children }) => (
  <a href={href} className="font-semibold underline underline-offset-2">
    {children}
  </a>
);

/**
 * Renders nothing for a full Hive account: it can do everything on every one of
 * these surfaces, and a banner saying so is noise on the page that matters most.
 */
export const MeritumEligibilityNotice: FC<{
  surface: MeritumSurface;
  /**
   * ★ M8 FIX (2026-08-16). Widened to the hook's FULL return shape rather than
   * the bare `MeritumEligibility` the flags interface declares, because the
   * `!who.canHold` branch below used to fire on `isLoading` and on `failed`
   * exactly the same as it fires on a genuine Google-only account — those are
   * three different situations wearing one sentence. Every call site already
   * passes `useMeritumEligibility()`'s return value straight through
   * (`token-market-view.tsx`, `your-tokens-view.tsx`, `launch-step-account.tsx`),
   * so this is a type widening, not a breaking change to any caller.
   */
  who: MeritumEligibility & { isLoading: boolean; failed: boolean };
  className?: string;
  inline?: boolean;
}> = ({ surface, who, className, inline }) => {
  const { t } = useTranslation('common_blog');

  // The wallet lookup (`useTokenAccounts`, behind `canHold`/`canSign`) has not
  // answered yet. `canHold` defaults false while it is in flight, which is
  // indistinguishable from a genuine Google-only account further down — render
  // nothing rather than flash a wrong verdict, the same first-paint mistake the
  // launch gate made in August (see the doc comment on the hook below).
  if (who.isLoading) return null;

  // The lookup answered, but with an error, not a verdict. `canHold` is false
  // here too, and `!who.canHold` below would tell a WALLET-BOUND account whose
  // check merely failed that it "signed in with Google" — an assertion about
  // how they authenticated that is simply false. Say what actually happened.
  if (who.failed) {
    return (
      <Notice tone="blocked" testId="meritum-eligibility-check-failed" className={className} inline={inline}>
        {t('meritum_eligibility.check_failed')}
      </Notice>
    );
  }

  if (!who.loggedIn) {
    const key =
      surface === 'launch'
        ? 'meritum_eligibility.signed_out_launch'
        : surface === 'trade'
          ? 'meritum_eligibility.signed_out_trade'
          : 'meritum_eligibility.signed_out_hold';
    return (
      <Notice tone="blocked" testId="meritum-eligibility-signed-out" className={className} inline={inline}>
        {t(key)} <Action href="/login">{t('meritum_eligibility.action_sign_in')}</Action>
      </Notice>
    );
  }

  // A full Hive account: launch, trade, hold. Nothing to warn about.
  if (!who.isLite) return null;

  // GOOGLE-ONLY. No keypair means no Magi account, so there is nothing to hold
  // tokens in — the first thing to say, because "upgrade to trade" would imply
  // a balance exists somewhere.
  if (!who.canHold) {
    return (
      <Notice tone="blocked" testId="meritum-eligibility-google" className={className} inline={inline}>
        <strong className="font-semibold">{t('meritum_eligibility.google_lead')}</strong>{' '}
        {t('meritum_eligibility.google_why')} <Action href="/security">{t('meritum_eligibility.action_link_wallet')}</Action>{' '}
        {t('meritum_eligibility.google_to_hold')}{' '}
        <Action href="/upgrade">{t('meritum_eligibility.action_upgrade')}</Action>{' '}
        {t('meritum_eligibility.google_to_launch')}
      </Notice>
    );
  }

  const walletLabel =
    who.walletKind === 'btc'
      ? t('meritum_eligibility.wallet_btc')
      : who.walletKind === 'evm'
        ? t('meritum_eligibility.wallet_evm')
        : t('meritum_eligibility.wallet_generic');

  // WALLET-BOUND AND SIGNING HAS LANDED for this chain. Holds and trades; still
  // cannot launch, because a launch is a Hive-account act. This branch is dark
  // until `canSign` flips per chain — see the honesty note at the top.
  if (who.canSign) {
    if (surface !== 'launch') return null;
    return (
      <Notice tone="partial" testId="meritum-eligibility-wallet-can-trade" className={className} inline={inline}>
        {t('meritum_eligibility.wallet_can_trade', { wallet: walletLabel })}{' '}
        <Action href="/upgrade">{t('meritum_eligibility.action_upgrade')}</Action>
      </Notice>
    );
  }

  // WALLET-BOUND, SIGNING NOT PORTED. The common case today.
  if (surface === 'launch') {
    return (
      <Notice tone="blocked" testId="meritum-eligibility-wallet-launch" className={className} inline={inline}>
        <strong className="font-semibold">{t('meritum_eligibility.wallet_launch_lead')}</strong>{' '}
        {t('meritum_eligibility.wallet_launch_why', { wallet: walletLabel })}{' '}
        <Action href="/upgrade">{t('meritum_eligibility.action_upgrade')}</Action>{' '}
        {t('meritum_eligibility.wallet_launch_tail')}
      </Notice>
    );
  }

  return (
    <Notice tone="blocked" testId="meritum-eligibility-wallet-trade" className={className} inline={inline}>
      <strong className="font-semibold">{t('meritum_eligibility.wallet_trade_lead', { wallet: walletLabel })}</strong>{' '}
      {t('meritum_eligibility.wallet_trade_why', { wallet: walletLabel })}{' '}
      <Action href="/upgrade">{t('meritum_eligibility.action_upgrade')}</Action>
      {t('meritum_eligibility.wallet_trade_tail')}
    </Notice>
  );
};

/**
 * The single place that turns the rail's capability flags into the shape this
 * notice needs. Surfaces call this rather than threading `isLite` down as a
 * prop, which is how the four inconsistent sentences happened in the first
 * place: each caller decided for itself what a lite account was.
 *
 * `isLoading` is passed through so a surface can hold the notice back rather
 * than flashing "you cannot do this" at a reader whose wallets are still being
 * looked up — the same first-paint mistake the launch gate made in August.
 */
export function useMeritumEligibility(): MeritumEligibility & { isLoading: boolean; failed: boolean } {
  const { user, isHydrated } = useUserClient();
  const accounts = useTokenAccounts();
  const walletKind = accounts.accounts.find((a) => a.kind !== 'hive')?.kind ?? null;
  return {
    loggedIn: isHydrated && user.isLoggedIn,
    isLite: user.account_tier === 'lite',
    canHold: accounts.canHold,
    canSign: accounts.canSign,
    walletKind: walletKind === 'btc' || walletKind === 'evm' ? walletKind : null,
    isLoading: accounts.isLoading,
    failed: accounts.failed
  };
}

export default MeritumEligibilityNotice;
