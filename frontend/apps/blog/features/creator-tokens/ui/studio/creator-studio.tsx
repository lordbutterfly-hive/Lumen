'use client';

import { FC, useState, useEffect } from 'react';
import { useLiveStudio, type LiveStudio } from '../../live/use-live-studio';
import { MarketLoading, MarketReadFailed, MarketUnavailable } from '../../live/market-states';
import type { Ask } from '../../types';
import { usdPrice, usdWhole } from '../../market/format';
import TokenShell from '../token-shell';
import { writeFailureMessage } from '../write-failure';
import { MAX_HASH_LEN } from '../../lib/vsc/payload-contract';

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
  <div className={`rounded-[18px] border border-[#ebebeb] bg-white p-5 shadow-[0_1px_2px_rgba(20,18,10,0.03)] ${className}`}>{children}</div>
);
const Stat: FC<{ label: string; value: string; sub?: string; green?: boolean }> = ({ label, value, sub, green }) => (
  <div>
    <div className="text-[12px] font-semibold uppercase tracking-wide text-[#9ca3af]">{label}</div>
    <div className={`mt-1 text-[22px] font-bold tabular-nums ${green ? 'text-[#2f7d4f]' : 'text-[#161511]'}`}>{value}</div>
    {sub ? <div className="mt-0.5 text-[12.5px] text-[#6b7280]">{sub}</div> : null}
  </div>
);

// Controlled service-price editor: reverts an invalid entry to the committed
// price so the field never lies (#4), and re-syncs when the stored price changes.
// onCommit now reports whether the store actually changed the price — a
// refusal (an invalid amount, or an unknown service key) reverts the field
// exactly like a locally-invalid entry does, rather than leaving it showing
// an unconfirmed number the store silently ignored.
const PriceInput: FC<{ value: number; onCommit: (usd: number) => Promise<void> }> = ({ value, onCommit }) => {
  const [txt, setTxt] = useState(String(value));
  useEffect(() => setTxt(String(value)), [value]);
  return (
    <input
      value={txt}
      inputMode="decimal"
      onChange={(e) => setTxt(e.target.value)}
      onBlur={async () => {
        const n = parseFloat(txt.replace(/,/g, ''));
        if (!Number.isFinite(n) || n <= 0) {
          setTxt(String(value));
          return;
        }
        // The commit is a signed broadcast now, and it can be REFUSED — most
        // often by the offering's own 2x/7d anti-rug band. Revert the field on
        // rejection so it never displays a price the chain did not accept.
        try {
          await onCommit(n);
        } catch {
          setTxt(String(value));
        }
      }}
      className="ml-1 w-[70px] border-0 text-[15px] font-bold tabular-nums text-[#161511] outline-none"
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
const TitleInput: FC<{ value: string; onCommit: (title: string) => Promise<void>; disabled?: boolean }> = ({
  value,
  onCommit,
  disabled
}) => {
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
        try {
          await onCommit(next);
        } catch {
          setTxt(value);
        }
      }}
      className="w-full truncate border-0 bg-transparent text-[14px] font-semibold text-[#161511] outline-none focus:underline disabled:opacity-60"
    />
  );
};

const AnswerModal: FC<{ ask: Ask; studio: LiveStudio; onClose: () => void }> = ({ ask, studio, onClose }) => {
  const [text, setText] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // core/ask.go:521 refuses a '|' in answerHash outright: the escrow record
  // is packed as a pipe-delimited string (core/ask.go:157), so one stray
  // pipe would re-partition it. maxLength handles the length bound; this
  // handles the character the browser cannot.
  const answerHasPipe = text.includes('|');
  const answerValid = text.trim().length > 0 && text.trim().length <= MAX_HASH_LEN && !answerHasPipe;
  return (
    <div onClick={onClose} className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(20,18,10,0.4)] p-5 backdrop-blur-[2px]">
      <div onClick={(e) => e.stopPropagation()} className="w-[500px] max-w-full rounded-[20px] bg-white p-6 shadow-[0_20px_60px_rgba(20,18,10,0.25)]">
        <div className="mb-2 font-serif text-xl font-semibold text-[#161511]">Mark this job delivered</div>
        {/* The contract carries a REFERENCE, not the brief (USER RULING
            2026-07-28): it facilitates payment and reputation, and the two
            parties arrange the work between themselves. Showing the reference is
            honest; pretending a message arrived here would not be. */}
        <div className="mb-3 rounded-[10px] border border-[#ebebeb] bg-[#f6f7f8] px-3.5 py-3 text-[13px] text-[#4b5563]">
          Reference <strong className="font-mono">{ask.contentHash || '—'}</strong> · from @{ask.asker}
        </div>
        <p className="mb-3 text-[13px] leading-[1.5] text-[#6b7280]">
          Arrange and deliver the work with @{ask.asker} however you normally would. Marking it delivered releases the
          escrow to you — and the buyer then rates it, which is what your token’s reputation is built from.
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
          className="h-[130px] w-full resize-y rounded-xl border border-[#e4e6e9] px-4 py-3 font-serif text-[15px] leading-[1.5] text-[#161511] outline-none focus:border-[#c0392b]"
        />
        <div className="mt-1 flex justify-between text-[11.5px] text-[#9ca3af]">
          <span className={answerHasPipe ? 'font-semibold text-[#c0392b]' : ''}>
            {answerHasPipe ? 'Remove the “|” — the chain refuses it in this field.' : 'Stored on chain as a public reference.'}
          </span>
          <span className="tabular-nums">
            {text.length}/{MAX_HASH_LEN}
          </span>
        </div>
        <div className="mt-3 rounded-[10px] bg-[#f0f7f2] px-3.5 py-2.5 text-[13px] text-[#2f7d4f]">
          This pays you <strong>{tok(ask.tokensEscrowed)} tokens</strong> and closes the job. It can’t be undone — and the
          buyer rates it afterwards.
        </div>
        <div className="mt-4 flex gap-3">
          {/* DECLINE, given equal weight to Cancel. It is the creator's free,
              honest "no": the asker gets everything back INCLUDING the
              commission, and it is explicitly not a miss against the delivery
              record. A studio that offered only Answer would push a creator to
              take a black mark for work they simply cannot do. */}
          <button
            onClick={async () => {
              if (busy) return;
              setBusy(true);
              setFailure(null);
              try {
                await studio.decline({ seq: ask.seq, deadlineBlock: ask.deadlineBlock });
                onClose();
              } catch (err) {
                // The REAL reason, not a guess. See ../write-failure.ts.
                setFailure(writeFailureMessage(err, 'That didn’t go through.'));
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
            className="flex-1 rounded-xl border border-[#e4e6e9] py-3 text-[14px] font-semibold text-[#6b7280] disabled:opacity-50"
          >
            Decline &amp; refund
          </button>
          <button
            onClick={async () => {
              if (busy || !answerValid) return;
              setBusy(true);
              setFailure(null);
              try {
                // answerHash is the creator's own delivery NOTE/reference — a
                // link, a ticket number, "sent by email". The chain records that
                // something was handed over and pays out; it never judges what.
                await studio.answer({ seq: ask.seq, deadlineBlock: ask.deadlineBlock, answerHash: text.trim() });
                onClose();
              } catch (err) {
                // The REAL reason, not a guess. See ../write-failure.ts.
                setFailure(writeFailureMessage(err, 'That didn’t go through.'));
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy || !answerValid}
            className="flex-1 rounded-xl bg-[#c0392b] py-3 text-[14px] font-semibold text-white hover:bg-[#96271b] disabled:opacity-50"
          >
            {busy ? 'Confirm in your wallet…' : 'Mark as delivered'}
          </button>
        </div>
        {failure ? (
          <div className="mt-3 text-center text-[12.5px] font-semibold text-[#c0392b]">{failure}</div>
        ) : null}
      </div>
    </div>
  );
};

const RetireModal: FC<{ handle: string; onConfirm: () => Promise<void>; onClose: () => void }> = ({ handle, onConfirm, onClose }) => {
  const [confirm, setConfirm] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ok = confirm.trim().toLowerCase().replace(/^@/, '') === handle.toLowerCase();
  return (
    <div onClick={onClose} className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(20,18,10,0.4)] p-5 backdrop-blur-[2px]">
      <div onClick={(e) => e.stopPropagation()} className="w-[500px] max-w-full rounded-[20px] border border-[#f0c9c2] bg-white p-6 shadow-[0_20px_60px_rgba(20,18,10,0.25)]">
        <div className="mb-2 font-serif text-xl font-semibold text-[#c0392b]">End your creator token?</div>
        <ul className="mb-4 space-y-1.5 font-serif text-[13.5px] leading-[1.5] text-[#4b5563]">
          <li>· The market freezes now — no new buys or asks.</li>
          <li>· You’re removed from discovery.</li>
          <li>· Every holder is refunded at the floor.</li>
          <li>· Asks you’ve received still resolve — answer them to get paid.</li>
          <li>· Your delivery record is lost — coming back means a new token.</li>
          <li>· This can’t be undone.</li>
        </ul>
        <label className="mb-1.5 block text-[12.5px] font-semibold text-[#6b7280]">Type your handle (@{handle}) to confirm</label>
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={`@${handle}`} className="mb-4 w-full rounded-xl border border-[#e4e6e9] px-4 py-3 text-[15px] font-semibold outline-none" />
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 rounded-xl border border-[#e4e6e9] py-3 text-[14px] font-semibold text-[#6b7280]">Cancel</button>
          <button
            onClick={async () => {
              if (!ok || busy) return;
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
                setBusy(false);
              }
            }}
            disabled={!ok || busy}
            className="flex-1 rounded-xl bg-[#c0392b] py-3 text-[14px] font-semibold text-white hover:bg-[#96271b] disabled:opacity-50"
          >
            End my token
          </button>
        </div>
        {failure ? (
          <div className="mt-3 text-center text-[12.5px] font-semibold text-[#c0392b]">{failure}</div>
        ) : null}
      </div>
    </div>
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
  const valid = title.trim().length > 0 && Number.isFinite(usd) && usd > 0;
  return (
    <div className="mt-4 border-t border-[#f1f3f5] pt-4">
      <div className="mb-2 text-[12.5px] font-semibold text-[#6b7280]">Add a service</div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setFailure(null);
          }}
          placeholder="e.g. Review my code"
          className="min-w-[200px] flex-1 rounded-[10px] border border-[#e4e6e9] px-3 py-2 text-[14px] outline-none"
        />
        <div className="flex items-center rounded-[10px] border border-[#e4e6e9] px-3 py-2">
          <span className="font-bold text-[#9ca3af]">$</span>
          <input
            value={price}
            onChange={(e) => {
              setPrice(e.target.value);
              setFailure(null);
            }}
            inputMode="decimal"
            placeholder="0"
            className="ml-1 w-[80px] border-0 text-[14px] font-bold tabular-nums outline-none"
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
          className="rounded-[10px] bg-[#161511] px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {failure ? (
        <div className="mt-2 text-[12px] font-semibold text-[#c0392b]">{failure}</div>
      ) : null}
    </div>
  );
};

const CreatorStudio: FC = () => {
  const studio = useLiveStudio();
  const { market, inbox, rawInbox, subDaysLeft, tradeFeeClaimableUsd, commissionEarnedUsd, status } = studio;
  const [section, setSection] = useState<Section>('overview');
  const [answering, setAnswering] = useState<Ask | null>(null);
  const [retireOpen, setRetireOpen] = useState(false);
  const [capInput, setCapInput] = useState('');
  const [sellInput, setSellInput] = useState('');
  const [sellFailure, setSellFailure] = useState<string | null>(null);
  // Keep the cap field in sync with the committed cap after a successful raise (#3).
  const marketCap = market?.cap ?? null;
  useEffect(() => {
    if (marketCap !== null) setCapInput(String(marketCap));
  }, [marketCap]);

  // A lite account has no Hive keys, so every button on this page would open a
  // signer that does not exist; use-live-studio.ts's requireSigner refuses each
  // one, but only on click. launch-wizard.tsx:234 already gates its own Launch
  // button on exactly this, so the studio saying nothing was the inconsistency.
  if (studio.isLite) {
    return (
      <TokenShell>
        <div className="mx-auto max-w-[560px] pt-16 text-center">
          <h1 className="font-serif text-3xl font-semibold text-[#161511]">Creator studio</h1>
          <p className="mt-3 font-serif text-[15px] leading-[1.6] text-[#6b7280]">
            This account can’t sign transactions yet, so it can’t run a creator token. Upgrade to a full account first.
          </p>
        </div>
      </TokenShell>
    );
  }
  if (status === 'unavailable') return <MarketUnavailable />;
  if (status === 'loading') return <MarketLoading />;
  // A failed read must NOT fall through to the launch wizard: telling a creator
  // with a live market that they have no token, because the node blinked, is
  // exactly the "empty read rendered as real" failure this rewiring removes.
  if (status === 'error') return <MarketReadFailed onRetry={studio.retry} />;

  // status === 'missing' -> genuinely no market yet (or signed out). The launch
  // wizard is the whole studio in that state.
  if (!market) {
    return (
      <TokenShell>
        <div className="mx-auto max-w-[560px] pt-16 text-center">
          <h1 className="font-serif text-3xl font-semibold text-[#161511]">Launch your creator token</h1>
          <p className="mt-3 font-serif text-[15px] leading-[1.6] text-[#6b7280]">
            One token, bound to your account, that trades on a live market and is spent on your services. Free to launch.
          </p>
          <a href="/creators/launch" className="mt-6 inline-block rounded-[13px] bg-[#c0392b] px-6 py-3 text-[15px] font-bold text-white hover:bg-[#96271b]">
            Open the launch wizard
          </a>
        </div>
      </TokenShell>
    );
  }

  const supplyPct = market.cap > 0 ? Math.min(100, Math.round((market.supply / market.cap) * 100)) : 0;
  const overdue = subDaysLeft <= 0;
  const held = market.position?.tokens ?? 0;

  const banner = overdue ? (
    <div className="mb-5 flex items-center justify-between gap-3 rounded-[14px] border border-[#f6e2c4] bg-[#fdf6ec] px-5 py-3.5">
      <span className="text-[14px] font-semibold text-[#b45309]">Your listing has lapsed — renew to stay in discovery. Answering and cashing out still work.</span>
      <button onClick={() => void studio.renew(1)} disabled={studio.isBusy} className="rounded-[10px] bg-[#b45309] px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50">Renew ~$10</button>
    </div>
  ) : null;

  return (
    <TokenShell>
      <div className="pt-[26px]">
        <div className="mb-1 flex items-center gap-3">
          <span className="h-11 w-11 rounded-[13px] bg-[#e9ebee]" />
          <div>
            <h1 className="font-serif text-2xl font-semibold text-[#161511]">Creator Studio</h1>
            <p className="text-[13.5px] text-[#6b7280]">Your token @{studio.creator} · your control room</p>
          </div>
        </div>

        {/* Section tabs */}
        <div className="mb-5 mt-4 flex flex-wrap gap-1.5 rounded-[14px] border border-[#ebedf0] bg-[#f4f5f7] p-[5px]">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`rounded-[9px] px-4 py-2 font-sans text-[14px] font-semibold transition-colors ${
                section === s.id ? 'bg-white text-[#161511] shadow-sm' : 'text-[#6b7280] hover:text-[#161511]'
              }`}
            >
              {s.label}
              {s.id === 'inbox' && inbox.length > 0 ? <span className="ml-1.5 rounded-full bg-[#c0392b] px-1.5 text-[11px] text-white">{inbox.length}</span> : null}
            </button>
          ))}
        </div>

        {banner}

        {section === 'overview' ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card><Stat label="Token price" value={usdPrice(market.priceUsd)} sub={`Floor ${usdPrice(market.floorUsd)} · cap ${supplyPct}% used`} /></Card>
            <Card><Stat label="Market cap" value={usdWhole(market.marketCapUsd)} sub={`${market.supply.toLocaleString('en-US')} of ${market.cap.toLocaleString('en-US')} tokens`} /></Card>
            <Card><Stat label="Delivery" value={`${market.delivery.completionPct}%`} sub={`${market.delivery.answered}/${market.delivery.total} answered · ${market.delivery.typicalResponse}`} /></Card>
            <Card><Stat label="Subscription" value={overdue ? 'Lapsed' : `${subDaysLeft} days left`} sub={overdue ? 'Renew to stay listed' : `Renew ~$10`} /></Card>
            <Card><Stat label="Trade-fee share (claimable)" value={usdWhole(tradeFeeClaimableUsd)} green sub="Your 5% of the token’s trades" /></Card>
            <Card><Stat label="Requests waiting" value={String(inbox.length)} sub="In your Inbox" /></Card>
          </div>
        ) : null}

        {section === 'inbox' ? (
          <div className="flex flex-col gap-2.5">
            {inbox.length === 0 ? (
              <Card><p className="py-6 text-center font-serif text-sm text-[#9ca3af]">No requests waiting. Nice — you’re all caught up.</p></Card>
            ) : (
              // Rendered from the PORTFOLIO row (money + due label, already
              // adapted) but opened with the RAW escrow, because answer/decline
              // need seq and deadlineBlock — neither of which a portfolio row
              // carries. Zipped by index: both lists come from the same filtered
              // array in the same order, so they cannot drift.
              inbox.map((a, i) => (
                <Card key={a.id} className={a.urgent ? 'border-[#f6e2c4] bg-[#fdf6ec]' : ''}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[14.5px] font-semibold text-[#161511]">{a.service}</div>
                    <div className={`text-[12.5px] font-semibold ${a.urgent ? 'text-[#b45309]' : 'text-[#6b7280]'}`}>{a.dueLabel}</div>
                  </div>
                  <div className="mt-1 text-[12.5px] tabular-nums text-[#6b7280]">{usdWhole(a.costUsd)} · {tok(a.tokens)} tokens escrowed</div>
                  <div className="mt-3">
                    <button onClick={() => setAnswering(rawInbox[i])} className="rounded-[10px] bg-[#c0392b] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#96271b]">
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
            <div className="mb-3 font-serif text-lg font-semibold text-[#161511]">Your services &amp; prices</div>
            <p className="mb-4 text-[13px] text-[#6b7280]">
              Buyers pay these in your token at the live price. Set the dollar price — the token amount follows the market.
              A price can move at most 2× in any 7 days, and that limit follows the SERVICE NAME, so renaming or
              re-creating one won’t reset it.
            </p>
            <div className="flex flex-col gap-3">
              {studio.offerings.length === 0 ? (
                <p className="rounded-xl border border-dashed border-[#e4e6e9] px-4 py-5 text-center text-[13px] text-[#9ca3af]">
                  You haven’t posted any services yet. Add one below and it appears on your token page.
                </p>
              ) : (
                studio.offerings.map((o) => (
                  <div key={o.offeringId} className="flex items-center justify-between gap-3 rounded-xl border border-[#e4e6e9] px-4 py-3">
                    <div className="min-w-0">
                      <TitleInput
                        value={o.title}
                        disabled={studio.isBusy}
                        onCommit={(title) => studio.setOfferingTitle({ offeringId: o.offeringId, title })}
                      />
                      <div className="text-[12px] text-[#9ca3af]">
                        {market.priceUsd > 0 ? `≈ ${tok(o.priceHbd / market.priceUsd)} tokens at today’s price` : 'Token price unavailable'}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <div className="flex items-center rounded-[10px] border border-[#e4e6e9] px-3 py-2">
                        <span className="font-bold text-[#9ca3af]">$</span>
                        <PriceInput value={o.priceHbd} onCommit={(usd) => studio.setOfferingPrice({ offeringId: o.offeringId, priceUsd: usd })} />
                      </div>
                      <button
                        onClick={() => void studio.deleteOffering(o.offeringId)}
                        disabled={studio.isBusy}
                        title="Delist this service. Asks already made against it are unaffected."
                        className="rounded-[10px] border border-[#e4e6e9] px-3 py-2 text-[13px] font-semibold text-[#6b7280] hover:bg-[#f6f7f8] disabled:opacity-50"
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
              <Stat label="Price" value={usdPrice(market.priceUsd)} sub={`Floor ${usdPrice(market.floorUsd)}`} />
              <Stat label="Market cap" value={usdWhole(market.marketCapUsd)} />
              <Stat label="Reserve" value={usdWhole(market.reserveUsd)} sub="Backs the floor" />
            </div>
            <div className="mt-5">
              <div className="mb-1 flex justify-between text-[12.5px] text-[#6b7280]"><span>Supply</span><span className="tabular-nums">{market.supply.toLocaleString('en-US')} / {market.cap.toLocaleString('en-US')}</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-[#f1f3f5]"><div className="h-full bg-[#c0392b]" style={{ width: `${supplyPct}%` }} /></div>
            </div>
            <div className="mt-5 flex items-center gap-2">
              <span className="text-[13px] text-[#6b7280]">Raise cap to</span>
              <input value={capInput} onChange={(e) => setCapInput(e.target.value)} inputMode="numeric" className="w-[110px] rounded-[10px] border border-[#e4e6e9] px-3 py-2 text-[14px] font-semibold tabular-nums outline-none" />
              <button
                onClick={async () => {
                  const v = parseInt(capInput.replace(/[^\d]/g, ''), 10);
                  // The local `v >= issued` check is only a fast path; the
                  // CHAIN decides, and its view of issued supply may have moved
                  // since this render. Revert the field on any refusal so it
                  // never shows a cap the contract did not accept.
                  if (!Number.isFinite(v) || v < Math.ceil(market.supply)) {
                    setCapInput(String(market.cap));
                    return;
                  }
                  try {
                    await studio.setCap(v);
                  } catch {
                    setCapInput(String(market.cap));
                  }
                }}
                className="rounded-[10px] bg-[#161511] px-4 py-2 text-[13px] font-semibold text-white"
              >
                Raise cap
              </button>
              <span className="text-[12px] text-[#9ca3af]">lower only down to {market.supply.toLocaleString('en-US')} issued</span>
            </div>
            <p className="mt-4 rounded-[10px] bg-[#f6f7f8] px-3.5 py-3 text-[12.5px] leading-[1.5] text-[#6b7280]">
              Your token’s price is set by the market — buys raise it, sells lower it. You don’t set the price; you set your <strong>service prices</strong> in dollars.
            </p>
          </Card>
        ) : null}

        {section === 'billing' ? (
          <Card>
            <div className="mb-1 font-serif text-lg font-semibold text-[#161511]">Subscription</div>
            <div className="mb-4 text-[14px] text-[#4b5563]">{overdue ? 'Lapsed — renew to stay listed.' : `Paid up · ${subDaysLeft} days left.`} Staying listed is ~$10/month. First month’s on the house.</div>
            <button onClick={() => void studio.renew(1)} disabled={studio.isBusy} className="rounded-[11px] bg-[#c0392b] px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-[#96271b] disabled:opacity-50">Renew ~$10</button>
            <p className="mt-4 text-[12.5px] leading-[1.5] text-[#9ca3af]">
              If you stop paying, your token’s market winds down, holders are refunded at the floor, and your delivery record resets — coming back means a new token. Answering and cashing out are never blocked by billing.
            </p>
            <div className="mt-5 border-t border-[#f1f3f5] pt-4">
              {market.windingDown ? (
                <div className="text-[13px] font-semibold text-[#b45309]">This token is winding down — holders are being refunded at the floor. Answering and cashing out still work.</div>
              ) : (
                <button onClick={() => setRetireOpen(true)} className="rounded-[10px] border border-[#f0c9c2] px-4 py-2 text-[13px] font-semibold text-[#c0392b] hover:bg-[#fef2f0]">
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
                <Stat label="Trade-fee share" value={usdWhole(tradeFeeClaimableUsd)} green sub="Your 5% of your token’s trades" />
                <button onClick={() => void studio.claimTradeFees()} disabled={tradeFeeClaimableUsd <= 0 || studio.isBusy} className="rounded-[11px] bg-[#2f7d4f] px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-[#276b43] disabled:opacity-50">
                  {tradeFeeClaimableUsd <= 0 ? 'Claimed' : 'Claim'}
                </button>
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
                sub={commissionEarnedUsd === null ? 'Not available yet — needs the earnings index' : 'From answered requests'}
              />
            </Card>
            <Card>
              <Stat label="Your own holdings" value={`${tok(held)} tokens`} sub={`worth ${usdPrice(held * market.priceUsd)} · floor ${usdPrice(held * market.floorUsd)}`} />
              <div className="mt-4 flex items-center gap-2">
                <span className="text-[13px] text-[#6b7280]">Cash out</span>
                <input
                  value={sellInput}
                  onChange={(e) => {
                    setSellInput(e.target.value);
                    setSellFailure(null);
                  }}
                  placeholder="tokens"
                  inputMode="decimal"
                  className="w-[110px] rounded-[10px] border border-[#e4e6e9] px-3 py-2 text-[14px] font-semibold tabular-nums outline-none"
                />
                <button
                  onClick={async () => {
                    const n = parseFloat(sellInput.replace(/,/g, ''));
                    if (!Number.isFinite(n) || n <= 0 || studio.isBusy) return;
                    setSellFailure(null);
                    try {
                      await studio.sell(n);
                      setSellInput('');
                    } catch (err) {
                      // The REAL reason, not a guess. See ../write-failure.ts.
                      setSellFailure(writeFailureMessage(err, 'That sell didn’t go through.'));
                    }
                  }}
                  className="rounded-[10px] bg-[#161511] px-4 py-2 text-[13px] font-semibold text-white"
                >
                  Sell
                </button>
              </div>
              {sellFailure ? (
                <div className="mt-2 text-[12px] font-semibold text-[#c0392b]">{sellFailure}</div>
              ) : null}
              <p className="mt-3 text-[12px] leading-[1.5] text-[#9ca3af]">Selling your own tokens returns them to dollars at the market price — it doesn’t affect anyone else’s floor. Never blocked by billing.</p>
            </Card>
          </div>
        ) : null}
      </div>

      {answering ? <AnswerModal ask={answering} studio={studio} onClose={() => setAnswering(null)} /> : null}
      {retireOpen ? <RetireModal handle={studio.creator ?? ''} onConfirm={studio.retire} onClose={() => setRetireOpen(false)} /> : null}
    </TokenShell>
  );
};

export default CreatorStudio;
