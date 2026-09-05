'use client';

import { cn } from '@ui/lib/utils';
import { UserAvatarImg } from '@ui/components';
import { useTranslation } from '@/blog/i18n/client';
import { displayHandle, dueLabelFor } from '../../live/adapt';
import { FC, useState, useEffect, useRef } from 'react';
import { useLiveStudio, type LiveStudio } from '../../live/use-live-studio';
import { MarketLoading, MarketRateLimited, MarketReadFailed, MarketSessionUnavailable, MarketUnavailable } from '../../live/market-states';
import type { Ask } from '../../types';
import { pctLabel, usdPrice, usdWhole, usdWholeNonZero } from '../../market/format';
// ★★ THE FLOOR / RESERVE FIGURES ARE HIDDEN FOR LAUNCH (owner, 2026-08-27), on
// every surface at once, from one flag. The creator's dashboard is one of the
// four; nothing here is deleted, and every expression returns with the flag.
import { SHOW_BACKING_FIGURES } from '../../backing-visibility';
import { sellQuote, serviceQuote, serviceSupplyShareProblem, MIN_NET_DEFAULT_TOLERANCE_BPS } from '../../market/curve';
import TokenShell from '../token-shell';
import { writeFailureMessage } from '../write-failure';
import { MAX_HASH_LEN, hashFieldProblem } from '../../lib/vsc/payload-contract';
import { MAX_CAP_CREDITS_BASE_UNITS, MAX_OFFERINGS } from '../../lib/contract-math';
import ModalShell from '../modal-shell';
import { offerTitleProblem } from '../../lib/vsc/op-builders';
import WorkLinkField from '../work-link-field';
import { creatorOracleNotice } from '../../market/oracle-copy';
import { lapseNoticeFor, lapseStateOf, shouldOfferRenewNow } from '../../market/lapse';
import DmInboxPanel from '@/blog/features/direct-messages/ui/dm-inbox-panel';
import { useOwnDmRegistration, useDmUnread } from '@/blog/features/direct-messages/live/use-direct-messages';

type Section = 'overview' | 'inbox' | 'offerings' | 'market' | 'billing' | 'earnings';
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'offerings', label: 'Offerings' },
  { id: 'market', label: 'Market' },
  { id: 'billing', label: 'Billing' },
  { id: 'earnings', label: 'Earnings' }
];

const tok = (n: number) => n.toFixed(2);
const Card: FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div
    className={`rounded-panel border border-line-9 bg-surface-1 p-5 shadow-[0_1px_2px_rgba(26,22,18,0.035),0_3px_12px_-6px_rgba(70,46,30,0.13)] ${className}`}
  >
    {children}
  </div>
);
const Stat: FC<{ label: string; value: string; sub?: string; green?: boolean }> = ({
  label,
  value,
  sub,
  green
}) => (
  <div>
    <div className="text-label font-medium uppercase tracking-wide text-ink-14 font-ui">{label}</div>
    <div className={`mt-1 text-[22px] leading-[34px] font-medium tabular-nums font-ui ${green ? 'text-ink-ok-2' : 'text-ink-2'}`}>
      {value}
    </div>
    {sub ? <div className="mt-0.5 text-caption tabular-nums text-ink-10 font-ui">{sub}</div> : null}
  </div>
);

// Controlled service-price editor: reverts an invalid entry to the committed
// price so the field never lies (#4), and re-syncs when the stored price changes.
// onCommit now reports whether the store actually changed the price — a
// refusal (an invalid amount, or an unknown service key) reverts the field
// exactly like a locally-invalid entry does, rather than leaving it showing
// an unconfirmed number the store silently ignored.
// ★ REVERTING IS NOT REPORTING (2026-08-09). Every refusal here — a bad
// amount, or the chain declining via the 2x/7d anti-rug band — snapped the
// field back with NO message, so a creator who typed a legitimate new price saw
// it silently undone and could not tell that apart from a broken control.
// `onFailure` lets the parent say why in the banner it already renders.
// ★ THE CREATE-TIME SUPPLY-CAP GUARD IS WORTHLESS WITHOUT THIS ONE (2026-08-27).
// NewOfferingRow refuses a service priced at an unreachable share of total
// supply, and this control edits the price of an offering that already exists —
// so post at $5, come back, type $500, and the guard is behind you. The chain
// does not backstop it (nothing on chain relates an offering price to kCap), so
// an unguarded edit path IS the whole vulnerability. `problemOf` is checked
// before the broadcast and reverts exactly like a locally-invalid amount.
const PriceInput: FC<{
  value: number;
  onCommit: (usd: number) => Promise<void>;
  /** F7 fix: this type carried no way to disable the input at all — see the callers below, which now pass studio.isBusy. */
  disabled?: boolean;
  onFailure?: (message: string) => void;
  /** Returns a refusal sentence for a candidate price, or null to allow it. Never fires on a value it cannot judge. */
  problemOf?: (usd: number) => string | null;
}> = ({ value, onCommit, disabled, onFailure, problemOf }) => {
  const [txt, setTxt] = useState(String(value));
  useEffect(() => setTxt(String(value)), [value]);
  return (
    <input
      value={txt}
      disabled={disabled}
      inputMode="decimal"
      onChange={(e) => setTxt(e.target.value)}
      onBlur={async () => {
        const n = parseFloat(txt.replace(/,/g, ''));
        if (txt.trim() === String(value)) return;
        if (!Number.isFinite(n) || n <= 0) {
          setTxt(String(value));
          onFailure?.('Enter a price in dollars, greater than zero.');
          return;
        }
        // Refused locally, so nothing is signed and no RC is spent finding out.
        const problem = problemOf?.(n) ?? null;
        if (problem !== null) {
          setTxt(String(value));
          onFailure?.(problem);
          return;
        }
        onFailure?.('');
        // The commit is a signed broadcast now, and it can be REFUSED — most
        // often by the offering's own 2x/7d anti-rug band. Revert the field on
        // rejection so it never displays a price the chain did not accept.
        try {
          await onCommit(n);
        } catch (error) {
          setTxt(String(value));
          // Routed through writeFailureMessage (F7 note) so a machine-coded
          // refusal — including the new CREATOR_TOKENS_BUSY the F7 double-submit
          // guard below can now throw — never paints its raw "CODE: " prefix
          // into this banner.
          onFailure?.(`The price stayed at $${value}. ${writeFailureMessage(error, 'The chain refused the change. A price may only move 2x per 7 days.')}`);
        }
      }}
      className="ml-1 w-[70px] border-0 text-[15px] leading-[24px] tabular-nums text-ink-2 font-num outline-none focus-visible:outline-none disabled:opacity-60"
    />
  );
};

/**
 * Rename a posted service in place.
 *
 * `setOfferingTitle` was wired all the way to the hook and had ZERO callers, so a
 * creator with a typo in a service name had to delist it and create a new one —
 * which is not cosmetic: the anti-rug price band is anchored to the TITLE, so
 * delete-and-recreate resets that anchor. Renaming keeps it.
 *
 * Reverts on refusal for the same reason PriceInput does: the chain can say no
 * (the title band, a control byte, a duplicate of another live offering) and the
 * field must never show a name the contract did not accept.
 */
const TitleInput: FC<{
  value: string;
  onCommit: (title: string) => Promise<void>;
  disabled?: boolean;
  onFailure?: (message: string) => void;
}> = ({ value, onCommit, disabled, onFailure }) => {
  const [txt, setTxt] = useState(value);
  useEffect(() => setTxt(value), [value]);
  return (
    <input
      value={txt}
      disabled={disabled}
      aria-label="Service name"
      onChange={(e) => setTxt(e.target.value)}
      onBlur={async () => {
        const next = txt.trim();
        // Unchanged, or emptied: put the old name back rather than broadcasting a
        // no-op (which still costs resource credits) or an empty title the
        // contract refuses anyway.
        if (next === value || next === '') {
          setTxt(value);
          return;
        }
        onFailure?.('');
        try {
          await onCommit(next);
        } catch (error) {
          setTxt(value);
          // Routed through writeFailureMessage (same F7 note as PriceInput
          // above): a machine-coded refusal — including CREATOR_TOKENS_BUSY,
          // reachable here too now that every studio write shares one guard —
          // must not paint its raw "CODE: " prefix into this banner.
          onFailure?.(`The name stayed "${value}". ${writeFailureMessage(error, 'The chain refused the rename.')}`);
        }
      }}
      className="w-full truncate border-0 bg-transparent text-[14px] leading-[22px] font-medium text-ink-2 font-ui outline-none focus-visible:outline-none focus:underline disabled:opacity-60"
    />
  );
};

const AnswerModal: FC<{ ask: Ask; studio: LiveStudio; onClose: () => void }> = ({ ask, studio, onClose }) => {
  const [text, setText] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // F7 fix: shared by BOTH buttons below (decline and answer are mutually
  // exclusive on one escrow) — see token-modals.tsx BuyModal's `inFlight`
  // doc for why a ref, not this `busy` useState, is what actually stops a
  // same-tick double-submit. `busy` stays for the disabled attribute and
  // the "Confirm in your wallet…" label.
  const inFlight = useRef(false);
  // core/ask.go:521 refuses a '|' in answerHash outright: the escrow record
  // is packed as a pipe-delimited string (core/ask.go:157), so one stray
  // pipe would re-partition it. maxLength handles the length bound; this
  // handles the character the browser cannot.
  const dueLabel = dueLabelFor(ask);
  const urgent = ask.status === 'awaiting' && ask.deadlineAt - Date.now() < 24 * 3600 * 1000;
  /**
   * ★★★ ONE VALIDATOR, SHARED WITH THE OP-BUILDER (2026-08-31, H-A(a)).
   *
   * This used to be hand-written here — non-empty, `length <= MAX_HASH_LEN`,
   * no pipe — and it DISAGREED with the contract in two ways a creator would
   * meet by accident:
   *
   *   · `length` is UTF-16 units, and the contract counts BYTES. Measured
   *     against the shared validator: 43 emoji is 86 units (passes the old
   *     check) and 172 BYTES (refused on chain). The creator signs, pays
   *     resource credits, the escrow does not release, and the miss is theirs.
   *   · a line break passed entirely. Pressing Enter for a second line is the
   *     single most ordinary thing to do in a multi-line box, and the contract
   *     refuses every control character.
   *
   * `hashFieldProblem` wraps the same `assertHashField` the op-builder calls, so
   * the two cannot drift again — the split IS what let them drift.
   */
  const answerProblem = text.trim().length > 0 ? hashFieldProblem('answerHash', text.trim()) : null;
  const answerValid = text.trim().length > 0 && answerProblem === null;
  // ★ THE WINDOW CAN CLOSE WHILE THIS MODAL IS OPEN (2026-08-30, clauderfly-43).
  // Expired escrows no longer reach the Inbox's action button at all (see
  // use-live-studio's inbox/expiredInbox split), but a creator can sit on an open
  // modal past the deadline, and BOTH writes are refused from that moment:
  // core/ask.go:615 (Answer) and core/ask.go:830 (Decline), each
  // ErrState "answer window closed". `dueLabelFor` returns undefined exactly then,
  // which is the same boundary, so the two cannot disagree.
  const windowClosed = dueLabel === undefined;
  return (
    <ModalShell width={500} onClose={onClose} title="Mark this job delivered" className="p-6">
      <div className="mb-2 font-ui text-xl font-medium text-ink-2">Mark this job delivered</div>
      {/* The contract carries a REFERENCE, not the brief (USER RULING
            2026-07-28): it facilitates payment and reputation, and the two
            parties arrange the work between themselves. Showing the reference is
            honest; pretending a message arrived here would not be. */}
      <div className="mb-3 rounded-control border border-line-9 bg-surface-16 px-3.5 py-3 text-caption text-ink-8 font-ui">
        Reference <strong className="font-mono">{ask.contentHash || '—'}</strong> · from @{displayHandle(ask.asker)}
      </div>
      {/* ★ THE DEADLINE, ON THE SCREEN WHERE IT IS DECIDED (A14, 2026-08-23).
          This modal asks a creator to commit to a job and showed them no clock at all,
          while `ask.deadlineBlock` was already on the object it hands to `studio.answer()`
          and `ask.deadlineAt` was already being formatted for the portfolio row. Missing
          the deadline is not free: the buyer reclaims and the contract records a miss
          against this creator. Same formatter as the portfolio (`dueLabelFor`), so the two
          surfaces cannot drift.

          `dueLabelFor` returns undefined once the deadline has passed, which is the case
          worth saying out loud rather than rendering nothing — a creator looking at a job
          they can no longer bank should be told so before they do the work. */}
      {dueLabel ? (
        <div
          className={cn(
            'mb-3 rounded-control px-3.5 py-2.5 text-caption font-medium font-ui',
            urgent ? 'bg-surface-warn-4 text-ink-warn-3' : 'bg-surface-16 text-ink-8'
          )}
          data-testid="answer-modal-deadline"
        >
          {dueLabel}
          {urgent ? ', under a day left' : null}
        </div>
      ) : (
        <div
          className="mb-3 rounded-control bg-surface-warn-4 px-3.5 py-2.5 text-caption font-medium text-ink-warn-3 font-ui"
          data-testid="answer-modal-deadline"
        >
          {/* ★ "MAY NO LONGER RELEASE" WAS A HEDGE ON A CERTAINTY (2026-08-30,
              clauderfly-43). Past the deadline the contract refuses both writes
              outright — ask.go:615 and ask.go:830. Both buttons below are disabled
              in this state, so the sentence has to say why rather than imply the
              creator might get lucky. */}
          The answer window has closed, so this can no longer be answered or declined. The buyer
          reclaims their tokens, and the chain records a miss against your delivery record.
        </div>
      )}
      <p className="mb-3 text-caption text-ink-10 font-ui">
        Arrange and deliver the work with @{displayHandle(ask.asker)} however you normally would. Marking it delivered
        releases the escrow to you, and the buyer then rates it, which is what your token’s reputation is
        built from.
      </p>
      {/* BOUNDED to exactly what core/ask.go:515-523 accepts. This box invites
            a link, and a tracking URL over MAX_HASH_LEN characters — or one
            carrying a "|" in a query parameter — is completely ordinary. The
            contract refuses both, but only AFTER the creator has signed with
            their active key and paid resource credits, and the escrow then does
            not release. Enforce it here, where it costs nothing. */}
      <textarea
        value={text}
        maxLength={MAX_HASH_LEN}
        onChange={(e) => {
          setText(e.target.value);
          setFailure(null);
        }}
        placeholder="Where did you deliver it? A link, a ticket number, “sent by email”…"
        className="h-[130px] w-full resize-y rounded-xl border border-line-11 px-4 py-3 font-ui text-[15px] leading-[24px] text-ink-2 outline-none focus-visible:outline-none focus:border-line-brand-10"
      />
      {/* ★ THE REASON, NOT JUST A DEAD BUTTON. A disabled control with no
          explanation reads as a broken page, and the failure it is standing in
          for is expensive: without this the creator signs, pays resource
          credits, the chain refuses the answer, the escrow never releases and
          the miss lands on their delivery record. The message is the shared
          validator's own, so it names the exact character or byte count. */}
      <div className="mt-1 flex justify-between gap-3 text-caption text-ink-14 font-ui">
        <span className={answerProblem ? 'font-medium text-ink-brand-6 font-ui' : 'font-ui'}>
          {answerProblem ?? 'Stored on chain as a public reference.'}
        </span>
        <span className="tabular-nums font-num">
          {text.length}/{MAX_HASH_LEN}
        </span>
      </div>
      <div className="mt-3 rounded-control bg-surface-18 px-3.5 py-2.5 text-caption text-ink-ok-2 font-ui">
        This pays you <strong className="tabular-nums font-num">{tok(ask.tokensEscrowed)} tokens</strong> and closes the job. It can’t be undone,
        and the buyer rates it afterwards.
      </div>
      <div className="mt-4 flex gap-3">
        {/* DECLINE, given equal weight to Cancel. It is the creator's free,
              honest "no": the asker gets everything back INCLUDING the
              commission, and it is explicitly not a miss against the delivery
              record. A studio that offered only Answer would push a creator to
              take a black mark for work they simply cannot do. */}
        <button
          onClick={async () => {
            // F7: synchronous — see the `inFlight` doc above.
            if (inFlight.current) return;
            inFlight.current = true;
            setBusy(true);
            setFailure(null);
            try {
              await studio.decline({ seq: ask.seq, deadlineBlock: ask.deadlineBlock });
              onClose();
            } catch (err) {
              // The REAL reason, not a guess. See ../write-failure.ts.
              setFailure(writeFailureMessage(err, 'That didn’t go through.'));
            } finally {
              inFlight.current = false;
              setBusy(false);
            }
          }}
          disabled={busy || windowClosed}
          className="flex-1 rounded-xl border border-line-11 py-3 text-[14px] leading-[22px] font-medium text-ink-10 font-ui disabled:opacity-50"
        >
          Decline &amp; refund
        </button>
        <button
          onClick={async () => {
            if (!answerValid) return;
            // F7: synchronous — see the `inFlight` doc above.
            if (inFlight.current) return;
            inFlight.current = true;
            setBusy(true);
            setFailure(null);
            try {
              // answerHash is the creator's own delivery NOTE/reference — a
              // link, a ticket number, "sent by email". The chain records that
              // something was handed over and pays out; it never judges what.
              await studio.answer({
                seq: ask.seq,
                deadlineBlock: ask.deadlineBlock,
                answerHash: text.trim()
              });
              onClose();
            } catch (err) {
              // The REAL reason, not a guess. See ../write-failure.ts.
              setFailure(writeFailureMessage(err, 'That didn’t go through.'));
            } finally {
              inFlight.current = false;
              setBusy(false);
            }
          }}
          disabled={busy || !answerValid || windowClosed}
          className="flex-1 rounded-xl bg-surface-brand-12 py-3 text-[14px] leading-[22px] font-medium text-ink-27 font-ui hover:bg-surface-brand-17 disabled:opacity-50"
        >
          {busy ? 'Confirm in your wallet…' : 'Mark as delivered'}
        </button>
      </div>
      {failure ? (
        <div className="mt-3 text-center text-caption font-medium text-ink-brand-6 font-ui">{failure}</div>
      ) : null}
    </ModalShell>
  );
};

const RetireModal: FC<{ handle: string; onConfirm: () => Promise<void>; onClose: () => void }> = ({
  handle,
  onConfirm,
  onClose
}) => {
  const [confirm, setConfirm] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // F7 fix: see token-modals.tsx BuyModal's `inFlight` doc. Retire is
  // ONCE-ONLY and irreversible — a double-submit here would waste RC on a
  // second call the contract already refuses, at worst.
  const inFlight = useRef(false);
  const ok = confirm.trim().toLowerCase().replace(/^@/, '') === handle.toLowerCase();
  return (
    <ModalShell
      width={500}
      onClose={onClose}
      title="End your Meritum?"
      className="border border-line-brand-1 p-6"
    >
      <div className="mb-2 font-ui text-xl font-medium text-ink-brand-6">End your Meritum?</div>
      <ul className="mb-4 space-y-1.5 font-ui text-[14px] leading-[22px] text-ink-8">
        <li>· The market freezes now. No new buys or asks.</li>
        <li>· You’re removed from discovery.</li>
        {/* ★ "refunded at the floor" until 2026-08-27. With the figure hidden
            (../../backing-visibility.ts) that phrase pointed at a number no
            longer anywhere in Studio. The MECHANISM is what a creator needs
            here, and it is the wording WIND_DOWN_BANNER already uses on the
            buyer side, so the two screens now describe one event the same way.
            Unguarded on purpose: it is true whether or not the stat is shown. */}
        {/* ★ 2026-08-30 (B3, copy set A): "refunded" promised principal back,
            automatically. Holders must Redeem themselves and get a slice of
            what the reserve holds, less their fee (refund.go). */}
        <li>· Holders can redeem a pro-rata slice of the reserve, less any early-exit fee. Nobody is refunded automatically.</li>
        <li>· Asks you’ve received still resolve. Answer them to get paid.</li>
        <li>· Your delivery record is lost. Coming back means a new token.</li>
        <li>· This can’t be undone.</li>
      </ul>
      <label className="mb-1.5 block text-caption font-medium text-ink-10 font-ui">
        Type your handle (@{handle}) to confirm
      </label>
      <input
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder={`@${handle}`}
        className="mb-4 w-full rounded-xl border border-line-11 px-4 py-3 text-[15px] leading-[24px] font-medium font-ui outline-none focus-visible:outline-none focus:border-line-brand-10 focus:ring-1 focus:ring-line-brand-10"
      />
      <div className="flex gap-3">
        <button
          onClick={onClose}
          className="flex-1 rounded-xl border border-line-11 py-3 text-[14px] leading-[22px] font-medium text-ink-10 font-ui"
        >
          Cancel
        </button>
        <button
          onClick={async () => {
            if (!ok) return;
            // F7: synchronous — see the `inFlight` doc above.
            if (inFlight.current) return;
            inFlight.current = true;
            // Retire is IRREVERSIBLE on-chain. Close only after the broadcast
            // resolves — closing early would tell a creator they had ended
            // their market while the signer was still open, and there is no
            // undo to fall back on.
            setBusy(true);
            setFailure(null);
            try {
              await onConfirm();
              onClose();
            } catch (err) {
              // The REAL reason, not a guess. See ../write-failure.ts.
              setFailure(writeFailureMessage(err, 'Ending this token didn’t go through.'));
            } finally {
              inFlight.current = false;
              setBusy(false);
            }
          }}
          disabled={!ok || busy}
          className="flex-1 rounded-xl bg-surface-brand-12 py-3 text-[14px] leading-[22px] font-medium text-ink-27 font-ui hover:bg-surface-brand-17 disabled:opacity-50"
        >
          End my token
        </button>
      </div>
      {failure ? (
        <div className="mt-3 text-center text-caption font-medium text-ink-brand-6 font-ui">{failure}</div>
      ) : null}
    </ModalShell>
  );
};

/**
 * Add a service to the shop. Separate component so its own draft state cannot
 * re-render the whole studio on every keystroke — and so the create path reads
 * as its own thing rather than a footnote to the list.
 */
const NewOfferingRow: FC<{ studio: LiveStudio }> = ({ studio }) => {
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const usd = parseFloat(price.replace(/,/g, ''));
  // ★ VALIDATE THE TITLE WHILE IT IS BEING TYPED, not at the signature.
  // The contract refuses a comma, a pipe, control bytes, and anything over 64
  // characters (core/offerings.go validOfferTitle). Until 2026-08-21 nothing
  // client-side checked any of it: "Copy edit, 1k words" was accepted by this
  // form, signed, broadcast, INCLUDED IN A BLOCK, and then refused on chain with
  // an empty result, so the broadcast genuinely succeeded and nothing surfaced.
  // The creator's RC was spent and their offering did not exist.
  const titleProblem = title.trim() === '' ? null : offerTitleProblem(title);
  /**
   * ★ AND VALIDATE THE PRICE AGAINST THE CREATOR'S OWN SUPPLY CAP (2026-08-27).
   *
   * Same failure shape as the title rule above — a value this form accepted
   * without ever looking at it — except the chain does NOT refuse this one, so
   * there is no on-chain backstop at all. The offering is created, posted, and
   * priced at more tokens than the cap lets exist, so no buyer can reach it.
   *
   * ★★ NARROWED 2026-08-30 (owner: this error "should never fire"; B2). The
   * guard used to also refuse a service above 10% of the cap, and on the
   * owner's own 30-cap `hbd-temp` market that fired for every price a person
   * types ($4.26 and up, re-evaluated on every keystroke below = the "flashing"
   * he reported). It now refuses only the UNFILLABLE case, `tokens > cap`,
   * which is a chain fact rather than a heuristic. Reasoning and the live
   * numbers: market/curve.ts, serviceSupplyShareProblem's block.
   *
   * `studio.market` is nullable and the guard returns null on anything it
   * cannot judge, so a failed market read blocks nothing — see
   * serviceSupplyShareProblem's own note on why a guard that fires on a
   * missing number is worse than no guard.
   */
  const supplyProblem =
    studio.market === null ? null : serviceSupplyShareProblem(usd, studio.market.priceUsd, studio.market.cap);
  // M5 (2026-08-31): the contract keeps at most MAX_OFFERINGS live offerings, so
  // the 21st createOffering is refused AFTER the signature. Disable the form at
  // the cap rather than broadcast a doomed call. `offerings === null` is an
  // unread market, not a full one, so it does not gate.
  const atOfferingCap = (studio.offerings?.length ?? 0) >= MAX_OFFERINGS;
  const valid =
    title.trim().length > 0 && titleProblem === null && Number.isFinite(usd) && usd > 0 && supplyProblem === null && !atOfferingCap;
  return (
    <div className="mt-4 border-t border-line-2 pt-4">
      <div className="mb-2 text-caption font-medium text-ink-10 font-ui">Add a service</div>
      {atOfferingCap ? (
        <p className="mb-2 text-caption text-ink-warn-3 font-ui">
          You’ve reached the limit of {MAX_OFFERINGS} services. Delete one to add another.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setFailure(null);
          }}
          placeholder="e.g. Review my code"
          aria-invalid={titleProblem !== null}
          className={`min-w-[200px] flex-1 rounded-control border px-3 py-2 text-[14px] leading-[22px] font-ui outline-none focus-visible:outline-none focus:ring-1 ${
            titleProblem !== null
              ? 'border-line-warn-2 focus:border-line-warn-2 focus:ring-line-warn-2'
              : 'border-line-11 focus:border-line-brand-10 focus:ring-line-brand-10'
          }`}
        />
        <div className="flex items-center rounded-control border border-line-11 px-3 py-2 focus-within:border-line-brand-10 focus-within:ring-1 focus-within:ring-line-brand-10">
          <span className="text-ink-14 font-num">$</span>
          <input
            value={price}
            onChange={(e) => {
              setPrice(e.target.value);
              setFailure(null);
            }}
            inputMode="decimal"
            placeholder="0"
            className="ml-1 w-[80px] border-0 text-[14px] leading-[22px] tabular-nums font-num outline-none focus-visible:outline-none"
          />
        </div>
        <button
          onClick={async () => {
            if (!valid || studio.isBusy) return;
            setFailure(null);
            try {
              await studio.createOffering({ title: title.trim(), priceUsd: usd });
              setTitle('');
              setPrice('');
            } catch (err) {
              // The REAL reason, not a guess. See ../write-failure.ts.
              setFailure(writeFailureMessage(err, 'That didn’t go through.'));
            }
          }}
          disabled={!valid || studio.isBusy}
          className="rounded-control bg-surface-43 px-4 py-2 text-caption font-medium text-ink-27 font-ui disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {/* The typing-time problem takes precedence: it is actionable right now,
          whereas `failure` is the outcome of an attempt already made. */}
      {titleProblem ? (
        <div className="mt-2 text-caption font-medium text-ink-warn-3 font-ui">{titleProblem}</div>
      ) : supplyProblem ? (
        // Same precedence rule as the title: actionable-right-now beats the
        // outcome of an attempt already made.
        <div className="mt-2 text-caption font-medium text-ink-warn-3 font-ui">{supplyProblem}</div>
      ) : failure ? (
        <div className="mt-2 text-caption font-medium text-ink-brand-6 font-ui">{failure}</div>
      ) : null}
    </div>
  );
};

const CreatorStudio: FC = () => {
  // ★ THE ONLY `useTranslation` CALL IN THIS FILE (2026-08-30). Every other
  // string here is written inline — an existing convention this component did
  // not invent — but the repo's own rule is "never use inline strings for
  // user-facing text", and `WorkLinkField`'s copy below already lives in
  // `meritum_launch.*`, so the label next to it reuses that same namespace
  // rather than adding a second, untranslated one beside a translated one.
  const { t } = useTranslation('common_blog');
  const studio = useLiveStudio();
  // ★ DISCOVERABILITY (2026-09-05). A creator's messaging key used to register only when
  // they found and clicked the Messages sub-tab, so most creators were unreachable and
  // had no way to know. Registering on Studio open (any section) means a creator becomes
  // reachable simply by managing their token, which is what Studio is for. Idempotent and
  // de-duped within a session (useOwnDmRegistration), so this is one cheap upsert at most.
  useOwnDmRegistration();
  const { count: dmUnreadCount, markRead: markDmRead } = useDmUnread();
  const {
    market,
    inbox,
    rawInbox,
    expiredInbox,
    inboxUnavailable,
    inboxTruncated,
    inboxOlderNotScanned,
    positionUnavailable,
    servicesOracleStatus,
    subDaysLeft,
    tradeFeeClaimableUsd,
    commissionEarnedUsd,
    status
  } = studio;
  // ★ ITEM D (2026-09-04): honour a `?section=` query param so a deep-link (e.g.
  // the launch success screen's "add an offering in Studio" link,
  // /creators/studio?section=offerings) opens on the right tab instead of always
  // 'overview'. Validated against the known SECTIONS — an unknown value falls
  // back to 'overview' rather than rendering nothing. Read once in a lazy
  // initializer; `window` is guarded for the SSR pass of this client component.
  const [section, setSection] = useState<Section>(() => {
    if (typeof window === 'undefined') return 'overview';
    try {
      const requested = new URLSearchParams(window.location.search).get('section');
      if (requested && SECTIONS.some((s) => s.id === requested)) return requested as Section;
    } catch {
      // Malformed URL — fall back to the default tab.
    }
    return 'overview';
  });
  const [answering, setAnswering] = useState<Ask | null>(null);
  // Inbox sub-tab: paid-ask REQUESTS (money + deadlines) vs direct MESSAGES (off-chain,
  // no money). Kept separate, never merged — see the toggle note in the Inbox section.
  const [inboxTab, setInboxTab] = useState<'requests' | 'messages'>('requests');
  // ★ NEW-MESSAGE BADGE (2026-09-05, owner): opening the Messages tab clears the unread
  // badge by marking all incoming DMs read. Fires on navigation INTO the tab, not per
  // render (deps are the section/sub-tab + the stable markRead).
  useEffect(() => {
    if (section === 'inbox' && inboxTab === 'messages') void markDmRead();
  }, [section, inboxTab, markDmRead]);
  const [retireOpen, setRetireOpen] = useState(false);
  const [capInput, setCapInput] = useState('');
  const [sellInput, setSellInput] = useState('');
  const [sellFailure, setSellFailure] = useState<string | null>(null);
  // F5 fix (2026-08-19): this "Cash out" control had NO minNet parameter at
  // all — sell.go's checkMinNet floor was structurally unreachable from the
  // creator's own sell. See the derived defaultSellMinNetUsd below (and
  // token-modals.tsx's SellModal, which gets the identical treatment) for
  // why it defaults ON rather than needing to be discovered and typed.
  const [sellMinNetText, setSellMinNetText] = useState('');
  const [sellMinNetTouched, setSellMinNetTouched] = useState(false);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  // H-FE-8: the studio's fire-and-forget buttons (renew, deleteOffering, claimTradeFees)
  // used `void studio.X()`, silently swallowing a rejected write — the user clicked and
  // nothing happened, with no reason shown. Route them through here so a failure surfaces
  // via the same write-failure.ts messaging the modals already use.
  // S4 (2026-08-30): set only by a renew whose payment Hive accepted but Magi
  // has not yet recorded; renders the read-only "Check again" beside the banner.
  const [renewUnconfirmed, setRenewUnconfirmed] = useState(false);
  const runStudioAction = async (fn: () => Promise<unknown>, fallback: string): Promise<void> => {
    setActionFailure(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('CREATOR_TOKENS_RENEW_UNCONFIRMED:')) setRenewUnconfirmed(true);
      setActionFailure(writeFailureMessage(err, fallback));
    }
  };
  // Keep the cap field in sync with the committed cap after a successful raise (#3).
  const marketCap = market?.cap ?? null;
  useEffect(() => {
    if (marketCap !== null) setCapInput(String(marketCap));
  }, [marketCap]);

  // An account with NO key that can sign would open a signer that does not
  // exist on every button here; use-live-studio.ts's requireSigner refuses each
  // one, but only on click. launch-wizard.tsx:234 already gates its own Launch
  // button on exactly this, so the studio saying nothing was the inconsistency.
  //
  // ★ THIS USED TO READ `studio.isLite` ALONE, AND THAT LOCKED CREATORS OUT OF
  // THEIR OWN TOKEN (2026-08-21). A wallet-backed lite account can sign now that
  // the multichain rail is live. Two identities owning real, publicly tradeable
  // markets were shown "this account can't sign transactions yet" here and "No
  // Meritum yet" on their profile, while anyone else could buy the very token
  // they were told they did not have. The capability question is `canSign`;
  // `isLite` only says which KIND of account it is.
  if (studio.isLite && !studio.canSign) {
    return (
      <TokenShell back={{ href: '/creators', label: '← All creators' }}>
        <div className="mx-auto max-w-[560px] pt-16 text-center">
          <h1 className="font-ui text-3xl font-medium text-ink-2">Creator Studio</h1>
          <p className="mt-3 font-ui text-[15px] leading-[24px] text-ink-10">
            This account can’t sign transactions yet, so it can’t run a Meritum.{' '}
            <a href="/upgrade" className="font-medium text-ink-brand-6 hover:underline">
              Upgrade to a full account
            </a>{' '}
            to launch one. You can look through the steps first.
          </p>
          {/* ★ A signed-in lite account used to be worse off here than an anonymous
              visitor: the signed-out branch below offers a working link to the
              wizard, while this branch was a dead end with "upgrade" as plain
              TEXT and no route out of the page (found in live QA, 2026-08-07).
              Both exits are real links now, matching launch-wizard.tsx:179. */}
          <a
            href="/creators/launch"
            className="mt-6 inline-block rounded-card border border-line-9 px-6 py-3 text-[15px] leading-[24px] font-medium text-ink-2 font-ui hover:bg-surface-17"
          >
            Open the launch wizard
          </a>
        </div>
      </TokenShell>
    );
  }
  if (status === 'unavailable') return <MarketUnavailable launchHref="/creators/launch" />;
  if (status === 'loading') return <MarketLoading />;
  // A failed read must NOT fall through to the launch wizard: telling a creator
  // with a live market that they have no token, because the node blinked, is
  // exactly the "empty read rendered as real" failure this rewiring removes.
  // A 429 is a limit, not a failure: no "Try again" button, because retrying
  // just re-hits it (57, 2026-09-01) — the token page already treated it so.
  if (status === 'rate-limited') return <MarketRateLimited launchHref="/creators/launch" />;
  if (status === 'error') return <MarketReadFailed onRetry={studio.retry} launchHref="/creators/launch" />;
  // F14 fix: OUR session check failed, not the chain read — checked before
  // `!market` below, which would otherwise render this exactly like
  // status === 'missing' ("Launch your Meritum. Free to launch.") for a
  // creator who already has a live market. retrySession re-fires
  // /api/users/me itself; `retry` (used above) only re-reads chain queries,
  // which stay disabled while the creator identity is unknown.
  if (status === 'session-unavailable') return <MarketSessionUnavailable onRetry={studio.retrySession} />;

  // status === 'missing' -> genuinely no market yet (or signed out). The launch
  // wizard is the whole studio in that state.
  if (!market) {
    return (
      <TokenShell back={{ href: '/creators', label: '← All creators' }}>
        <div className="mx-auto max-w-[560px] pt-16 text-center">
          <h1 className="font-ui text-3xl font-medium text-ink-2">Launch your Meritum</h1>
          {/* ★ "FREE TO LAUNCH" ALONE READ AS A BAIT (2026-08-23, journey run). It is true,
              and so is "About $10 a month" at step 1 of the wizard and "~$10/month" in the
              Subscription card below - the reader met the free claim first and the cost
              second, on a different screen. Both facts now sit in the same breath, which
              costs one sentence and removes the reveal. Figures match `term_listed_value`
              ("About $10 a month.") and the Subscription card verbatim; if either moves,
              move all three. */}
          <p className="mt-3 font-ui text-[15px] leading-[24px] text-ink-10">
            One token, bound to your account, that trades on a live market and is spent on your services. Free
            to launch, then about $10 a month to stay listed. First month’s on the house.
          </p>
          <a
            href="/creators/launch"
            className="mt-6 inline-block rounded-card bg-surface-brand-12 px-6 py-3 text-[15px] leading-[24px] font-medium text-ink-27 font-ui hover:bg-surface-brand-17"
          >
            Open the launch wizard
          </a>
        </div>
      </TokenShell>
    );
  }

  // `supplyPct` / `supplyPctLabel` (the 2026-08-21 "0%" twin fix) were deleted
  // with the cap displays they fed (owner, 2026-08-30); nothing on this screen
  // divides by the cap any more.
  /**
   * ★★★ THE SUBSCRIPTION STATE IS THE CHAIN'S PHASE, NOT A DAY COUNT (2026-08-31).
   *
   * This was `subDaysLeft <= 0`, and `subDaysLeft` FLOORS
   * (`use-live-studio.ts:389` -> `blocksToDays`), so it read 0 in two states
   * that are not a lapse and printed "Your listing has lapsed" in both:
   *
   *   - HOURS LEFT on a paid, ACTIVE listing. The creator was told their
   *     listing had lapsed up to a full day before it had.
   *   - A FAILED CHAIN READ. `subDaysLeft` is `chainMarket ? … : 0`, so a
   *     broken read produced the same confident claim about the creator's
   *     livelihood with no evidence behind it whatsoever. That is this
   *     feature's silent-zero fault sitting on the one screen a creator acts
   *     from, and `market/lapse.ts` exists because of it.
   *
   * `lapseStateOf` answers this from block comparisons against a head read
   * from the chain, and returns `unknown` rather than inventing a state — so a
   * failed read now says NOTHING instead of saying something false.
   */
  const lapse = lapseStateOf({
    phase: market.phase,
    paidUntilBlock: market.paidUntilBlock,
    graceExpiresAtBlock: market.graceExpiresAtBlock,
    headBlock: market.headBlock,
    windingDown: market.windingDown
  });
  const overdue = lapse.kind === 'grace' || lapse.kind === 'delisted';
  /** The head or the phase could not be read. Show a dash, never a number. */
  const subUnknown = lapse.kind === 'unknown';
  const held = market.position?.tokens ?? 0;

  // F5 fix: "Cash out" preview + default floor, same math and same shape as
  // token-modals.tsx's SellModal (sellQuote + MIN_NET_DEFAULT_TOLERANCE_BPS)
  // — a creator selling their own tokens is still an ordinary curve sell.
  const sellTokens = parseFloat(sellInput.replace(/,/g, '')) || 0;
  const sellPreview = sellQuote(sellTokens, market, market.position?.heldDays ?? 999);
  const defaultSellMinNetUsd =
    sellPreview.receiveUsd > 0 ? (sellPreview.receiveUsd * (10_000 - MIN_NET_DEFAULT_TOLERANCE_BPS)) / 10_000 : 0;
  const sellMinNetParsed = parseFloat(sellMinNetText.replace(/,/g, ''));
  const sellMinNetUsd = sellMinNetTouched
    ? Number.isFinite(sellMinNetParsed) && sellMinNetParsed > 0
      ? sellMinNetParsed
      : undefined
    : defaultSellMinNetUsd > 0
      ? defaultSellMinNetUsd
      : undefined;
  const sellMinNetDisplay = sellMinNetTouched ? sellMinNetText : defaultSellMinNetUsd > 0 ? defaultSellMinNetUsd.toFixed(2) : '';

  /**
   * ★★★ ONE SENTENCE WAS DOING THREE DIFFERENT JOBS, AND WAS WRONG AT TWO OF THEM
   * (2026-08-31, found in the browser on the demo build).
   *
   * The banner read "Your listing has lapsed. Renew to stay in discovery.
   * Answering and cashing out still work." on EVERY market whose subscription
   * had run out — and it rendered identically for three states that mean
   * different things:
   *
   *   OVERDUE  still buyable inside the grace window. The sentence was RIGHT
   *            here: discovery is the thing at stake and buying still works.
   *   FROZEN   buying is SHUT (`canBuy` false). "stay in discovery" is the
   *            softer, wronger truth — the token page's own banner says "not
   *            taking buyers", so the product said two different things about
   *            one state, and the Studio's was the one that understated it.
   *   CLOSED   the market has WOUND DOWN. Calling that "lapsed" is simply
   *            false, and the Renew button beside it was a dead control: the
   *            chain refuses a renewal on a closed market (`renewRefusal` is
   *            'closed'), so pressing it could only ever fail. That is the
   *            fault class this feature has now fixed on six other surfaces.
   *
   * So the banner branches, and the CTA is gated on the chain's own answer
   * rather than on "the subscription has run out": `renewRefusal === null` is
   * exactly "the contract would accept a payment right now", which is the only
   * honest precondition for offering a pay button.
   */
  const canRenewNow = market.renewRefusal === null;
  /**
   * ★★★ THE CONTROL GATE, DELIBERATELY NOT `canRenewNow` (2026-08-31).
   *
   * `canRenewNow` means "the chain would accept a payment" and is what the COPY
   * branches on. It is TRUE during a RENEW_UNCONFIRMED — the market is still
   * ACTIVE and the contract would take the money — which is exactly when a pay
   * button must NOT be on screen: `renew` STACKS from max(paidUntil, block), so
   * a second broadcast does not retry the first, it buys a SECOND MONTH.
   *
   * This file already knew that: it says so in the S4 comment beside the
   * read-only "Check again", and then left BOTH primary pay controls live next
   * to it. Third instance of that pattern in this feature (F1's launch claim,
   * the banner-vs-Billing renew gate, now this), so the answer is one predicate
   * that every pay control on this screen reads.
   */
  const payControlAllowed = shouldOfferRenewNow({ renewRefusal: market.renewRefusal, renewUnconfirmed });
  const lapseHeadline = market.windingDown
    ? 'This token is winding down. It will not take buyers again, and renewing cannot reopen it.'
    : // ★★ AND IT MUST NOT SAY "RENEW" WHEN THE CHAIN WOULD REFUSE THE PAYMENT
      // (2026-08-31). The CTA beside it was already gated on `renewRefusal`, but
      // the SENTENCE was not — so a creator whose market the contract will not
      // reactivate read "Renew to stay in discovery" next to no button, which is
      // an instruction that cannot be followed and no explanation of why.
      // `lapseNoticeFor` carries one distinct, true sentence per refusal reason,
      // including the road out where renewal is not it. The `??` is unreachable:
      // this banner only renders on `grace`, `delisted` or `windingDown`, and
      // the first two always produce a sentence.
      !canRenewNow
      ? (lapseNoticeFor(lapse, market.renewRefusal) ?? 'Your market is not taking buyers.')
      : market.phase === 'FROZEN'
      ? 'Your market has stopped taking buyers. Renew to start taking them again. Answering and cashing out still work.'
      : 'Your listing has lapsed. Renew to stay in discovery. Answering and cashing out still work.';
  const banner =
    overdue || market.windingDown ? (
      <div className="mb-5 flex items-center justify-between gap-3 rounded-card border border-line-warn-2 bg-surface-warn-4 px-5 py-3.5">
        <span className="text-[14px] leading-[22px] font-medium text-ink-warn-3 font-ui">{lapseHeadline}</span>
        {payControlAllowed ? (
          <button
            onClick={() => void runStudioAction(() => studio.renew(1), 'Renewing your listing didn’t go through.')}
            disabled={studio.isBusy}
            className="rounded-control bg-surface-warn-11 px-4 py-2 text-caption font-medium text-ink-27 font-ui disabled:opacity-50"
          >
            Renew ~$10
          </button>
        ) : null}
      </div>
    ) : null;

  return (
    <TokenShell back={{ href: '/creators', label: '← All creators' }}>
      <div className="pt-[26px]">
        <div className="mb-1 flex items-center gap-3">
          <UserAvatarImg username={studio.creator ?? ''} apiSize="medium" pixelSize={44} radiusClassName="rounded-card" />
          <div>
            <h1 className="font-ui text-2xl font-medium text-ink-2">Creator Studio</h1>
            <p className="text-[14px] leading-[22px] text-ink-10 font-ui">Your token @{displayHandle(studio.creator)} · your control room</p>
          </div>
        </div>

        {/* Section tabs */}
        {/* ★ WARM TAB TREATMENT (illumination §1/§3) — the FOURTH copy of this
            segmented control, after the feed, creators and proposals. Track on
            --amb-1 (§3: troughs follow the ground they sit on, never lighter),
            active pill on --lum-1 with a soft warm glow, one step weaker than the
            nav rail (§4). The glow is an inline style because a `/` in a Tailwind
            arbitrary value is the opacity shorthand and silently kills the class. */}
        <div className="mb-5 mt-4 flex flex-wrap gap-1.5 rounded-card border border-line-6 bg-[var(--amb-1)] p-[5px]">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              style={section === s.id ? { boxShadow: 'var(--lift-1), 0 0 12px -5px rgb(var(--lum) / 0.85)' } : undefined}
              className={`rounded-control px-4 py-2 font-ui text-[14px] leading-[22px] font-medium transition-colors ${
                section === s.id ? 'bg-[var(--lum-1)] text-ink-2' : 'text-ink-10 hover:text-ink-2'
              }`}
            >
              {s.label}
              {s.id === 'inbox' && inbox.length > 0 ? (
                <span className="ml-1.5 rounded-full bg-surface-brand-12 px-1.5 text-caption tabular-nums text-ink-27 font-num">
                  {inbox.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {banner}
        {actionFailure ? (
          <div className="mb-5 rounded-card border border-line-brand-3 bg-surface-brand-7 px-5 py-3.5 text-[14px] leading-[22px] font-medium text-ink-brand-6 font-ui">
            {actionFailure}
          </div>
        ) : null}
        {/* ★ WHY THIS EXISTS (2026-09-01): every studio write now WAITS for the
            chain to confirm (vsc-data-source.ts awaitExecution, ~20-72s typical,
            up to 180s), where it used to return in ~2s. `isBusy` (run.isLoading)
            disables every action button for that whole window, so without this a
            button just greys with its normal label for up to three minutes and
            reads as broken — and the user's next move is a reload, which drops
            the in-flight poll (57, 2026-09-01). One studio-wide indicator, not a
            per-button "Confirming…" label: `isBusy` is a single global flag, so a
            per-button label would make "Retire" say "Confirming…" during a renew,
            which is worse. Failure takes precedence over it. */}
        {studio.isBusy && !actionFailure ? (
          // ★ STICKY (57, 2026-09-01): the studio's action buttons run hundreds
          // of lines below this point (the offerings cards), so a static banner
          // here is off-screen for exactly the lower-half clicks it needs to
          // explain. `sticky top-0` follows the viewport so the reason travels
          // with whatever button the creator just greyed out, with no per-section
          // copies and no per-action tracking.
          <div
            className="sticky top-0 z-10 mb-5 rounded-card border border-line-11 bg-surface-1 px-5 py-3.5 text-[14px] leading-[22px] font-medium text-ink-7 font-ui"
            role="status"
            aria-live="polite"
          >
            Confirming on the chain. This can take a minute or two, so keep this tab open while it goes through.
          </div>
        ) : null}

        {section === 'overview' ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card>
              <Stat
                label="Token price"
                value={usdPrice(market.priceUsd)}
                /* ★★ THE CAP IS GONE FROM THIS SCREEN (owner, 2026-08-30: "theres
                   cap in creator studio. get rid of it"). This line read "Cap <1%
                   used" for every market launched from today, because
                   `STANDARD_CAP` is now the contract's MaxCap (launch-money.ts
                   carries the ruling) and 1e9 tokens is a number no market
                   reaches. A percentage of a ceiling nobody can touch is not
                   information, so the cap half is DELETED, not flagged: the
                   2026-08-27 note that kept it ("the half a creator acts on") is
                   superseded, there is nothing left to act on. The floor half
                   keeps its own flag, exactly like the Price sub-line on the
                   Market tab, and returns unchanged when SHOW_BACKING_FIGURES
                   flips. */
                sub={SHOW_BACKING_FIGURES ? `Floor ${usdPrice(market.floorUsd)}` : undefined}
              />
            </Card>
            <Card>
              <Stat
                label="Market cap"
                value={usdWhole(market.marketCapUsd)}
                /* Same ruling: "0 of 1,000,000,000 tokens" is the cap again, in
                   a different coat. The issued count is real and stays. */
                sub={`${market.supply.toLocaleString('en-US')} tokens issued`}
              />
            </Card>
            <Card>
              <Stat
                label="Delivery"
                /* The creator's own dashboard read "0%" and "0/0 answered · " on
                   the day they launched. Nothing has been asked of them yet; say
                   that, rather than scoring them zero for it. */
                /* ★★★ AND AN UNREACHABLE INDEXER IS NOT AN EMPTY HISTORY
                   (2026-08-30, clauderfly-43). This branched on `completionPct`
                   alone, and `adaptDelivery` (live/adapt.ts) returns
                   `{completionPct: null, available: false}` for BOTH "nothing has
                   been asked yet" and "the read failed" — so a failed read rendered
                   as the flat statement "No deliveries yet". That is the same
                   defect the "Requests waiting" card two cards down was fixed for
                   on 2026-08-28, and the same one the buyer-facing surfaces already
                   get right (token-market-view.tsx and profile-token-card.tsx both
                   test `d.available` FIRST).
                   It is live, not hypothetical: production ships
                   REACT_APP_CREATOR_TOKENS_INDEXER_URL as an empty string, so
                   `readDeliveryRecord` returns source:'unavailable' unconditionally
                   there and EVERY creator was told they had no deliveries. */
                value={!market.delivery.available || market.delivery.completionPct === null ? '—' : (pctLabel(market.delivery.answered, market.delivery.total) ?? '0%')}
                sub={
                  !market.delivery.available
                    ? 'Could not be read just now'
                    : market.delivery.completionPct === null
                      ? 'No deliveries yet'
                      : `${market.delivery.answered}/${market.delivery.total} answered${market.delivery.typicalResponse ? ` · ${market.delivery.typicalResponse}` : ''}`
                }
              />
            </Card>
            <Card>
              <Stat
                label="Subscription"
                /* ★ A WOUND-DOWN MARKET IS NOT "LAPSED", AND RENEWING CANNOT SAVE
                   IT (2026-08-31). This read "Lapsed / Renew to stay listed" on a
                   CLOSED market, where the chain refuses a renewal outright — so
                   the stat named the wrong state and prescribed a remedy that does
                   not exist. Same fault as the banner CTA above, in a stat. */
                value={
                  market.windingDown
                    ? 'Ended'
                    : overdue
                      ? 'Lapsed'
                      : /* A failed read reported "0 days left", which is a
                           deadline, not a missing value. */
                        subUnknown
                        ? '—'
                        : `${subDaysLeft} days left`
                }
                sub={
                  market.windingDown
                    ? 'This token is winding down'
                    : overdue
                      ? /* Same rule as the banner: never prescribe a payment the
                           contract would refuse. */
                        canRenewNow
                        ? 'Renew to stay listed'
                        : 'Renewing is not available'
                      : subUnknown
                        ? 'We couldn’t read your subscription just now'
                        : `Renew ~$10`
                }
              />
            </Card>
            <Card>
              {/* ★ A FAILED READ IS NOT A ZERO BALANCE (2026-08-10). This read
                  `usdWhole(tradeFeeClaimableUsd)` on a value that collapsed a
                  rejected chain read into 0, so a node blip told a creator they
                  had earned nothing. Same treatment as `commissionEarnedUsd`
                  below: say we do not know. */}
              <Stat
                label="Trade-fee share (claimable)"
                value={tradeFeeClaimableUsd === null ? '—' : usdWholeNonZero(tradeFeeClaimableUsd)}
                green
                sub={
                  tradeFeeClaimableUsd === null
                    ? 'Could not be read just now'
                    : 'Your 5% of the token’s trades'
                }
              />
            </Card>
            <Card>
              {/* ★ Same rule as the trade-fee Stat above: a read that has not
                  succeeded is UNKNOWN, not zero (2026-08-28, F2). "0 requests
                  waiting" is a claim, and it was being made off a failed read. */}
              <Stat
                label="Requests waiting"
                value={inboxUnavailable ? '—' : String(inbox.length)}
                sub={inboxUnavailable ? 'Could not be read just now' : 'In your Inbox'}
              />
            </Card>
          </div>
        ) : null}

        {section === 'inbox' ? (
          <div className="flex flex-col gap-4">
            {/* ★ DMs sit ALONGSIDE the paid-ask escrow cards, never merged: asks
                carry money and deadlines, direct messages do not. This sub-toggle
                switches the Inbox between the two without conflating them. */}
            <div className="flex gap-1.5 self-start rounded-card border border-line-6 bg-[var(--amb-1)] p-[5px]">
              {([['requests', 'Requests'], ['messages', 'Messages']] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setInboxTab(id)}
                  style={inboxTab === id ? { boxShadow: 'var(--lift-1), 0 0 12px -5px rgb(var(--lum) / 0.85)' } : undefined}
                  className={`rounded-control px-4 py-1.5 font-ui text-[14px] leading-[22px] font-medium transition-colors ${
                    inboxTab === id ? 'bg-[var(--lum-1)] text-ink-2' : 'text-ink-10 hover:text-ink-2'
                  }`}
                >
                  {label}
                  {id === 'messages' && dmUnreadCount > 0 ? (
                    <span className="ml-1.5 rounded-full bg-surface-brand-12 px-1.5 text-caption tabular-nums text-ink-27 font-num">
                      {dmUnreadCount}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            {inboxTab === 'messages' ? (
              <DmInboxPanel />
            ) : (
            <div className="flex flex-col gap-2.5">
            {inboxTruncated ? (
              <Card>
                <p className="py-3 text-center text-caption text-ink-warn-3 font-ui">
                  You have a very large number of requests. Showing the most recent; {inboxOlderNotScanned} older
                  {inboxOlderNotScanned === 1 ? ' request is' : ' requests are'} not listed here. Answer or decline the ones below first.
                </p>
              </Card>
            ) : null}
            {/* ★ "you’re all caught up" was shown to creators whose escrows
                exist and simply could not be read (2026-08-28, F2). Retry, do
                not reassure — the same shape the Offerings tab already uses. */}
            {inboxUnavailable ? (
              <Card>
                <div className="py-6 text-center text-caption text-ink-brand-2 font-ui">
                  <p>Your requests couldn’t be loaded just now. This is not an empty inbox.</p>
                  <button
                    type="button"
                    onClick={() => studio.retry()}
                    className="mt-2 rounded-control border border-line-12 bg-surface-1 px-3 py-1.5 text-caption font-medium text-ink-2 font-ui hover:border-line-28"
                  >
                    Try again
                  </button>
                </div>
              </Card>
            ) : inbox.length === 0 && expiredInbox.length === 0 ? (
              <Card>
                <p className="py-6 text-center font-serif text-sm italic text-ink-14">
                  No requests waiting. Nice, you’re all caught up.
                </p>
              </Card>
            ) : inbox.length === 0 ? (
              /* Nothing ACTIONABLE, but missed jobs below. "All caught up" would
                 be the wrong sentence to put above a job they let expire. */
              <Card>
                <p className="py-6 text-center font-serif text-sm italic text-ink-14">
                  Nothing waiting on you right now.
                </p>
              </Card>
            ) : (
              // Rendered from the PORTFOLIO row (money + due label, already
              // adapted) but opened with the RAW escrow, because answer/decline
              // need seq and deadlineBlock — neither of which a portfolio row
              // carries. Zipped by index: both lists come from the same filtered
              // array in the same order, so they cannot drift.
              inbox.map((a, i) => (
                <Card key={a.id} className={a.urgent ? 'border-line-warn-2 bg-surface-warn-4' : ''}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[15px] leading-[24px] font-medium text-ink-2 font-ui">{a.service}</div>
                    <div
                      className={`text-caption font-medium font-ui ${a.urgent ? 'text-ink-warn-3' : 'text-ink-10'}`}
                    >
                      {a.dueLabel}
                    </div>
                  </div>
                  <div className="mt-1 text-caption tabular-nums text-ink-10 font-num">
                    {usdWhole(a.costUsd)} · {tok(a.tokens)} tokens escrowed
                  </div>
                  <div className="mt-3">
                    <button
                      onClick={() => setAnswering(rawInbox[i])}
                      className="rounded-control bg-surface-brand-12 px-4 py-2 text-caption font-medium text-ink-27 font-ui hover:bg-surface-brand-17"
                    >
                      Answer or decline
                    </button>
                  </div>
                </Card>
              ))
            )}

            {/* ★★★ MISSED JOBS, SHOWN WITHOUT A CONTROL (2026-08-30, clauderfly-43).
                These used to sit in the list above with a live "Answer or decline"
                button and be counted by the Overview's "Requests waiting". The chain
                refuses both resolutions once the deadline is past — core/ask.go:615
                (Answer) and core/ask.go:830 (Decline), both "answer window closed" —
                so the button could only ever cost the creator a signature and their
                resource credits to be told no.
                They are still SHOWN, because this is the job the contract is about to
                count as a miss against the delivery record, and a creator who cannot
                see it cannot learn from it. */}
            {!inboxUnavailable && expiredInbox.length > 0 ? (
              <div className="mt-1.5 flex flex-col gap-2.5">
                <div className="text-label font-medium uppercase tracking-wide text-ink-14 font-ui">
                  Past their deadline
                </div>
                {expiredInbox.map((a) => (
                  <Card key={a.id} className="border-dashed">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[15px] leading-[24px] font-medium text-ink-10 font-ui">{a.service}</div>
                      <div className="text-caption font-medium text-ink-14 font-ui">Deadline passed</div>
                    </div>
                    <div className="mt-1 text-caption tabular-nums text-ink-14 font-num">
                      {usdWhole(a.costUsd)} · {tok(a.tokens)} tokens escrowed
                    </div>
                    <p className="mt-2 text-caption text-ink-14 font-ui">
                      The answer window has closed, so this can no longer be answered or declined. The buyer
                      reclaims their tokens, and the chain records a miss against your delivery record.
                    </p>
                  </Card>
                ))}
              </div>
            ) : null}
          </div>
            )}
          </div>
        ) : null}

        {section === 'offerings' ? (
          <Card>
            <div className="mb-3 font-ui text-lg font-medium text-ink-2">
              Your services &amp; prices
            </div>
            {/* ★★★ SAY IT BEFORE THEY PRICE IT (2026-08-30, clauderfly-43).
                A service is priced from the token's own trading history, and that
                derivation REFUSES rather than guessing when the history will not
                carry it (core/settlement.go SettlementRate, both TWAP arms).
                Measured against the live contract on 2026-08-30: 13 of 13
                registered markets could not price a service, and this tab invited
                every one of those creators to name and price three of them without
                a word about it.
                The sentence comes from the ACTUAL refusal the quote returned, not
                one line for all of them — `stale` is a history that is too old and
                is the opposite complaint to one that is too thin. `null` status
                means the quote has not answered, and renders nothing rather than
                claiming the shop works. */}
            {servicesOracleStatus && servicesOracleStatus !== 'ok' ? (
              <div className="mb-4 rounded-card border border-line-warn-2 bg-surface-warn-4 px-4 py-3 text-caption font-medium text-ink-warn-3 font-ui">
                {creatorOracleNotice(servicesOracleStatus)}
              </div>
            ) : null}
            <p className="mb-4 text-caption text-ink-10 font-ui">
              Buyers pay these in your token at the live price. Set the dollar price: the token amount
              follows the market. A price can move at most 2× in any 7 days, and that limit follows the
              SERVICE NAME, so renaming or re-creating one won’t reset it.
            </p>
            {/* ★ THE BASE PRICE, EDITABLE (2026-08-07).
                `face` is the price of the default "Ask a question" service, and
                with no named offerings it is the ONLY price a buyer ever sees —
                yet the studio exposed every named price and never this one, so a
                creator was permanently stuck with whatever they launched at. The
                contract, the client and the tests all supported changing it; only
                the screen did not. Same control and same 2x/7d band as the rows
                below, so there is one way to price something, not two. */}
            <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-line-11 bg-surface-5 px-4 py-3">
              <div className="min-w-0">
                <div className="text-[14px] leading-[22px] font-medium text-ink-2 font-ui">Default ask price</div>
                <div className="text-caption text-ink-14 font-ui">
                  {studio.offerings === null
                    ? 'Shown on your token page as “Ask a question”.'
                    : studio.offerings.length === 0
                      ? 'Shown on your token page as “Ask a question”. This is the only price buyers see until you add a named service.'
                      : 'Used for “Ask a question”, alongside the named services below.'}
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center rounded-control border border-line-11 px-3 py-2 focus-within:border-line-brand-10 focus-within:ring-1 focus-within:ring-line-brand-10">
                <span className="text-ink-14 font-num">$</span>
                <PriceInput
                  value={market.basePriceUsd}
                  // Returns the promise (not a void wrapper) so PriceInput can
                  // revert the field when the chain refuses — same contract the
                  // named-offering rows below use.
                  onCommit={(usd) => studio.setFace(usd)}
                  // ★ THE GUARD WAS ON THE SECOND PRICE BUYERS SEE AND NOT THE
                  // FIRST (found 2026-08-27 by an adversarial pass over the same
                  // day's work). `serviceSupplyShareProblem` was wired to the
                  // named-offering rows below but not here — yet `faceAsService`
                  // (live/adapt.ts:252) turns THIS price into a real, buyable
                  // "Ask a question" service, and adapt.ts:291 falls back to it
                  // whenever the creator has no named offering. The copy three
                  // lines above says so itself: "the only price buyers see until
                  // you add a named service." So on a fresh market the one price
                  // that existed was the one price nothing checked, which is the
                  // exact 30-cap case the guard was written for.
                  problemOf={(usd) => serviceSupplyShareProblem(usd, market.priceUsd, market.cap)}
                  disabled={studio.isBusy}
                  onFailure={(m) => setActionFailure(m || null)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-3">
              {/* ★ "You haven't posted any services yet" was shown to creators
                  whose services exist and simply could not be read — the list
                  collapsed a rejected read into an empty array. Retry, do not
                  reassure. */}
              {studio.offerings === null ? (
                <div className="rounded-xl border border-dashed border-line-brand-2 px-4 py-5 text-center text-caption text-ink-brand-2 font-ui">
                  <p>Your services couldn’t be loaded just now. This is not an empty shop.</p>
                  <button
                    type="button"
                    onClick={() => studio.retry()}
                    className="mt-2 rounded-control border border-line-12 bg-surface-1 px-3 py-1.5 text-caption font-medium text-ink-2 font-ui hover:border-line-28"
                  >
                    Try again
                  </button>
                </div>
              ) : studio.offerings.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line-11 px-4 py-5 text-center text-caption italic text-ink-14">
                  You haven’t posted any services yet. Add one below and it appears on your token page.
                </p>
              ) : (
                studio.offerings.map((o) => (
                  <div
                    key={o.offeringId}
                    className="flex items-center justify-between gap-3 rounded-xl border border-line-11 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <TitleInput
                        value={o.title}
                        disabled={studio.isBusy}
                        onCommit={(title) => studio.setOfferingTitle({ offeringId: o.offeringId, title })}
                        onFailure={(m) => setActionFailure(m || null)}
                      />
                      {/* ★ A THIRD, WRONG WAY TO QUOTE THE SAME OFFERING (found
                          2026-08-21). This was a raw `price / tokenPrice`: no 12%
                          commission carve-out and no rounding up, while both the
                          buyer-facing paths use `serviceQuote`, which applies
                          both. On a real market (supply 31, token $1.255) a $60
                          service read 47.81 tokens HERE and 43 on the page a
                          buyer actually sees, an 11% gap on the creator's own
                          pricing screen. `serviceQuote` matches what a live ask
                          settles at, verified against `creditsForAskBaseUnits`
                          at the contract's settlement rate for four offerings.
                          One quote function, or the two screens disagree. */}
                      <div className="text-caption tabular-nums text-ink-14 font-ui">
                        {market.priceUsd > 0
                          ? `≈ ${tok(serviceQuote(o.priceHbd, market.priceUsd).tokens)} tokens at today’s price`
                          : 'Token price unavailable'}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <div className="flex items-center rounded-control border border-line-11 px-3 py-2 focus-within:border-line-brand-10 focus-within:ring-1 focus-within:ring-line-brand-10">
                        <span className="text-ink-14 font-num">$</span>
                        <PriceInput
                          value={o.priceHbd}
                          onCommit={(usd) =>
                            studio.setOfferingPrice({ offeringId: o.offeringId, priceUsd: usd })
                          }
                          problemOf={(usd) => serviceSupplyShareProblem(usd, market.priceUsd, market.cap)}
                          disabled={studio.isBusy}
                          onFailure={(m) => setActionFailure(m || null)}
                        />
                      </div>
                      <button
                        onClick={() =>
                          void runStudioAction(
                            () => studio.deleteOffering(o.offeringId),
                            'Removing that service didn’t go through.'
                          )
                        }
                        disabled={studio.isBusy}
                        title="Delist this service. Asks already made against it are unaffected."
                        className="rounded-control border border-line-11 px-3 py-2 text-caption font-medium text-ink-10 font-ui hover:bg-surface-16 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
            <NewOfferingRow studio={studio} />
          </Card>
        ) : null}

        {section === 'market' ? (
          <Card>
            <div className="flex items-end justify-between">
              <Stat
                label="Price"
                value={usdPrice(market.priceUsd)}
                /* ★ Hidden for launch: the whole sub-line was the floor, so there
                   is nothing left to say under the price and `sub` goes away
                   rather than rendering an empty row. */
                sub={SHOW_BACKING_FIGURES ? `Floor ${usdPrice(market.floorUsd)}` : undefined}
              />
              <Stat label="Market cap" value={usdWhole(market.marketCapUsd)} />
              {/* ★ Hidden for launch, stat and caption together: "Backs the
                  floor" is a caption about a figure that is no longer anywhere
                  on this screen, so hiding the number and keeping the sentence
                  would leave it pointing at nothing. */}
              {SHOW_BACKING_FIGURES ? (
                <Stat label="Reserve" value={usdWhole(market.reserveUsd)} sub="Backs the floor" />
              ) : null}
            </div>
            {/*
              ★★ THE SUPPLY BAR IS DELETED (owner, 2026-08-30: "theres cap in
              creator studio. get rid of it"). It drew "0 / 1,000,000,000" at a
              permanent 0% for every market launched since `STANDARD_CAP` became
              the contract's MaxCap, and a bar whose right end is a number no
              market reaches says nothing true about the market. Deleted, not
              hidden behind a flag, on the owner's words. The issued count
              survives in the Overview's "Market cap" sub-line.
              The raise-cap control below is untouched: it hides itself on the
              live cap, so the older 30 / 500 / 5,000 / 100,000 markets keep it.
            */}
            {/*
              ★ NOTHING LEFT TO RAISE (owner, 2026-08-30: "turn it off").
              `STANDARD_CAP` is now the contract's MaxCap (1e9 — launch-money.ts
              carries the ruling and the evidence), so every market registered
              from today lands already at the ceiling. `setCap` on a market at
              MaxCap cannot succeed: core/market.go:1056-1075 rejects anything
              above MaxCap, and the guard below rejects `v === market.cap` — so
              the control would be a button that errors on 100% of inputs, which
              is the exact "dead control" fault this screen was already burned by
              (2026-08-09, the 100%-silent setCap).
              HIDDEN, NOT DISABLED, and hidden on the LIVE cap rather than on a
              flag: the older markets (30 / 500 / 5,000 / 100,000) still have real
              headroom and still get the full control, and if an owner ever
              re-tightens the launch cap it returns on its own.
            */}
            {market.cap < MAX_CAP_CREDITS_BASE_UNITS ? (
              <div className="mt-5 flex items-center gap-2">
                <span className="text-caption text-ink-10 font-ui">Raise cap to</span>
                <input
                  value={capInput}
                  onChange={(e) => setCapInput(e.target.value)}
                  inputMode="numeric"
                  className="w-[110px] rounded-control border border-line-11 px-3 py-2 text-[14px] leading-[22px] tabular-nums font-num outline-none focus-visible:outline-none focus:border-line-brand-10 focus:ring-1 focus:ring-line-brand-10"
                />
                <button
                  onClick={async () => {
                    // ★ THIS FAILED 100% SILENTLY (2026-08-09). Every refusal —
                    // and every SUCCESS-that-wasn't — reverted the field with no
                    // toast, no inline text, no console error. A tester probed 8
                    // values including a perfectly valid one and could not tell
                    // any of them apart from a dead button. The `catch {}` below
                    // was swallowing the chain's actual reason.
                    //
                    // The reverting field stays (it must never show a cap the
                    // contract did not accept) — what changes is that the reader
                    // is now told WHY, using the same `actionFailure` banner the
                    // rest of this screen already uses.
                    setActionFailure(null);
                    const digits = capInput.replace(/[^\d]/g, '');
                    const v = parseInt(digits, 10);
                    const issued = Math.ceil(market.supply);
                    if (!digits || !Number.isFinite(v)) {
                      setCapInput(String(market.cap));
                      setActionFailure('Enter a whole number of tokens for the new cap.');
                      return;
                    }
                    if (v < issued) {
                      setCapInput(String(market.cap));
                      setActionFailure(
                        `The cap cannot go below the ${issued.toLocaleString('en-US')} tokens already issued.`
                      );
                      return;
                    }
                    if (v === market.cap) {
                      setActionFailure(`The cap is already ${market.cap.toLocaleString('en-US')}.`);
                      return;
                    }
                    try {
                      await studio.setCap(v);
                    } catch (error) {
                      setCapInput(String(market.cap));
                      // Routed through writeFailureMessage (F7 note): the correctness
                      // fix now lives centrally in use-live-studio.ts's `call()`, which
                      // can throw a machine-coded CREATOR_TOKENS_BUSY on a same-tick
                      // double-submit — this strips that prefix instead of painting it
                      // raw into the banner.
                      setActionFailure(`The cap was not changed. ${writeFailureMessage(error, 'The chain refused the change.')}`);
                    }
                  }}
                  // F7 fix: this button had NO disabled attribute at all — the
                  // correctness guard against a double-submit now lives centrally in
                  // use-live-studio.ts's `call()` (every studio write funnels through
                  // it), but this still visually disables the button while busy so a
                  // reader is not left double-clicking into a caught CREATOR_TOKENS_BUSY.
                  disabled={studio.isBusy}
                  className="rounded-control bg-surface-43 px-4 py-2 text-caption font-medium text-ink-27 font-ui disabled:opacity-50"
                >
                  Raise cap
                </button>
                <span className="text-caption tabular-nums text-ink-14 font-num">
                  lower only down to {market.supply.toLocaleString('en-US')} issued
                </span>
              </div>
            ) : null}
            <p className="mt-4 rounded-control bg-surface-16 px-3.5 py-3 text-caption text-ink-10 font-ui">
              Your token’s price is set by the market: buys raise it, sells lower it. You don’t set the
              price; you set your <strong>service prices</strong> in dollars.
            </p>
            {/*
              ★ SAME CONTROL AS THE LAUNCH CARD, REUSED NOT COPIED (owner,
              2026-08-30): "THEY NEED TO ADD THE LINK HERE... NOT SETTINGS."
              covers editing it after launch too, not only the moment of
              launch — this is the same `WorkLinkField` from
              `meritum/launch/launch-step-offers.tsx`, writing to the same
              profile store, so a change here and a change there can never
              drift out of sync with each other or with Settings.
            */}
            <div className="mt-5 border-t border-line-9 pt-5">
              <span className="text-caption text-ink-10 font-ui">{t('meritum_launch.work_link')}</span>
              <div className="mt-2">
                <WorkLinkField
                  account={studio.creator ?? ''}
                  inputClassName="min-w-[min(100%,220px)] flex-1 rounded-control border border-line-11 bg-surface-1 px-3 py-2 text-[14px] leading-[22px] text-ink-2 font-ui outline-none focus-visible:outline-none focus:border-line-brand-10 focus:ring-1 focus:ring-line-brand-10 disabled:opacity-60"
                  buttonClassName="rounded-control bg-surface-43 px-4 py-2 text-caption font-medium text-ink-27 font-ui disabled:opacity-50"
                  errorClassName="mt-1.5 text-caption font-medium text-ink-brand-6 font-ui"
                  statusClassName="mt-1.5 text-caption text-ink-10 font-ui"
                />
              </div>
            </div>
          </Card>
        ) : null}

        {section === 'billing' ? (
          <Card>
            <div className="mb-1 font-ui text-lg font-medium text-ink-2">Subscription</div>
            <div className="mb-4 text-[14px] leading-[22px] text-ink-8 font-ui">
              {market.windingDown
                ? 'This token is winding down, so the subscription no longer applies.'
                : overdue
                  ? canRenewNow
                    ? 'Lapsed. Renew to stay listed.'
                    : 'Lapsed, and it cannot be reactivated by paying right now.'
                  : subUnknown
                    ? 'We couldn’t read your subscription just now.'
                    : `Paid up · ${subDaysLeft} days left.`}{' '}
              Staying
              listed is ~$10/month. First month’s on the house.
            </div>
            {/* ★ THE SECOND DEAD RENEW (2026-08-31). The banner CTA above was
                gated on `renewRefusal`; this one was not, so a CLOSED market
                still offered "Renew ~$10" in Billing — the chain refuses it
                ('closed'), so it could only ever fail. Gated on the same
                condition, so there is one answer to "may this creator pay
                right now" and both controls read it. */}
            {payControlAllowed ? (
            <button
              onClick={() =>
                void (async () => {
                  setRenewUnconfirmed(false);
                  await runStudioAction(() => studio.renew(1), 'Renewing your listing didn’t go through.');
                })()
              }
              disabled={studio.isBusy}
              className="rounded-control bg-surface-brand-12 px-5 py-2.5 text-[14px] leading-[22px] font-medium text-ink-27 font-ui hover:bg-surface-brand-17 disabled:opacity-50"
            >
              Renew ~$10
            </button>
            ) : null}
            {/* ★ S4 (2026-08-30): when Hive accepted the payment but Magi has not
                recorded it inside the window (vsc-data-source renewSubscription
                throws CREATOR_TOKENS_RENEW_UNCONFIRMED), the way out is a
                READ-ONLY re-read of the market, never a second broadcast:
                Renew stacks from max(paidUntil, block), so "Try again" here
                would buy a second month. `studio.retry` only refetches. */}
            {renewUnconfirmed ? (
              <button
                onClick={() => {
                  setActionFailure(null);
                  setRenewUnconfirmed(false);
                  studio.retry();
                }}
                className="ml-2 rounded-control border border-line-11 px-4 py-2.5 text-[14px] leading-[22px] font-medium text-ink-7 font-ui hover:bg-surface-16"
                data-testid="renew-check-again"
              >
                Check again
              </button>
            ) : null}
            {/* ★★★ H-D: THIS TOLD EVERY CREATOR THAT LAPSING REFUNDS THEIR HOLDERS,
                UNCONDITIONALLY, ON THE SCREEN WHERE THEY DECIDE WHETHER TO PAY
                (2026-08-31, found in the browser on the demo build).
                Every clause was the v1 wind-down story: holders refunded, delivery
                record reset, "coming back means a new token". Under v2 all four are
                false — a lapse is an inflow stop, holders keep their tokens and can
                still sell, the record survives, and a renewal reopens the SAME
                token. 57's own on-chain lifecycle proved exactly that (Buy refused,
                Sell accepted, Refund refused, Renew accepted on a natural FROZEN).
                It also contradicted the Studio's own banner two tabs away and the
                wind-down line immediately below it, which says "nobody is refunded
                automatically" — two adjacent sentences, opposite claims.
                It is the one lapse-sensitive string that never got the `rules`
                treatment, so it flipped from true to false the moment A1 shipped.
                Now gated on the chain's own answer like the rest.
                ★ THE v1 BRANCH IS ALSO CORRECTED, not merely preserved: holders
                were never refunded AUTOMATICALLY even under v1 — Refund and
                RefundHolder are pull rails somebody has to call. "can redeem"
                is what was always true. */}
            <p className="mt-4 text-caption text-ink-14 font-ui">
              {market.rules === 'v2'
                ? 'If you stop paying, your market stops taking new buyers. Holders keep their tokens and can still sell, your delivery record is unaffected, and renewing reopens buying on the same token. Answering and cashing out are never blocked by billing.'
                : 'If you stop paying, your token’s market winds down: holders can redeem their share of the reserve, less any early-exit fee, your delivery record resets, and coming back means a new token. Answering and cashing out are never blocked by billing.'}
            </p>
            <div className="mt-5 border-t border-line-2 pt-4">
              {market.windingDown ? (
                <div className="text-caption font-medium text-ink-warn-3 font-ui">
                  This token is winding down. Holders can redeem a slice of the reserve, less any early-exit fee;
                  nobody is refunded automatically. Answering and cashing
                  out still work.
                </div>
              ) : (
                <button
                  onClick={() => setRetireOpen(true)}
                  className="rounded-control border border-line-brand-1 px-4 py-2 text-caption font-medium text-ink-brand-6 font-ui hover:bg-surface-brand-3"
                >
                  End this token
                </button>
              )}
            </div>
          </Card>
        ) : null}

        {section === 'earnings' ? (
          <div className="flex flex-col gap-4">
            <Card>
              <div className="flex items-center justify-between">
                <Stat
                  label="Trade-fee share"
                  value={tradeFeeClaimableUsd === null ? '—' : usdWholeNonZero(tradeFeeClaimableUsd)}
                  green
                  sub={
                    tradeFeeClaimableUsd === null
                      ? 'Could not be read just now. This is not a zero balance'
                      : 'Your 5% of your token’s trades'
                  }
                />
                {/* ★ The button used to read "Claimed" and sit disabled whenever
                    the balance came back 0 — including when it came back 0 only
                    because the read had FAILED. A creator with real unclaimed
                    fees was shown a disabled control telling them there was
                    nothing to claim. Unknown is now its own state, and it offers
                    the retry rather than a verdict. */}
                {tradeFeeClaimableUsd === null ? (
                  <button
                    onClick={() => studio.retry()}
                    className="rounded-control border border-line-12 bg-surface-1 px-5 py-2.5 text-[14px] leading-[22px] font-medium text-ink-2 font-ui hover:border-line-28"
                  >
                    Try again
                  </button>
                ) : (
                  <button
                    onClick={() =>
                      void runStudioAction(
                        () => studio.claimTradeFees(),
                        'Claiming your trade fees didn’t go through.'
                      )
                    }
                    disabled={tradeFeeClaimableUsd <= 0 || studio.isBusy}
                    className="rounded-control bg-surface-ok-7 px-5 py-2.5 text-[14px] leading-[22px] font-medium text-ink-27 font-ui hover:bg-surface-ok-8 disabled:opacity-50"
                  >
                    {/* ★ "Claimed" ON A ZERO BALANCE READ AS "you already took it"
                        (2026-08-31, browser). Nothing had been claimed — there was
                        nothing TO claim, which is a different fact and the one a
                        creator needs. The unknown case is handled above and never
                        reaches this label. */}
                    {tradeFeeClaimableUsd <= 0 ? 'Nothing to claim' : 'Claim'}
                  </button>
                )}
              </div>
            </Card>
            {/* Lifetime commission is a REPLAY of past answered events, not
                current state — only the indexer can produce it, and it has no
                HTTP server yet. A creator would reconcile real income against
                this number, so it says "not available" rather than 0. */}
            <Card>
              <Stat
                label="Service commission"
                value={commissionEarnedUsd === null ? '—' : usdWhole(commissionEarnedUsd)}
                sub={
                  commissionEarnedUsd === null
                    ? 'Not available yet. Needs the earnings index'
                    : 'From answered requests'
                }
              />
            </Card>
            <Card>
              <Stat
                label="Your own holdings"
                /* ★★★ A FAILED POSITION READ IS NOT A ZERO BALANCE (2026-08-30,
                   clauderfly-43), the same rule the two cards above already follow.
                   Until today this could not even be reached: use-live-studio passed
                   `position: null` unconditionally, so `held` was 0 for every
                   creator, on every market, forever. */
                value={positionUnavailable ? '—' : `${tok(held)} tokens`}
                /* ★ Hidden for launch. The mark-to-price half stays: it is this
                   creator's own holding at the live curve price, and it is the
                   figure the Cash out control below is denominated against. */
                sub={
                  positionUnavailable
                    ? 'Could not be read just now'
                    : SHOW_BACKING_FIGURES
                      ? `worth ${usdPrice(held * market.priceUsd)} · floor ${usdPrice(held * market.floorUsd)}`
                      : `worth ${usdPrice(held * market.priceUsd)}`
                }
              />
              {/* ★★★ THE CURVE SELL IS CLOSED DURING A WIND-DOWN, AND THIS CONTROL
                  WAS STILL WIRED TO IT (2026-08-31, D4, confirmed on `mock-closed`).
                  `studio.sell()` calls sell.go's curve rail, which refuses for the
                  whole wind-down and tells the caller to use the refund rail
                  instead — while the banner above promised "cashing out still
                  work". The token page has routed this correctly for weeks
                  (`windingDown ? 'redeem' : 'sell'`); the Studio never did.
                  It is masked on the fixtures only because the creator holds zero
                  there, so the button is disabled for an unrelated reason.
                  Rather than build a SECOND redeem path here — a money rail
                  duplicated in two files is how the two drift — the Studio sends
                  the creator to the one that already exists, on their own token
                  page. No dead control, no second implementation. */}
              {market.windingDown ? (
                <div className="mt-4 rounded-control border border-line-11 bg-surface-5 px-4 py-3 text-caption text-ink-10 font-ui">
                  This market is winding down, so selling on the curve is closed. Your tokens are redeemed from your
                  own token page instead.{' '}
                  <a href={`/creators/${studio.creator ?? ''}`} className="font-medium text-ink-brand-6 hover:underline">
                    Open your token page
                  </a>
                </div>
              ) : (
                <>
              <div className="mt-4 flex items-center gap-2">
                <span className="text-caption text-ink-10 font-ui">Cash out</span>
                <input
                  value={sellInput}
                  onChange={(e) => {
                    setSellInput(e.target.value);
                    setSellFailure(null);
                  }}
                  placeholder="tokens"
                  inputMode="decimal"
                  className="w-[110px] rounded-control border border-line-11 px-3 py-2 text-[14px] leading-[22px] tabular-nums font-num outline-none focus-visible:outline-none focus:border-line-brand-10 focus:ring-1 focus:ring-line-brand-10"
                />
                <button
                  onClick={async () => {
                    if (!Number.isFinite(sellTokens) || sellTokens <= 0) return;
                    // F7 fix: correctness now comes from use-live-studio.ts's
                    // `call()`, which every studio write (including this sell)
                    // funnels through and which guards synchronously — see its
                    // own doc. This still checks studio.isBusy so a genuine
                    // double-click reads as a no-op rather than a caught
                    // CREATOR_TOKENS_BUSY error.
                    if (studio.isBusy) return;
                    setSellFailure(null);
                    try {
                      // F5 fix: sellMinNetUsd (defaulted just under the "you
                      // receive" figure below — see its derivation above) was
                      // structurally unreachable from this control before
                      // use-live-studio.ts's sell() gained the parameter.
                      await studio.sell(sellTokens, sellMinNetUsd);
                      setSellInput('');
                    } catch (err) {
                      // The REAL reason, not a guess. See ../write-failure.ts.
                      setSellFailure(writeFailureMessage(err, 'That sell didn’t go through.'));
                    }
                  }}
                  /* ★★★ GATED ON THE BALANCE (2026-08-30, clauderfly-43). This
                     checked only that a positive number had been typed, so it would
                     broadcast a sell for more tokens than the creator holds —
                     sell.go refuses that with "insufficient credits" after the
                     signature and the resource credits are spent. It was worse than
                     it looked while `held` was structurally 0: the sell preview
                     clamps to the position, so every figure under this control read
                     zero and `sellMinNetUsd` came out undefined, i.e. the sale went
                     out with NO minimum-net floor at all, on the exit screen.
                     `positionUnavailable` blocks it too: signing a sell against a
                     balance we could not read is the same bet with the reason
                     hidden. */
                  disabled={
                    !Number.isFinite(sellTokens) ||
                    sellTokens <= 0 ||
                    positionUnavailable ||
                    sellTokens > held ||
                    studio.isBusy
                  }
                  className="rounded-control bg-surface-43 px-4 py-2 text-caption font-medium text-ink-27 font-ui disabled:opacity-50"
                >
                  Sell
                </button>
              </div>
              {sellTokens > 0 ? (
                <div className="mt-2.5 flex items-center gap-2">
                  <label className="text-caption text-ink-10 font-ui">Minimum you’ll accept</label>
                  <div className="flex items-center rounded-control border border-line-11 px-2.5 py-1.5 focus-within:border-line-brand-10">
                    <input
                      value={sellMinNetDisplay}
                      onChange={(e) => {
                        setSellMinNetTouched(true);
                        setSellMinNetText(e.target.value);
                        setSellFailure(null);
                      }}
                      inputMode="decimal"
                      placeholder="optional"
                      className="w-[70px] border-0 text-[13px] leading-[20px] tabular-nums text-ink-2 font-num outline-none focus-visible:outline-none"
                    />
                    <span className="text-caption font-medium text-ink-14 font-ui">HBD</span>
                  </div>
                </div>
              ) : null}
              {/* ★ A DISABLED CONTROL MUST SAY WHY (2026-08-30, clauderfly-43).
                  The Sell button now refuses an amount above the balance and a
                  balance we could not read, and this file has already been burned
                  once by a control that refused silently (the 2026-08-09 setCap,
                  which a tester probed eight times and could not tell apart from a
                  dead button). Same `sellFailure` slot, so there is one place a
                  reader looks. */}
              {positionUnavailable && sellTokens > 0 ? (
                <div className="mt-2 text-caption font-medium text-ink-brand-6 font-ui">
                  We couldn’t read your token balance just now, so this can’t be sold safely. Try again in a moment.
                </div>
              ) : sellTokens > held ? (
                <div className="mt-2 text-caption font-medium text-ink-brand-6 font-ui">
                  You hold {tok(held)} tokens. Lower the amount to sell.
                </div>
              ) : null}
              {sellFailure ? (
                <div className="mt-2 text-caption font-medium text-ink-brand-6 font-ui">{sellFailure}</div>
              ) : null}
              <p className="mt-3 text-caption text-ink-14 font-ui">
                Selling your own tokens returns them to dollars at the market price. Never blocked by billing. The
                minimum above is pre-filled just under what you’d get right now, so the sell reverts (nothing
                spent) rather than fill lower. Clear it for no minimum, or lower it to allow more slippage.
              </p>
                </>
              )}
            </Card>
          </div>
        ) : null}
      </div>

      {answering ? <AnswerModal ask={answering} studio={studio} onClose={() => setAnswering(null)} /> : null}
      {retireOpen ? (
        <RetireModal
          handle={studio.creator ?? ''}
          onConfirm={studio.retire}
          onClose={() => setRetireOpen(false)}
        />
      ) : null}
    </TokenShell>
  );
};

export default CreatorStudio;
