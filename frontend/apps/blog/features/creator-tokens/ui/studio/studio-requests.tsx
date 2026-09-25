'use client';

import { FC, useMemo, useRef, useState } from 'react';
import { cn } from '@ui/lib/utils';
import { Link } from '@hive/ui';
import { displayHandle, dueLabelFor } from '../../live/adapt';
import type { LiveStudio } from '../../live/use-live-studio';
// The buyer's own message for an ask, stored off-chain beside the escrow it
// belongs to (the contract carries a 64-byte reference, never the brief).
import { useAskNotes } from '../../live/use-ask-notes';
import type { Ask } from '../../types';
import { ratingStars, usdWhole } from '../../market/format';
import ModalShell from '../modal-shell';
import { writeFailureMessage } from '../write-failure';
import { MAX_HASH_LEN, hashFieldProblem } from '../../lib/vsc/payload-contract';
import { Card, tok } from './studio-card';

const AnswerModal: FC<{ ask: Ask; studio: LiveStudio; note: string | null; noteUnavailable: boolean; onClose: () => void }> = ({
  ask,
  studio,
  note,
  noteUnavailable,
  onClose
}) => {
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
    <ModalShell width={500} onClose={onClose} title="Deliver and get paid" className="p-6">
      {/* ★ AN X, AND A SENTENCE THAT SAYS CLOSING IS FINE (2026-09-21, owner's QA
          list 4.1/4.2). ModalShell deliberately draws no close control, so this
          dialog offered exactly two ways out, "Decline" and "Mark as delivered",
          and a creator who only wanted to read the request had to pick one or
          find the Escape key. Now it closes like every other dialog here, and
          says that nothing is lost by doing so. */}
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="font-ui text-xl font-medium text-ink-2">Deliver and get paid</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          data-testid="answer-modal-close"
          className="-my-1 -mr-2 rounded-lg px-3 py-1 text-[22px] leading-[30px] text-ink-14 hover:bg-surface-16"
        >
          ×
        </button>
      </div>
      <div className="mb-3 rounded-control border border-line-9 bg-surface-16 px-3.5 py-3 text-caption text-ink-8 font-ui">
        {/* ★ MESSAGE THE BUYER, FROM THE ORDER (owner, 2026-09-25: "when making a
            request and writing something to the person they can't respond because
            Inbox is completely separate from the actual request"). Opens the inbox
            on the conversation with whoever placed this order: the existing thread,
            or compose to them when there is none. `ask.asker` goes as-is, a Hive
            buyer as `hive:<name>` and a wallet buyer as `did:pkh:…`, which the
            inbox resolves to the Lumen account holding that wallet. Same pill as the
            header's "Launch your token", one size down to sit in this caption box. */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            From <strong>@{displayHandle(ask.asker)}</strong> · reference <span className="font-mono">{ask.contentHash || '—'}</span>
          </div>
          <Link
            href={`/inbox?to=${encodeURIComponent(ask.asker)}`}
            className="-my-1 shrink-0 whitespace-nowrap rounded-full border border-line-brand-10 bg-surface-1 px-3 py-[3px] font-ui text-caption font-medium text-ink-brand-6 transition-colors hover:bg-surface-brand-12 hover:text-ink-27"
            data-testid="answer-modal-message"
          >
            Message
          </Link>
        </div>
        {/* The buyer's message, filed on Lumen behind the same reference the chain
            holds (use-ask-notes). Absent and unavailable are different answers. */}
        {note ? (
          <p className="mt-1.5 whitespace-pre-wrap text-ink-2" data-testid="answer-modal-note">{note}</p>
        ) : (
          <p className="mt-1.5 text-ink-14">{noteUnavailable ? 'Their message couldn’t be loaded just now.' : 'No message was attached.'}</p>
        )}
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
      {/* ★ THERE IS NO ACCEPT STEP, AND THE COPY MUST NOT INVENT ONE (owner's QA
          list 5.1). The contract has exactly three ends for a request: Answer,
          which pays the creator and is the delivery; Decline, which refunds; and
          the deadline, after which the buyer reclaims and a miss is recorded.
          "Mark this job delivered" read as "accept the job", and a creator who
          pressed it on receipt was paid for work not yet done, with the buyer's
          rating as the only remedy. */}
      <p className="mb-2 text-caption text-ink-10 font-ui">
        There is nothing to accept. Arrange and deliver the work with @{displayHandle(ask.asker)} however you normally would;
        this request stays in your inbox until its deadline, so you can close this and come back to it.
      </p>
      <p className="mb-3 text-caption font-medium text-ink-7 font-ui">
        Press the button below only once the work has actually reached them. It releases the escrow to you and closes the job;
        the buyer then rates it, which is what your token’s reputation is built from.
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
          {busy ? 'Confirm in your wallet…' : 'I’ve delivered this, release payment'}
        </button>
      </div>
      {failure ? (
        <div className="mt-3 text-center text-caption font-medium text-ink-brand-6 font-ui">{failure}</div>
      ) : null}
    </ModalShell>
  );
};

/**
 * A creator's incoming requests: the ones waiting on them, the ones past their deadline,
 * and the delivered jobs with each buyer's rating, with the "Deliver and get paid" dialog
 * that answers or declines one.
 *
 * ★ ONE LIST, TWO PLACES (2026-09-25, owner: "The asks should show up in the inbox as
 * well", and of the Studio's copy: "both stay"). Moved out of creator-studio.tsx unchanged
 * so the Studio's Inbox → Requests and the inbox's Asks tab render the same component from
 * the same `useLiveStudio`, and answering from either is the same write.
 */
const StudioRequests: FC<{ studio: LiveStudio }> = ({ studio }) => {
  const { inbox, rawInbox, expiredInbox, inboxUnavailable, inboxTruncated, inboxOlderNotScanned } = studio;
  // The buyers' messages for every pending request, one request for the whole
  // inbox (use-ask-notes), keyed by the escrows' content references.
  const pendingHashes = useMemo(() => rawInbox.map((a) => a.contentHash).filter((h) => h.length > 0), [rawInbox]);
  const askNotes = useAskNotes(studio.creatorAccount ?? '', pendingHashes, !!studio.creatorAccount && pendingHashes.length > 0);
  // Delivered jobs, newest first, with each buyer's rating (indexer history, not
  // the chain inbox scan, which stops at PENDING).
  const delivered = useMemo(() => studio.askHistory.filter((r) => r.status === 'answered'), [studio.askHistory]);
  const serviceTitle = (offeringId: number): string =>
    studio.offerings?.find((o) => o.offeringId === offeringId)?.title ?? (offeringId === 0 ? 'Service' : `Service #${offeringId}`);
  const [answering, setAnswering] = useState<Ask | null>(null);

  return (
    <>
      <div className="flex flex-col gap-2.5" data-testid="studio-requests">
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
        <>
        <p className="text-caption text-ink-14 font-ui">
          Requests wait here until their deadline. Nothing has to happen right away: open one, or come back later.
        </p>
        {inbox.map((a, i) => (
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
              {usdWhole(a.costUsd)} · {tok(a.tokens)} tokens escrowed · from <span className="font-ui">@{displayHandle(rawInbox[i].asker)}</span>
            </div>
            {/* The buyer's message, beside the escrow it came with (owner's QA
                list 2.1/3.3): "No message" and "couldn't load" are different. */}
            {askNotes.notes.get(rawInbox[i].contentHash)?.text ? (
              <p className="mt-2 whitespace-pre-wrap text-[14px] leading-[22px] text-ink-2 font-ui" data-testid="inbox-note">
                {askNotes.notes.get(rawInbox[i].contentHash)?.text}
              </p>
            ) : (
              <p className="mt-2 text-caption text-ink-14 font-ui">
                {askNotes.isLoading ? 'Loading their message…' : askNotes.unavailable ? 'Their message couldn’t be loaded just now.' : 'No message was attached.'}
              </p>
            )}
            <div className="mt-3">
              <button
                onClick={() => setAnswering(rawInbox[i])}
                className="rounded-control bg-surface-brand-12 px-4 py-2 text-caption font-medium text-ink-27 font-ui hover:bg-surface-brand-17"
              >
                Open request
              </button>
            </div>
          </Card>
        ))}
        </>
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

      {/* ★ DELIVERED JOBS, WITH THE BUYER'S NAME BESIDE THE RATING (owner's QA
          list 8.6). The delivery record on the overview is a count; this is
          the record itself, one row per job, read from the indexer's history. */}
      {studio.askHistoryUnavailable && !studio.askHistoryLoading ? (
        <p className="mt-1.5 text-caption text-ink-14 font-ui">Your delivered jobs couldn’t be loaded just now.</p>
      ) : delivered.length > 0 ? (
        <div className="mt-1.5 flex flex-col gap-2.5" data-testid="studio-delivered">
          <div className="text-label font-medium uppercase tracking-wide text-ink-14 font-ui">Delivered</div>
          {delivered.map((r) => (
            <Card key={`${r.seq}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="text-[15px] leading-[24px] font-medium text-ink-2 font-ui">{serviceTitle(r.offeringId)}</div>
                <div className="text-caption text-ink-14 font-ui">
                  {r.askedTs ? new Date(r.askedTs.endsWith('Z') ? r.askedTs : `${r.askedTs}Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null}
                </div>
              </div>
              <div className="mt-1 text-caption tabular-nums text-ink-10 font-num">
                {tok(r.creditsSpent)} tokens · for <span className="font-ui">@{displayHandle(r.asker)}</span>
              </div>
              <div className="mt-1.5 text-caption font-ui" data-testid="studio-delivered-rating">
                {r.rating ? (
                  <span className="text-ink-2">
                    <span className="text-ink-warn-3">{ratingStars(r.rating)}</span> {r.rating}/5 by @{displayHandle(r.asker)}
                  </span>
                ) : (
                  <span className="text-ink-14">Not rated yet by @{displayHandle(r.asker)}</span>
                )}
              </div>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
      {answering ? (
        <AnswerModal
          ask={answering}
          studio={studio}
          note={askNotes.notes.get(answering.contentHash)?.text ?? null}
          noteUnavailable={askNotes.unavailable}
          onClose={() => setAnswering(null)}
        />
      ) : null}
    </>
  );
};

export default StudioRequests;
