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
import { displayHandle } from './adapt';
import TokenShell from '../ui/token-shell';
import { LumenLoader } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';

/**
 * ★ A REAL h1 (2026-08-11, audit item 8). `/creators/[handle]` had no heading
 * element at all whenever the market couldn't be shown — this title was a
 * plain `<div>` — so a screen-reader user landed here with nothing to land
 * on, the same defect `token-market-view.tsx` fixed for the SUCCESS state on
 * 2026-08-07. Every caller of `Panel`/`MarketMissing` below `return`s this in
 * place of its own page content (see e.g. `creator-studio.tsx`'s early
 * `status === 'unavailable'` guard, before its own h1-bearing branches), so
 * there is never a second h1 on the same render. Styling unchanged; only the
 * element is.
 */
const Panel: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <TokenShell>
    <div className="mt-[26px] rounded-panel border border-line-9 bg-surface-1 p-8 shadow-[0_1px_2px_rgba(26,22,18,0.035),0_3px_12px_-6px_rgba(70,46,30,0.13)]">
      <h1 className="mb-2 font-serif text-[20px] leading-[30px] font-semibold text-ink-2">{title}</h1>
      <p className="max-w-[52ch] text-[14px] leading-[22px] text-ink-10">{children}</p>
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
    <a href={href} className="mt-4 inline-block text-[14px] leading-[22px] font-semibold text-ink-brand-6 hover:underline">
      If you haven’t launched a token yet, open the launch wizard →
    </a>
  ) : null;

/** No contract provisioned in this build (REACT_APP_CREATOR_TOKENS_* unset). Not an error, and NOT a reason to show a mock. */
export const MarketUnavailable: FC<{ launchHref?: string }> = ({ launchHref }) => (
  <Panel title="Meritum isn’t available yet">
    Nothing is deployed on this build, so there are no real markets to show. This page will fill in once a contract is
    connected. Until then it deliberately shows nothing rather than example numbers.
    <LaunchEscape href={launchHref} />
  </Panel>
);

/** The chain read failed. Explicitly NOT "this creator has nothing". */
export const MarketReadFailed: FC<{ onRetry?: () => void; launchHref?: string }> = ({ onRetry, launchHref }) => (
  <Panel title="Couldn’t load this market">
    {/* ★ "price, floor or your balance" until 2026-08-27. The floor is hidden
        for launch (../backing-visibility.ts), so naming it here told a reader
        we could not show them something they were never going to be shown, and
        it is the one sentence about the figure that lives outside the four
        screens. The two things this state IS about, the price and the balance,
        are unchanged. */}
    We couldn’t load this market just now, so we can’t show its price or your balance. Nothing is wrong with
    your position, we simply can’t read it this moment. If you’ve been browsing quickly, give it a few seconds.
    {onRetry ? (
      <>
        {' '}
        <button onClick={onRetry} className="font-semibold text-ink-brand-6 underline">
          Try again
        </button>
      </>
    ) : null}
    <LaunchEscape href={launchHref} />
  </Panel>
);

/**
 * F14 fix (2026-08-19). OUR OWN session check (`/api/users/me`) failed —
 * distinct from `MarketReadFailed` above, where the CHAIN read failed. Before
 * this state existed, a failed session made `creator` resolve to null in
 * use-live-studio.ts (loggedIn defaults false), which fell through to
 * `MarketMissing`'s "Launch your Meritum. Free to launch." — telling a
 * creator who already has a live market that they have none. Persists until
 * the next focus/reconnect (use-user-core.ts's `sessionUnavailable` doc) —
 * not a flicker, so this needs its own honest state and its own retry, which
 * re-fires the session check itself (`onRetry` here is `retrySession`, not
 * `retry` — `retry` only re-reads chain queries, all of which stay disabled
 * while the creator identity is unknown).
 */
export const MarketSessionUnavailable: FC<{ onRetry?: () => void }> = ({ onRetry }) => (
  <Panel title="Couldn’t check your account">
    We couldn’t verify you’re signed in just now, so we can’t show your Studio. This is not the same as having no
    token. Reload, or try again in a moment.
    {onRetry ? (
      <>
        {' '}
        <button onClick={onRetry} className="font-semibold text-ink-brand-6 underline">
          Try again
        </button>
      </>
    ) : null}
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
    <div className="mt-[26px] rounded-panel border border-line-9 bg-surface-1 p-8 shadow-[0_1px_2px_rgba(26,22,18,0.035),0_3px_12px_-6px_rgba(70,46,30,0.13)]">
      <h1 className="mb-2 font-serif text-[20px] leading-[30px] font-semibold text-ink-2">
        @{displayHandle(handle)} hasn’t launched a token
      </h1>
      <p className="mb-5 max-w-[52ch] text-[14px] leading-[22px] text-ink-10">
        This creator hasn’t opened a market yet, so there’s nothing to buy or spend here.
      </p>
      <div className="flex flex-wrap gap-3">
        <a
          href="/creators"
          className="rounded-card bg-surface-brand-12 px-5 py-2.5 text-[14px] leading-[22px] font-bold text-ink-27 hover:bg-surface-brand-17"
        >
          Browse creators
        </a>
        <a
          href="/creators/launch"
          className="rounded-card border border-line-11 px-5 py-2.5 text-[14px] leading-[22px] font-bold text-ink-2 hover:bg-surface-16"
        >
          Launch your own token
        </a>
        <a
          href={`/@${handle}`}
          className="rounded-card border border-line-11 px-5 py-2.5 text-[14px] leading-[22px] font-bold text-ink-2 hover:bg-surface-16"
        >
          Back to @{displayHandle(handle)}
        </a>
      </div>
    </div>
  </TokenShell>
);

export const MarketLoading: FC = () => {
  const { t } = useTranslation('common_blog');
  return (
    <TokenShell>
      <div className="mt-[26px] rounded-panel border border-line-9 bg-surface-1 p-[26px]">
        <LumenLoader size="md" label={t('global.loading_market')} />
      </div>
    </TokenShell>
  );
};
