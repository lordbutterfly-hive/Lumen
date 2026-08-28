'use client';

import { cn } from '@ui/lib/utils';
import { displayHandle, dueLabelFor } from '../../live/adapt';
import { FC, useState, useEffect, useRef } from 'react';
import { useLiveStudio, type LiveStudio } from '../../live/use-live-studio';
import { MarketLoading, MarketReadFailed, MarketSessionUnavailable, MarketUnavailable } from '../../live/market-states';
import type { Ask } from '../../types';
import { pctLabel, pctValue, usdPrice, usdWhole, usdWholeNonZero } from '../../market/format';
// ★★ THE FLOOR / RESERVE FIGURES ARE HIDDEN FOR LAUNCH (owner, 2026-08-27), on
// every surface at once, from one flag. The creator's dashboard is one of the
// four; nothing here is deleted, and every expression returns with the flag.
import { SHOW_BACKING_FIGURES } from '../../backing-visibility';
import { sellQuote, serviceQuote, serviceSupplyShareProblem, MIN_NET_DEFAULT_TOLERANCE_BPS } from '../../market/curve';
import TokenShell from '../token-shell';
import { writeFailureMessage } from '../write-failure';
import { MAX_HASH_LEN } from '../../lib/vsc/payload-contract';
import ModalShell from '../modal-shell';
import { offerTitleProblem } from '../../lib/vsc/op-builders';

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
    <div className="text-label font-semibold uppercase tracking-wide text-ink-14">{label}</div>
    <div className={`mt-1 text-[22px] leading-[34px] font-bold tabular-nums ${green ? 'text-ink-ok-2' : 'text-ink-2'}`}>
      {value}
    </div>
    {sub ? <div className="mt-0.5 text-caption tabular-nums text-ink-10">{sub}</div> : null}
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
      className="ml-1 w-[70px] border-0 text-[15px] leading-[24px] font-bold tabular-nums text-ink-2 outline-none focus-visible:outline-none disabled:opacity-60"
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
      className="w-full truncate border-0 bg-transparent text-[14px] leading-[22px] font-semibold text-ink-2 outline-none focus-visible:outline-none focus:underline disabled:opacity-60"
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
  const answerHasPipe = text.includes('|');
  const answerValid = text.trim().length > 0 && text.trim().length <= MAX_HASH_LEN && !answerHasPipe;
  return (
    <ModalShell width={500} onClose={onClose} title="Mark this job delivered" className="p-6">
      <div className="mb-2 font-serif text-xl font-semibold text-ink-2">Mark this job delivered</div>
      {/* The contract carries a REFERENCE, not the brief (USER RULING
            2026-07-28): it facilitates payment and reputation, and the two
            parties arrange the work between themselves. Showing the reference is
            honest; pretending a message arrived here would not be. */}
      <div className="mb-3 rounded-control border border-line-9 bg-surface-16 px-3.5 py-3 text-caption text-ink-8">
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
            'mb-3 rounded-control px-3.5 py-2.5 text-caption font-semibold',
            urgent ? 'bg-surface-warn-4 text-ink-warn-3' : 'bg-surface-16 text-ink-8'
          )}
          data-testid="answer-modal-deadline"
        >
          {dueLabel}
          {urgent ? ', under a day left' : null}
        </div>
      ) : (
        <div
          className="mb-3 rounded-control bg-surface-warn-4 px-3.5 py-2.5 text-caption font-semibold text-ink-warn-3"
          data-testid="answer-modal-deadline"
        >
          The deadline has passed. The buyer can reclaim their tokens, and marking this
          delivered may no longer release the escrow.
        </div>
      )}
      <p className="mb-3 text-caption text-ink-10">
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
        className="h-[130px] w-full resize-y rounded-xl border border-line-11 px-4 py-3 font-serif text-[15px] leading-[24px] text-ink-2 outline-none focus-visible:outline-none focus:border-line-brand-10"
      />
      <div className="mt-1 flex justify-between text-caption text-ink-14">
        <span className={answerHasPipe ? 'font-semibold text-ink-brand-6' : ''}>
          {answerHasPipe
            ? 'Remove the “|”. The chain refuses it in this field.'
            : 'Stored on chain as a public reference.'}
        </span>
        <span className="tabular-nums">
          {text.length}/{MAX_HASH_LEN}
        </span>
      </div>
      <div className="mt-3 rounded-control bg-surface-18 px-3.5 py-2.5 text-caption text-ink-ok-2">
        This pays you <strong className="tabular-nums">{tok(ask.tokensEscrowed)} tokens</strong> and closes the job. It can’t be undone,
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
          disabled={busy}
          className="flex-1 rounded-xl border border-line-11 py-3 text-[14px] leading-[22px] font-semibold text-ink-10 disabled:opacity-50"
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
          disabled={busy || !answerValid}
          className="flex-1 rounded-xl bg-surface-brand-12 py-3 text-[14px] leading-[22px] font-semibold text-ink-27 hover:bg-surface-brand-17 disabled:opacity-50"
        >
          {busy ? 'Confirm in your wallet…' : 'Mark as delivered'}
        </button>
      </div>
      {failure ? (
        <div className="mt-3 text-center text-caption font-semibold text-ink-brand-6">{failure}</div>
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
      <div className="mb-2 font-serif text-xl font-semibold text-ink-brand-6">End your Meritum?</div>
      <ul className="mb-4 space-y-1.5 font-serif text-[14px] leading-[22px] text-ink-8">
        <li>· The market freezes now. No new buys or asks.</li>
        <li>· You’re removed from discovery.</li>
        {/* ★ "refunded at the floor" until 2026-08-27. With the figure hidden
            (../../backing-visibility.ts) that phrase pointed at a number no
            longer anywhere in Studio. The MECHANISM is what a creator needs
            here, and it is the wording WIND_DOWN_BANNER already uses on the
            buyer side, so the two screens now describe one event the same way.
            Unguarded on purpose: it is true whether or not the stat is shown. */}
        <li>· Every holder is refunded their share of the reserve, less any early-exit fee.</li>
        <li>· Asks you’ve received still resolve. Answer them to get paid.</li>
        <li>· Your delivery record is lost. Coming back means a new token.</li>
        <li>· This can’t be undone.</li>
      </ul>
      <label className="mb-1.5 block text-caption font-semibold text-ink-10">
        Type your handle (@{handle}) to confirm
      </label>
      <input
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder={`@${handle}`}
        className="mb-4 w-full rounded-xl border border-line-11 px-4 py-3 text-[15px] leading-[24px] font-semibold outline-none focus-visible:outline-none focus:border-line-brand-10 focus:ring-1 focus:ring-line-brand-10"
      />
      <div className="flex gap-3">
        <button
          onClick={onClose}
          className="flex-1 rounded-xl border border-line-11 py-3 text-[14px] leading-[22px] font-semibold text-ink-10"
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
          className="flex-1 rounded-xl bg-surface-brand-12 py-3 text-[14px] leading-[22px] font-semibold text-ink-27 hover:bg-surface-brand-17 disabled:opacity-50"
        >
          End my token
        </button>
      </div>
      {failure ? (
        <div className="mt-3 text-center text-caption font-semibold text-ink-brand-6">{failure}</div>
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
   * priced at a fraction of total supply no buyer can reach. Measured live:
   * a 30-cap market listing a $15 service at 14 tokens, 47% of every token that
   * will ever exist.
   *
   * `studio.market` is nullable and the guard returns null on anything it
   * cannot judge, so a failed market read blocks nothing — see
   * serviceSupplyShareProblem's own note on why a guard that fires on a
   * missing number is worse than no guard.
   */
  const supplyProblem =
    studio.market === null ? null : serviceSupplyShareProblem(usd, studio.market.priceUsd, studio.market.cap);
  const valid =
    title.trim().length > 0 && titleProblem === null && Number.isFinite(usd) && usd > 0 && supplyProblem === null;
  return (
    <div className="mt-4 border-t border-line-2 pt-4">
      <div className="mb-2 text-caption font-semibold text-ink-10">Add a service</div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setFailure(null);
          }}
          placeholder="e.g. Review my code"
          aria-invalid={titleProblem !== null}
          className={`min-w-[200px] flex-1 rounded-control border px-3 py-2 text-[14px] leading-[22px] outline-none focus-visible:outline-none focus:ring-1 ${
            titleProblem !== null
              ? 'border-line-warn-2 focus:border-line-warn-2 focus:ring-line-warn-2'
              : 'border-line-11 focus:border-line-brand-10 focus:ring-line-brand-10'
          }`}
        />
        <div className="flex items-center rounded-control border border-line-11 px-3 py-2 focus-within:border-line-brand-10 focus-within:ring-1 focus-within:ring-line-brand-10">
          <span className="font-bold text-ink-14">$</span>
          <input
            value={price}
            onChange={(e) => {
              setPrice(e.target.value);
              setFailure(null);
            }}
            inputMode="decimal"
            placeholder="0"
            className="ml-1 w-[80px] border-0 text-[14px] leading-[22px] font-bold tabular-nums outline-none focus-visible:outline-none"
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
          className="rounded-control bg-surface-43 px-4 py-2 text-caption font-semibold text-ink-27 disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {/* The typing-time problem takes precedence: it is actionable right now,
          whereas `failure` is the outcome of an attempt already made. */}
      {titleProblem ? (
        <div className="mt-2 text-caption font-semibold text-ink-warn-3">{titleProblem}</div>
      ) : supplyProblem ? (
        // Same precedence rule as the title: actionable-right-now beats the
        // outcome of an attempt already made.
        <div className="mt-2 text-caption font-semibold text-ink-warn-3">{supplyProblem}</div>
      ) : failure ? (
        <div className="mt-2 text-caption font-semibold text-ink-brand-6">{failure}</div>
      ) : null}
    </div>
  );
};

const CreatorStudio: FC = () => {
  const studio = useLiveStudio();
  const { market, inbox, rawInbox, inboxUnavailable, subDaysLeft, tradeFeeClaimableUsd, commissionEarnedUsd, status } =
    studio;
  const [section, setSection] = useState<Section>('overview');
  const [answering, setAnswering] = useState<Ask | null>(null);
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
  const runStudioAction = async (fn: () => Promise<unknown>, fallback: string): Promise<void> => {
    setActionFailure(null);
    try {
      await fn();
    } catch (err) {
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
          <h1 className="font-serif text-3xl font-semibold text-ink-2">Creator Studio</h1>
          <p className="mt-3 font-serif text-[15px] leading-[24px] text-ink-10">
            This account can’t sign transactions yet, so it can’t run a Meritum.{' '}
            <a href="/upgrade" className="font-semibold text-ink-brand-6 hover:underline">
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
            className="mt-6 inline-block rounded-card border border-line-9 px-6 py-3 text-[15px] leading-[24px] font-bold text-ink-2 hover:bg-surface-17"
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
          <h1 className="font-serif text-3xl font-semibold text-ink-2">Launch your Meritum</h1>
          {/* ★ "FREE TO LAUNCH" ALONE READ AS A BAIT (2026-08-23, journey run). It is true,
              and so is "About $10 a month" at step 1 of the wizard and "~$10/month" in the
              Subscription card below - the reader met the free claim first and the cost
              second, on a different screen. Both facts now sit in the same breath, which
              costs one sentence and removes the reveal. Figures match `term_listed_value`
              ("About $10 a month.") and the Subscription card verbatim; if either moves,
              move all three. */}
          <p className="mt-3 font-serif text-[15px] leading-[24px] text-ink-10">
            One token, bound to your account, that trades on a live market and is spent on your services. Free
            to launch, then about $10 a month to stay listed. First month’s on the house.
          </p>
          <a
            href="/creators/launch"
            className="mt-6 inline-block rounded-card bg-surface-brand-12 px-6 py-3 text-[15px] leading-[24px] font-bold text-ink-27 hover:bg-surface-brand-17"
          >
            Open the launch wizard
          </a>
        </div>
      </TokenShell>
    );
  }

  // ★ TWIN OF THE "0%" BUG, FOUND 2026-08-21. This is the same
  // `Math.round(supply / cap * 100)` that was fixed in
  // `ui/token-page/token-market-view.tsx` — and the fix never reached this copy,
  // so the creator's OWN dashboard kept reporting "cap 0% used" about a market
  // that had genuinely issued tokens. `pctValue` drives the bar geometry (where
  // rounding to 0 is correct); `supplyPctLabel` is what a person reads.
  const supplyPct = pctValue(market.supply, market.cap);
  const supplyPctLabel = pctLabel(market.supply, market.cap) ?? '0%';
  const overdue = subDaysLeft <= 0;
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

  const banner = overdue ? (
    <div className="mb-5 flex items-center justify-between gap-3 rounded-card border border-line-warn-2 bg-surface-warn-4 px-5 py-3.5">
      <span className="text-[14px] leading-[22px] font-semibold text-ink-warn-3">
        Your listing has lapsed. Renew to stay in discovery. Answering and cashing out still work.
      </span>
      <button
        onClick={() => void runStudioAction(() => studio.renew(1), 'Renewing your listing didn’t go through.')}
        disabled={studio.isBusy}
        className="rounded-control bg-surface-warn-11 px-4 py-2 text-caption font-semibold text-ink-27 disabled:opacity-50"
      >
        Renew ~$10
      </button>
    </div>
  ) : null;

  return (
    <TokenShell back={{ href: '/creators', label: '← All creators' }}>
      <div className="pt-[26px]">
        <div className="mb-1 flex items-center gap-3">
          <span className="h-11 w-11 rounded-card bg-surface-28" />
          <div>
            <h1 className="font-serif text-2xl font-semibold text-ink-2">Creator Studio</h1>
            <p className="text-[14px] leading-[22px] text-ink-10">Your token @{displayHandle(studio.creator)} · your control room</p>
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
              className={`rounded-control px-4 py-2 font-sans text-[14px] leading-[22px] font-semibold transition-colors ${
                section === s.id ? 'bg-[var(--lum-1)] text-ink-2' : 'text-ink-10 hover:text-ink-2'
              }`}
            >
              {s.label}
              {s.id === 'inbox' && inbox.length > 0 ? (
                <span className="ml-1.5 rounded-full bg-surface-brand-12 px-1.5 text-caption tabular-nums text-ink-27">
                  {inbox.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {banner}
        {actionFailure ? (
          <div className="mb-5 rounded-card border border-line-brand-3 bg-surface-brand-7 px-5 py-3.5 text-[14px] leading-[22px] font-semibold text-ink-brand-6">
            {actionFailure}
          </div>
        ) : null}

        {section === 'overview' ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card>
              <Stat
                label="Token price"
                value={usdPrice(market.priceUsd)}
                /* ★ Hidden for launch. The cap half of this line is the half a
                   creator acts on, so it survives on its own with a capital
                   rather than being dropped with the floor. The original string
                   is the other branch, unchanged. */
                sub={
                  SHOW_BACKING_FIGURES
                    ? `Floor ${usdPrice(market.floorUsd)} · cap ${supplyPctLabel} used`
                    : `Cap ${supplyPctLabel} used`
                }
              />
            </Card>
            <Card>
              <Stat
                label="Market cap"
                value={usdWhole(market.marketCapUsd)}
                sub={`${market.supply.toLocaleString('en-US')} of ${market.cap.toLocaleString('en-US')} tokens`}
              />
            </Card>
            <Card>
              <Stat
                label="Delivery"
                /* The creator's own dashboard read "0%" and "0/0 answered · " on
                   the day they launched. Nothing has been asked of them yet; say
                   that, rather than scoring them zero for it. */
                value={market.delivery.completionPct === null ? '—' : (pctLabel(market.delivery.answered, market.delivery.total) ?? '0%')}
                sub={
                  market.delivery.completionPct === null
                    ? 'No deliveries yet'
                    : `${market.delivery.answered}/${market.delivery.total} answered${market.delivery.typicalResponse ? ` · ${market.delivery.typicalResponse}` : ''}`
                }
              />
            </Card>
            <Card>
              <Stat
                label="Subscription"
                value={overdue ? 'Lapsed' : `${subDaysLeft} days left`}
                sub={overdue ? 'Renew to stay listed' : `Renew ~$10`}
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
          <div className="flex flex-col gap-2.5">
            {/* ★ "you’re all caught up" was shown to creators whose escrows
                exist and simply could not be read (2026-08-28, F2). Retry, do
                not reassure — the same shape the Offerings tab already uses. */}
            {inboxUnavailable ? (
              <Card>
                <div className="py-6 text-center text-caption text-ink-brand-2">
                  <p>Your requests couldn’t be loaded just now. This is not an empty inbox.</p>
                  <button
                    type="button"
                    onClick={() => studio.retry()}
                    className="mt-2 rounded-control border border-line-12 bg-surface-1 px-3 py-1.5 text-caption font-semibold text-ink-2 hover:border-line-28"
                  >
                    Try again
                  </button>
                </div>
              </Card>
            ) : inbox.length === 0 ? (
              <Card>
                <p className="py-6 text-center font-serif text-sm italic text-ink-14">
                  No requests waiting. Nice, you’re all caught up.
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
                    <div className="text-[15px] leading-[24px] font-semibold text-ink-2">{a.service}</div>
                    <div
                      className={`text-caption font-semibold ${a.urgent ? 'text-ink-warn-3' : 'text-ink-10'}`}
                    >
                      {a.dueLabel}
                    </div>
                  </div>
                  <div className="mt-1 text-caption tabular-nums text-ink-10">
                    {usdWhole(a.costUsd)} · {tok(a.tokens)} tokens escrowed
                  </div>
                  <div className="mt-3">
                    <button
                      onClick={() => setAnswering(rawInbox[i])}
                      className="rounded-control bg-surface-brand-12 px-4 py-2 text-caption font-semibold text-ink-27 hover:bg-surface-brand-17"
                    >
                      Answer or decline
                    </button>
                  </div>
                </Card>
              ))
            )}
          </div>
        ) : null}

        {section === 'offerings' ? (
          <Card>
            <div className="mb-3 font-serif text-lg font-semibold text-ink-2">
              Your services &amp; prices
            </div>
            <p className="mb-4 text-caption text-ink-10">
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
                <div className="text-[14px] leading-[22px] font-semibold text-ink-2">Default ask price</div>
                <div className="text-caption text-ink-14">
                  {studio.offerings === null
                    ? 'Shown on your token page as “Ask a question”.'
                    : studio.offerings.length === 0
                      ? 'Shown on your token page as “Ask a question”. This is the only price buyers see until you add a named service.'
                      : 'Used for “Ask a question”, alongside the named services below.'}
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center rounded-control border border-line-11 px-3 py-2 focus-within:border-line-brand-10 focus-within:ring-1 focus-within:ring-line-brand-10">
                <span className="font-bold text-ink-14">$</span>
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
                <div className="rounded-xl border border-dashed border-line-brand-2 px-4 py-5 text-center text-caption text-ink-brand-2">
                  <p>Your services couldn’t be loaded just now. This is not an empty shop.</p>
                  <button
                    type="button"
                    onClick={() => studio.retry()}
                    className="mt-2 rounded-control border border-line-12 bg-surface-1 px-3 py-1.5 text-caption font-semibold text-ink-2 hover:border-line-28"
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
                      <div className="text-caption tabular-nums text-ink-14">
                        {market.priceUsd > 0
                          ? `≈ ${tok(serviceQuote(o.priceHbd, market.priceUsd).tokens)} tokens at today’s price`
                          : 'Token price unavailable'}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <div className="flex items-center rounded-control border border-line-11 px-3 py-2 focus-within:border-line-brand-10 focus-within:ring-1 focus-within:ring-line-brand-10">
                        <span className="font-bold text-ink-14">$</span>
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
                        className="rounded-control border border-line-11 px-3 py-2 text-caption font-semibold text-ink-10 hover:bg-surface-16 disabled:opacity-50"
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
            <div className="mt-5">
              <div className="mb-1 flex justify-between text-caption text-ink-10">
                <span>Supply</span>
                <span className="tabular-nums">
                  {market.supply.toLocaleString('en-US')} / {market.cap.toLocaleString('en-US')}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-23">
                <div className="h-full bg-surface-brand-12" style={{ width: `${supplyPct}%` }} />
              </div>
            </div>
            <div className="mt-5 flex items-center gap-2">
              <span className="text-caption text-ink-10">Raise cap to</span>
              <input
                value={capInput}
                onChange={(e) => setCapInput(e.target.value)}
                inputMode="numeric"
                className="w-[110px] rounded-control border border-line-11 px-3 py-2 text-[14px] leading-[22px] font-semibold tabular-nums outline-none focus-visible:outline-none focus:border-line-brand-10 focus:ring-1 focus:ring-line-brand-10"
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
                className="rounded-control bg-surface-43 px-4 py-2 text-caption font-semibold text-ink-27 disabled:opacity-50"
              >
                Raise cap
              </button>
              <span className="text-caption tabular-nums text-ink-14">
                lower only down to {market.supply.toLocaleString('en-US')} issued
              </span>
            </div>
            <p className="mt-4 rounded-control bg-surface-16 px-3.5 py-3 text-caption text-ink-10">
              Your token’s price is set by the market: buys raise it, sells lower it. You don’t set the
              price; you set your <strong>service prices</strong> in dollars.
            </p>
          </Card>
        ) : null}

        {section === 'billing' ? (
          <Card>
            <div className="mb-1 font-serif text-lg font-semibold text-ink-2">Subscription</div>
            <div className="mb-4 text-[14px] leading-[22px] text-ink-8">
              {overdue ? 'Lapsed. Renew to stay listed.' : `Paid up · ${subDaysLeft} days left.`} Staying
              listed is ~$10/month. First month’s on the house.
            </div>
            <button
              onClick={() => void runStudioAction(() => studio.renew(1), 'Renewing your listing didn’t go through.')}
              disabled={studio.isBusy}
              className="rounded-control bg-surface-brand-12 px-5 py-2.5 text-[14px] leading-[22px] font-semibold text-ink-27 hover:bg-surface-brand-17 disabled:opacity-50"
            >
              Renew ~$10
            </button>
            <p className="mt-4 text-caption text-ink-14">
              If you stop paying, your token’s market winds down, holders are refunded their share of the reserve
              less any early-exit fee, and your
              delivery record resets, and coming back means a new token. Answering and cashing out are never
              blocked by billing.
            </p>
            <div className="mt-5 border-t border-line-2 pt-4">
              {market.windingDown ? (
                <div className="text-caption font-semibold text-ink-warn-3">
                  This token is winding down. Holders are being refunded their share of the reserve, less any
                  early-exit fee. Answering and cashing
                  out still work.
                </div>
              ) : (
                <button
                  onClick={() => setRetireOpen(true)}
                  className="rounded-control border border-line-brand-1 px-4 py-2 text-caption font-semibold text-ink-brand-6 hover:bg-surface-brand-3"
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
                    className="rounded-control border border-line-12 bg-surface-1 px-5 py-2.5 text-[14px] leading-[22px] font-semibold text-ink-2 hover:border-line-28"
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
                    className="rounded-control bg-surface-ok-7 px-5 py-2.5 text-[14px] leading-[22px] font-semibold text-ink-27 hover:bg-surface-ok-8 disabled:opacity-50"
                  >
                    {tradeFeeClaimableUsd <= 0 ? 'Claimed' : 'Claim'}
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
                value={`${tok(held)} tokens`}
                /* ★ Hidden for launch. The mark-to-price half stays: it is this
                   creator's own holding at the live curve price, and it is the
                   figure the Cash out control below is denominated against. */
                sub={
                  SHOW_BACKING_FIGURES
                    ? `worth ${usdPrice(held * market.priceUsd)} · floor ${usdPrice(held * market.floorUsd)}`
                    : `worth ${usdPrice(held * market.priceUsd)}`
                }
              />
              <div className="mt-4 flex items-center gap-2">
                <span className="text-caption text-ink-10">Cash out</span>
                <input
                  value={sellInput}
                  onChange={(e) => {
                    setSellInput(e.target.value);
                    setSellFailure(null);
                  }}
                  placeholder="tokens"
                  inputMode="decimal"
                  className="w-[110px] rounded-control border border-line-11 px-3 py-2 text-[14px] leading-[22px] font-semibold tabular-nums outline-none focus-visible:outline-none focus:border-line-brand-10 focus:ring-1 focus:ring-line-brand-10"
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
                  disabled={!Number.isFinite(sellTokens) || sellTokens <= 0 || studio.isBusy}
                  className="rounded-control bg-surface-43 px-4 py-2 text-caption font-semibold text-ink-27 disabled:opacity-50"
                >
                  Sell
                </button>
              </div>
              {sellTokens > 0 ? (
                <div className="mt-2.5 flex items-center gap-2">
                  <label className="text-caption text-ink-10">Minimum you’ll accept</label>
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
                      className="w-[70px] border-0 text-[13px] leading-[20px] font-semibold tabular-nums text-ink-2 outline-none focus-visible:outline-none"
                    />
                    <span className="text-caption font-semibold text-ink-14">HBD</span>
                  </div>
                </div>
              ) : null}
              {sellFailure ? (
                <div className="mt-2 text-caption font-semibold text-ink-brand-6">{sellFailure}</div>
              ) : null}
              <p className="mt-3 text-caption text-ink-14">
                Selling your own tokens returns them to dollars at the market price. Never blocked by billing. The
                minimum above is pre-filled just under what you’d get right now, so the sell reverts (nothing
                spent) rather than fill lower. Clear it for no minimum, or lower it to allow more slippage.
              </p>
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
