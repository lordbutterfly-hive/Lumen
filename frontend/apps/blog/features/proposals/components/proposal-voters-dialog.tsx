'use client';

import { ReactNode, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Link,
  LumenLoader,
  UserAvatarImg
} from '@hive/ui';
import { numberWithCommas } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import { useProposalVoters } from '../hooks/use-proposal-voters';
import { formatHp } from '../lib/proposals-format';

interface Props {
  proposalId: number;
  children: ReactNode;
}

/**
 * "Who voted for this" — opens from the HP figure on a proposal card (see
 * ProposalSupportFooter, the one caller). Matches PeakD/hive.blog/Ecency: a
 * dialog listing every direct voter, avatar + name + their own HP, sorted
 * descending.
 *
 * Lazy: `useProposalVoters` is only `enabled` while `open` is true, so
 * loading the page never fetches a single voter roster — the read is
 * expensive (see proposals-api.ts's `getProposalVoters` doc block) and most
 * cards are never opened.
 *
 * ★ CAPPED, NOT VIRTUALISED (2026-08-28). The server already returns at most
 * 200 rows — the genuine top 200 by HP, sorted on the full roster before the
 * cut (see app/api/proposal-votes/route.ts) — so the DOM here never renders
 * more than that regardless of how large a proposal's real voter count is
 * (measured live: up to 1,831). 200 rows is cheap enough to render directly
 * inside a scrolling `<ul>`; adding a virtualisation library for a bound this
 * small would be a second thing to maintain for no measurable benefit. `total`
 * always reports the real, uncapped count, both in the title and in the
 * "and N more" footer when the roster is bigger than what was sent.
 */
export default function ProposalVotersDialog({ proposalId, children }: Props) {
  const { t } = useTranslation('common_blog');
  const [open, setOpen] = useState(false);
  const { voters, total, isLoading, isError, hasData, isRetrying, refetch } = useProposalVoters(proposalId, open);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      {/* `max-w-[92vw]` is the same phone-width gutter dialog-login.tsx uses.
          A bare `max-w-[440px]` (what this feature's other dialogs, e.g.
          set-proxy-dialog.tsx, use) loses to `DialogContent`'s own `w-full`
          below 440px, so the box would touch both viewport edges at 390px —
          dialog-login's `92vw`/`480px` split is the already-hardened fix for
          that, worth matching here since a phone width is an explicit
          requirement for this dialog specifically. */}
      <DialogContent className="max-w-[92vw] sm:max-w-[440px]" data-testid="proposal-voters-dialog">
        <DialogHeader>
          <DialogTitle data-testid="proposal-voters-dialog-title">
            {hasData
              ? t('proposals.voters_dialog.title_with_count', {
                  count: total,
                  value: numberWithCommas(String(total))
                })
              : t('proposals.voters_dialog.title')}
          </DialogTitle>
          <DialogDescription>{t('proposals.voters_dialog.description')}</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <LumenLoader size="sm" label={t('proposals.voters_dialog.loading')} />
        ) : isError ? (
          // ★ A FAILED READ IS NOT "NO VOTES" (2026-08-28 — this codebase has a
          // documented history of exactly that mistake, e.g. the follow lists'
          // "empty vs unavailable" fix in follow-list-view.tsx and the creator-
          // tokens `collapseRead` rule). `isError` only ever comes from the
          // fetch actually failing — see use-proposal-voters.ts.
          <div
            className="flex flex-col items-center gap-3 py-8 text-center"
            data-testid="proposal-voters-dialog-error"
            role="alert"
          >
            <p className="font-sans text-caption font-semibold text-destructive">
              {t('proposals.voters_dialog.error')}
            </p>
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isRetrying}
              className="rounded-control border border-line-11 bg-surface-1 px-4 py-2 font-sans text-caption font-semibold text-ink-7 transition-colors hover:bg-surface-16 disabled:cursor-not-allowed disabled:opacity-60"
              data-testid="proposal-voters-dialog-retry"
            >
              {isRetrying ? t('proposals.voters_dialog.retrying') : t('proposals.voters_dialog.retry')}
            </button>
          </div>
        ) : voters.length === 0 ? (
          <p
            className="py-8 text-center font-sans text-caption text-ink-10"
            data-testid="proposal-voters-dialog-empty"
          >
            {t('proposals.voters_dialog.empty')}
          </p>
        ) : (
          <>
            {/* ★ THE LIST IS ITS OWN SCROLL CONTAINER, DELIBERATELY NOT LEFT TO
                THE DIALOG SHELL. `DialogContent`'s own portal wrapper
                (`packages/ui/components/dialog.tsx`, the `DialogPortal`
                function) carries no `overflow-y-auto` — only the separate
                `DialogContentBare` wrapper does. dialog-login.tsx's own
                comment says "DialogContent's wrapper carries overflow-y-auto"
                citing that file, which does not match what's actually there
                today (COULD NOT DETERMINE whether that comment is stale or
                describes behaviour this read missed). Rather than depend on
                resolving that, this list bounds its own height and scrolls
                regardless of what the shell does above it — correct either
                way. */}
            <ul className="max-h-[60vh] overflow-y-auto" data-testid="proposal-voters-dialog-list">
              {voters.map(({ voter, hp }) => (
                <li
                  key={voter}
                  className="flex items-center gap-3 border-b border-line-2 py-2.5 last:border-b-0"
                  data-testid="proposal-voters-dialog-row"
                >
                  <Link href={`/@${voter}`} className="shrink-0" tabIndex={-1} aria-hidden>
                    <UserAvatarImg username={voter} pixelSize={32} radiusClassName="rounded-control" />
                  </Link>
                  <Link
                    href={`/@${voter}`}
                    className="min-w-0 flex-1 truncate font-sans text-caption font-semibold text-ink-4 hover:underline"
                  >
                    {voter}
                  </Link>
                  <span className="shrink-0 tabular-nums font-sans text-caption font-semibold text-ink-7">
                    {formatHp(hp)}
                  </span>
                </li>
              ))}
            </ul>
            {total !== undefined && total > voters.length ? (
              <p
                className="pt-1 text-center font-sans text-caption text-ink-10"
                data-testid="proposal-voters-dialog-capped"
              >
                {t('post_content.footer.and_more', { value: numberWithCommas(String(total - voters.length)) })}
              </p>
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
