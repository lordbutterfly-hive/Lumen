'use client';

import { FC, ReactNode } from 'react';
import { useLivePortfolio } from '@/blog/features/creator-tokens/live/use-live-portfolio';
import { MyAsksList } from '@/blog/features/creator-tokens/ui/your-tokens/your-tokens-view';

// TODO i18n - staged copy, the wallet's own sentences for the same states.
const COPY = {
  unavailable: 'Meritum isn’t available on this build yet.',
  accountsFailed:
    'We couldn’t check which wallets are linked to this account, so we can’t list your asks. Nothing is wrong with them. Reload in a moment.',
  accountsLoading: 'Checking which wallets are linked to this account…'
};

const Note: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="rounded-card border border-dashed border-line-11 px-5 py-6 text-center text-[14px] leading-[22px] text-ink-14 font-ui">
    {children}
  </div>
);

/**
 * The inbox's Asks tab (owner, 2026-09-25: "if i made a request currently I need to open
 * my wallet and go to meritum to check if he responded. so put that in the inbox but
 * separate it from other normal messages"). The wallet's own asks list (`MyAsksList`), with
 * the states that come before it, so an account whose wallets could not be checked is never
 * told it has no asks.
 */
const InboxAsks: FC = () => {
  const p = useLivePortfolio();
  if (p.unavailable) return <Note>{COPY.unavailable}</Note>;
  if (p.accountsFailed) return <Note>{COPY.accountsFailed}</Note>;
  if (p.accountsLoading) return <Note>{COPY.accountsLoading}</Note>;
  return <MyAsksList p={p} />;
};

export default InboxAsks;
