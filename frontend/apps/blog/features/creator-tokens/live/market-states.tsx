'use client';

/**
 * The four NOT-READY states a live creator-token screen can be in, rendered
 * honestly and distinctly.
 *
 * These exist because the demo had exactly one state — "here is a market" — and
 * the screens were written assuming it. Collapsing "the node is down" into
 * "this creator has no token" (or worse, into a market full of zeros) is the
 * specific failure this whole wiring pass is undoing: an empty read rendered as
 * real is how a user concludes a creator has no customers, or that their own
 * balance is gone.
 */

import { FC, ReactNode } from 'react';
import TokenShell from '../ui/token-shell';

const Panel: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <TokenShell>
    <div className="mt-[26px] rounded-[18px] border border-[#ebebeb] bg-white p-8 shadow-[0_1px_2px_rgba(20,18,10,0.03)]">
      <div className="mb-2 font-serif text-[19px] font-semibold text-[#161511]">{title}</div>
      <p className="max-w-[52ch] text-[14px] leading-[1.6] text-[#6b7280]">{children}</p>
    </div>
  </TokenShell>
);

/** No contract provisioned in this build (REACT_APP_CREATOR_TOKENS_* unset). Not an error, and NOT a reason to show a mock. */
export const MarketUnavailable: FC = () => (
  <Panel title="Creator tokens aren’t available yet">
    Nothing is deployed on this build, so there are no real markets to show. This page will fill in once a contract is
    connected — until then it deliberately shows nothing rather than example numbers.
  </Panel>
);

/** The chain read failed. Explicitly NOT "this creator has nothing". */
export const MarketReadFailed: FC<{ onRetry?: () => void }> = ({ onRetry }) => (
  <Panel title="Couldn’t load this market">
    We couldn’t reach the chain just now, so we can’t show this token’s price, floor or your balance. Nothing is wrong
    with your position — we simply can’t read it at the moment.
    {onRetry ? (
      <>
        {' '}
        <button onClick={onRetry} className="font-semibold text-[#c0392b] underline">
          Try again
        </button>
      </>
    ) : null}
  </Panel>
);

/** The read succeeded and this creator genuinely has no market. */
export const MarketMissing: FC<{ handle: string }> = ({ handle }) => (
  <Panel title={`@${handle} hasn’t launched a token`}>
    This creator hasn’t opened a market yet, so there’s nothing to buy or spend here. If that’s you, you can launch one
    from the Creator Studio.
  </Panel>
);

export const MarketLoading: FC = () => (
  <TokenShell>
    <div className="mt-[26px] animate-pulse rounded-[20px] border border-[#ebebeb] bg-white p-[26px]">
      <div className="mb-4 h-6 w-40 rounded bg-[#f1f3f5]" />
      <div className="mb-3 h-[44px] w-56 rounded bg-[#f1f3f5]" />
      <div className="h-2 w-full rounded bg-[#f1f3f5]" />
    </div>
  </TokenShell>
);
