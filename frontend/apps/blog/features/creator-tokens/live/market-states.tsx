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

/**
 * ★ AN HONEST FAILURE STATE STILL NEEDS AN EXIT (2026-08-09).
 *
 * `MarketMissing` learned this on 2026-08-07 and these two did not, so when the
 * Magi GraphQL endpoint went 502 the studio rendered "Couldn't load this
 * market" with no route anywhere — a creator with no token was told nothing was
 * readable and left with the browser Back button, which is how this got
 * reported as "trapped with no token".
 *
 * The exit is deliberately SECONDARY and worded as a possibility, never as a
 * fact: we do not know whether they have a market, and saying "launch one"
 * would assert exactly the thing we just said we cannot read. The studio still
 * refuses to fall through to its "you have no token" screen, and the wizard now
 * refuses to broadcast under this same uncertainty
 * (`launch-wizard.tsx` — `cannotConfirmMarket`), so all three screens agree.
 *
 * Opt-in via `launchHref` so a public token page is not turned into an advert.
 */
const LaunchEscape: FC<{ href?: string }> = ({ href }) =>
  href ? (
    <a href={href} className="mt-4 inline-block text-[13.5px] font-semibold text-[#c0392b] hover:underline">
      If you haven’t launched a token yet, open the launch wizard →
    </a>
  ) : null;

/** No contract provisioned in this build (REACT_APP_CREATOR_TOKENS_* unset). Not an error, and NOT a reason to show a mock. */
export const MarketUnavailable: FC<{ launchHref?: string }> = ({ launchHref }) => (
  <Panel title="Creator tokens aren’t available yet">
    Nothing is deployed on this build, so there are no real markets to show. This page will fill in once a contract is
    connected — until then it deliberately shows nothing rather than example numbers.
    <LaunchEscape href={launchHref} />
  </Panel>
);

/** The chain read failed. Explicitly NOT "this creator has nothing". */
export const MarketReadFailed: FC<{ onRetry?: () => void; launchHref?: string }> = ({ onRetry, launchHref }) => (
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
    <LaunchEscape href={launchHref} />
  </Panel>
);

/**
 * The read succeeded and this creator genuinely has no market.
 *
 * ★ MUST NOT BE A DEAD END (2026-08-07). This is the page you land on from the
 * "Token" button on any profile, so it is the single most-reached screen in the
 * feature — and it offered no way onward at all. A reader arrived, was told
 * nothing is here, and had to use the browser's Back button.
 */
export const MarketMissing: FC<{ handle: string }> = ({ handle }) => (
  <TokenShell>
    <div className="mt-[26px] rounded-[18px] border border-[#ebebeb] bg-white p-8 shadow-[0_1px_2px_rgba(20,18,10,0.03)]">
      <div className="mb-2 font-serif text-[19px] font-semibold text-[#161511]">
        @{handle} hasn’t launched a token
      </div>
      <p className="mb-5 max-w-[52ch] text-[14px] leading-[1.6] text-[#6b7280]">
        This creator hasn’t opened a market yet, so there’s nothing to buy or spend here.
      </p>
      <div className="flex flex-wrap gap-3">
        <a
          href="/creators"
          className="rounded-[13px] bg-[#c0392b] px-5 py-2.5 text-[14px] font-bold text-white hover:bg-[#96271b]"
        >
          Browse creators
        </a>
        <a
          href="/creators/launch"
          className="rounded-[13px] border border-[#e4e6e9] px-5 py-2.5 text-[14px] font-bold text-[#161511] hover:bg-[#f6f7f8]"
        >
          Launch your own token
        </a>
        <a
          href={`/@${handle}`}
          className="rounded-[13px] border border-[#e4e6e9] px-5 py-2.5 text-[14px] font-bold text-[#161511] hover:bg-[#f6f7f8]"
        >
          Back to @{handle}
        </a>
      </div>
    </div>
  </TokenShell>
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
