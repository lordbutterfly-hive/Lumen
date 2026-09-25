'use client';

import { FC, ReactNode } from 'react';
import { useLivePortfolio } from '@/blog/features/creator-tokens/live/use-live-portfolio';
import { useLiveStudio } from '@/blog/features/creator-tokens/live/use-live-studio';
import { MyAsksList } from '@/blog/features/creator-tokens/ui/your-tokens/your-tokens-view';
import StudioRequests from '@/blog/features/creator-tokens/ui/studio/studio-requests';

// TODO i18n - staged copy, the wallet's and the Studio's own sentences for the same states.
const COPY = {
  toYou: 'Requests to you',
  yours: 'Your requests',
  unavailable: 'Meritum isn’t available on this build yet.',
  accountsFailed:
    'We couldn’t check which wallets are linked to this account, so we can’t list your requests. Nothing is wrong with them. Reload in a moment.',
  accountsLoading: 'Checking which wallets are linked to this account…',
  toYouFailed: 'Requests made to you couldn’t be checked just now. This is not an empty list.',
  retry: 'Try again'
};

const Note: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="rounded-card border border-dashed border-line-11 px-5 py-6 text-center text-[14px] leading-[22px] text-ink-14 font-ui">
    {children}
  </div>
);

const Heading: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="text-label font-medium uppercase tracking-wide text-ink-14 font-ui">{children}</div>
);

/** The buyer's side: the wallet's own asks list, with the states that come before it. */
const YourAsks: FC = () => {
  const p = useLivePortfolio();
  if (p.unavailable) return <Note>{COPY.unavailable}</Note>;
  if (p.accountsFailed) return <Note>{COPY.accountsFailed}</Note>;
  if (p.accountsLoading) return <Note>{COPY.accountsLoading}</Note>;
  return <MyAsksList p={p} />;
};

/**
 * The inbox's Meritum tab (owner, 2026-09-25: "if i made a request currently I need to open
 * my wallet and go to meritum to check if he responded. so put that in the inbox but
 * separate it from other normal messages"; of a creator's incoming ones: "both stay").
 *
 *  - Requests to you: a creator's incoming requests, the Studio's own list (`StudioRequests`,
 *    with its "Deliver and get paid" dialog), shown when the account has a market. The
 *    Studio keeps its copy. A market read that failed says so; it never reads as "none".
 *  - Your requests: the wallet's own list (`MyAsksList`). The wallet keeps its copy.
 */
const InboxAsks: FC = () => {
  const studio = useLiveStudio();
  const readFailed = studio.status === 'error' || studio.status === 'rate-limited' || studio.status === 'session-unavailable';
  const isCreator = Boolean(studio.market);

  if (!isCreator && !readFailed) return <YourAsks />;
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2.5" data-testid="inbox-asks-to-you">
        <Heading>{COPY.toYou}</Heading>
        {isCreator ? (
          <StudioRequests studio={studio} />
        ) : (
          <Note>
            {COPY.toYouFailed}{' '}
            <button
              type="button"
              onClick={() => (studio.status === 'session-unavailable' ? studio.retrySession() : studio.retry())}
              className="font-medium text-ink-brand-6 underline"
            >
              {COPY.retry}
            </button>
          </Note>
        )}
      </section>
      <section className="flex flex-col gap-2.5" data-testid="inbox-asks-yours">
        <Heading>{COPY.yours}</Heading>
        <YourAsks />
      </section>
    </div>
  );
};

export default InboxAsks;
