'use client';

import { useMemo, useState } from 'react';
import type { Entry } from '@hive/common-hiveio-packages/wax';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Link, LumenLoader, UserAvatarImg } from '@hive/ui';
import TimeAgo from '@hive/ui/components/time-ago';
import { cn, numberWithCommas, prepareVotes } from '@ui/lib/utils';
import { useActiveVotesQuery } from '../../components/hooks/use-active-votes';

// TODO i18n - staged copy.
const COPY = {
  title: (n: number) => `${numberWithCommas(String(n))} ${n === 1 ? 'vote' : 'votes'}`,
  description: 'Everyone who upvoted this, with what their vote is worth.',
  loading: 'Loading votes…',
  failed: "The votes couldn't be loaded just now.",
  retry: 'Try again',
  empty: 'No upvotes yet.',
  byValue: 'Value',
  byRecent: 'Recent'
};

type Sort = 'value' | 'recent';

/**
 * Every upvoter on a post or comment (2026-09-25, owner: the hover's "and N more"
 * "needs to be clickable and open a pop up in our style. Peakd has that, copy theirs
 * make it look like our design"). PeakD's list is voter, value, weight and time,
 * sortable; the shell is ProposalVotersDialog's (same Dialog, width, row and avatar),
 * so it reads as one of ours.
 *
 * Upvotes only, the same roster as the hover (votes-details-data.tsx explains why
 * downvoters are not listed). Reads the query the hover already filled, so opening
 * it costs nothing when the hover came first.
 */
export default function PostVotersDialog({
  post,
  open,
  onOpenChange
}: {
  post: Entry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [sort, setSort] = useState<Sort>('value');
  const { data, isLoading, isError, refetch, isRefetching } = useActiveVotesQuery(post.author, post.permlink);

  const votes = useMemo(() => {
    if (!data) return [];
    const up = prepareVotes(post, data).filter((v) => v.rshares > 0);
    return up.sort((a, b) => (sort === 'value' ? b.rshares - a.rshares : (b.timestamp ?? 0) - (a.timestamp ?? 0)));
  }, [data, post, sort]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[92vw] sm:max-w-[440px]" data-testid="post-voters-dialog">
        <DialogHeader>
          <DialogTitle data-testid="post-voters-dialog-title">{data ? COPY.title(votes.length) : 'Votes'}</DialogTitle>
          <DialogDescription>{COPY.description}</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <LumenLoader size="sm" label={COPY.loading} />
        ) : isError ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center" role="alert">
            <p className="font-sans text-caption font-semibold text-destructive">{COPY.failed}</p>
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isRefetching}
              className="rounded-control border border-line-11 bg-surface-1 px-4 py-2 font-sans text-caption font-semibold text-ink-7 transition-colors hover:bg-surface-16 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {COPY.retry}
            </button>
          </div>
        ) : votes.length === 0 ? (
          <p className="py-8 text-center font-sans text-caption text-ink-10">{COPY.empty}</p>
        ) : (
          <>
            {/* Same two-choice toggle as the Studio inbox's Requests / Messages. */}
            <div className="flex gap-1.5 justify-self-start rounded-card border border-line-6 bg-[var(--amb-1)] p-[5px] dark:bg-surface-23">
              {(
                [
                  ['value', COPY.byValue],
                  ['recent', COPY.byRecent]
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSort(id)}
                  aria-pressed={sort === id}
                  style={sort === id ? { boxShadow: 'var(--tab-active-glow)' } : undefined}
                  className={cn(
                    'rounded-control px-3.5 py-1 font-sans text-caption font-medium transition-colors',
                    sort === id ? 'bg-[var(--lum-1)] text-ink-2 dark:bg-surface-1' : 'text-ink-10 hover:text-ink-2'
                  )}
                  data-testid={`post-voters-sort-${id}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <ul className="max-h-[60vh] overflow-y-auto" data-testid="post-voters-dialog-list">
              {votes.map((vote) => (
                <li
                  key={vote.voter}
                  className="flex items-center gap-3 border-b border-line-2 py-2.5 last:border-b-0"
                  data-testid="post-voters-dialog-row"
                >
                  <Link href={`/@${vote.voter}`} className="shrink-0" tabIndex={-1} aria-hidden>
                    <UserAvatarImg username={vote.voter} pixelSize={32} radiusClassName="rounded-control" />
                  </Link>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/@${vote.voter}`}
                      className="block truncate font-sans text-caption font-semibold text-ink-4 hover:underline"
                    >
                      {vote.voter}
                    </Link>
                    <span className="font-sans text-label text-ink-14">
                      {vote.percent}% · <TimeAgo date={vote.timestamp ?? vote.time} />
                    </span>
                  </div>
                  <span className="shrink-0 tabular-nums font-sans text-caption font-semibold text-ink-7">
                    ${Math.abs(Number(vote.reward ?? 0)) < 0.005 ? '0.00' : Number(vote.reward).toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
