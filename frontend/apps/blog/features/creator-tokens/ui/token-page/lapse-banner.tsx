'use client';

import { FC, useState } from 'react';
import { getStorageItem, setStorageItem, StorageTTL } from '@ui/lib/storage-with-ttl';
import { lapseDismissKey, lapseNoticeFor, shouldOfferRenewNow, type LapseState, type RenewRefusal } from '../../market/lapse';
import { writeFailureMessage } from '../write-failure';

/**
 * THE CREATOR'S OWN NOTICE THAT THEIR LISTING IS RUNNING OUT, OR HAS.
 *
 * ★★ ONLY THE CREATOR SEES THIS. Everything here is addressed to the person who
 * owes the bill — "your market", "renew" — and the page already carries separate,
 * reader-facing banners for wind-down, overdue and delinquency. A buyer being
 * told to renew somebody else's subscription is nonsense; a buyer being told the
 * market is not taking money is the OTHER banner's job.
 *
 * ★★★ THREE STATES, AND `unknown` RENDERS NOTHING. `lapseStateOf` returns
 * `unknown` when the head or the phase could not be read, and this component
 * draws nothing for it. Telling a creator their market has been delisted because
 * one read failed would be this feature's silent-zero fault at its worst — the
 * statement is about their livelihood and they would have no way to tell a
 * broken page from a broken market.
 *
 * ★ DISMISSIBLE ONLY WHILE IT IS A WARNING. `expiring` is a heads-up and can be
 * put away. `grace` and `delisted` are not warnings any more, they are the
 * current state of the market, and a state is not something a reader gets to
 * dismiss — it goes away by being fixed.
 *
 * ★ THE DISMISSAL IS KEYED ON THE `paidUntilBlock` IT WAS SHOWN AGAINST
 * (`lapseDismissKey`), which is what makes paying dismiss it without any
 * invalidation of ours: `Renew` moves that block forward, so the next render
 * asks about a key nobody has dismissed. It is also why next month's warning
 * fires for a creator who dismissed this month's.
 */
const LapseBanner: FC<{
  state: LapseState;
  /** NULL when the chain would accept a renewal; otherwise why it would not. Drives both the sentence and whether a pay control appears. */
  renewRefusal: RenewRefusal | null;
  /** The creator this page belongs to, as the handle is written. Keys the dismissal. */
  creator: string;
  /** The subscription period the notice is about. Keys the dismissal. */
  paidUntilBlock: number;
  /** The same `renew` write Creator Studio uses, including its confirmation poll. */
  onRenew: () => Promise<void>;
  busy: boolean;
}> = ({ state, renewRefusal, creator, paidUntilBlock, onRenew, busy }) => {
  const dismissKey = lapseDismissKey(creator, paidUntilBlock);
  // Read once on mount. `getStorageItem` returns null when storage is blocked
  // (private mode) or the key was never set, and both mean "show it" — the safe
  // failure for a notice is to appear.
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return getStorageItem<boolean>(dismissKey) === true;
    } catch {
      return false;
    }
  });
  const [failure, setFailure] = useState<string | null>(null);
  // ★ SAME-TAB IN-FLIGHT GUARD (the twin of the Studio's, 2026-09-01). renew
  // STACKS periods and has no on-chain backstop, so after a
  // CREATOR_TOKENS_RENEW_UNCONFIRMED the pay button must NOT stay live for a
  // confused second click. The cross-tab lock (runUnderTxClaim on this page's
  // renew write) covers OTHER tabs; this covers this one. Reset on remount, i.e.
  // when the banner re-renders for the next period.
  const [renewUnconfirmed, setRenewUnconfirmed] = useState(false);

  const notice = lapseNoticeFor(state, renewRefusal);
  if (notice === null) return null;

  const isWarning = state.kind === 'expiring';
  if (isWarning && dismissed) return null;

  // Keep the original state gate (only expiring/grace/delisted ever offered a
  // renew), and add the unconfirmed guard the Studio uses via shouldOfferRenewNow.
  const offerRenew =
    (state.kind === 'expiring' || state.kind === 'grace' || state.kind === 'delisted') &&
    shouldOfferRenewNow({ renewRefusal, renewUnconfirmed });
  // `delisted` is the state the owner most needs to act on, so it is the loud
  // one; the two earlier states are the same warning styling the rest of this
  // page already uses for overdue and delinquency.
  const loud = state.kind === 'delisted';

  return (
    <div
      data-testid="lapse-banner"
      data-lapse-kind={state.kind}
      className={`mb-4 rounded-card border px-5 py-4 ${
        loud
          ? 'border-line-brand-3 bg-surface-brand-7 text-ink-brand-6'
          : 'border-line-warn-2 bg-surface-warn-4 text-ink-warn-3'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className={`text-[14px] leading-[22px] font-medium font-ui ${loud ? 'text-[15px] leading-[24px]' : ''}`}>
          {notice}
        </span>
        <div className="flex flex-shrink-0 items-center gap-2">
          {offerRenew ? (
            <button
              type="button"
              data-testid="lapse-banner-renew"
              disabled={busy}
              onClick={async () => {
                setFailure(null);
                try {
                  await onRenew();
                } catch (err) {
                  // ★ A RENEW that reached Hive but not yet Magi hides the pay
                  // button (no double-charge) rather than re-enabling it; the
                  // banner clears itself once kPaidUntil advances on the next read.
                  if (err instanceof Error && err.message.startsWith('CREATOR_TOKENS_RENEW_UNCONFIRMED:')) setRenewUnconfirmed(true);
                  // The REAL reason, not a guess — the same messaging every
                  // other write on this page uses.
                  setFailure(writeFailureMessage(err, 'That payment didn’t go through.'));
                }
              }}
              className="rounded-control bg-surface-brand-12 px-4 py-2 text-caption font-medium text-ink-27 font-ui hover:bg-surface-brand-17 disabled:opacity-50"
            >
              {/* No promise about when it clears: the label says what the click
                  does, and the banner's own disappearance is the confirmation —
                  `onRenew` resolves only once `kPaidUntil` has actually moved. */}
              {busy ? 'Confirming…' : 'Renew ~$10'}
            </button>
          ) : null}
          {isWarning ? (
            <button
              type="button"
              data-testid="lapse-banner-dismiss"
              onClick={() => {
                setDismissed(true);
                try {
                  setStorageItem(dismissKey, true, StorageTTL.UI_STATE);
                } catch {
                  // Storage blocked. The banner is already hidden for this
                  // session; it returning on the next visit is the safe failure.
                }
              }}
              className="rounded-control border border-line-11 bg-surface-1 px-3 py-2 text-caption font-medium text-ink-10 font-ui hover:border-line-28"
            >
              Dismiss
            </button>
          ) : null}
        </div>
      </div>
      {failure ? <div className="mt-2 text-caption font-medium text-ink-brand-6 font-ui">{failure}</div> : null}
    </div>
  );
};

export default LapseBanner;
