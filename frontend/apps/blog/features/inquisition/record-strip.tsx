'use client';

import { useEffect, useState } from 'react';
import { watchArm } from '@/blog/lib/inquisition/arm';

/**
 * ════ THE RECORD STRIP ════
 *
 * ★★★ NOTHING HERE IS CLICKABLE, AND THAT IS THE INSTRUCTION (owner, 2026-09-19: "why
 * is there a inquisition profile pill? its supposed to just carry the data its not a
 * clickable pill. you can hover over it but its not clickable").
 *
 * So there is no `<a>`, no `<button>`, no `onClick`, no `role`, nothing focusable. Each
 * cell is a `<div>` with a `title`. It states a number and, on hover, says what the
 * number is. It offers no destination and takes no action — which also means it cannot
 * become a route into judging somebody, because there is nowhere for it to go.
 *
 * ★★ IT ONLY EXISTS WHILE THE MODE IS ARMED, AND IT COSTS AN UNARMED READER NOTHING.
 * The fetch is inside the armed branch, so a profile viewed normally issues no extra
 * request and renders exactly as it did before this feature. Disarming removes the
 * strip on the spot.
 *
 * ★ A MISSING NUMBER IS SHOWN AS MISSING. The downvote count is not here at all —
 * 20.4s per account is not something a profile may wait for, and a figure we cannot
 * fetch in time is not a figure we print. Everything shown carries its own index time.
 */

interface Record {
  account: string;
  mutedBy: number;
  publishers: string[];
  ke: number | null;
  band: string;
  rewardsHive: number;
  hp: number;
  asOf: string;
  listsIncomplete?: boolean;
  unavailable?: boolean;
  unconfigured?: boolean;
}

const num = (n: number) => n.toLocaleString();

export default function RecordStrip({ account }: { account: string }) {
  const [armed, setArmed] = useState(false);
  const [record, setRecord] = useState<Record | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');

  useEffect(() => watchArm(setArmed), []);

  useEffect(() => {
    if (!armed || !account) return;
    let cancelled = false;
    setState('loading');
    fetch(`/api/inquisition/record/${encodeURIComponent(account)}`)
      .then((r) => r.json())
      .then((json: Record) => {
        if (cancelled) return;
        if (json.unavailable || json.unconfigured) {
          setState('failed');
          return;
        }
        /*
         * ★ THE SHAPE IS CHECKED BEFORE IT IS TRUSTED. The route's 400 body is
         * `{error: 'bad account'}` — neither failure flag is set — and rendering it
         * threw on `record.asOf.slice()`, which the profile's error boundary would have
         * swallowed into a blank card. The board learned this lesson already; the strip
         * had not.
         */
        if (typeof json.asOf !== 'string') {
          setState('failed');
          return;
        }
        setRecord(json);
        setState('idle');
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [armed, account]);

  if (!armed) return null;

  return (
    <div className="mt-5" data-testid="inquisition-record">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-ui text-caption uppercase tracking-label text-ink-14">The record</span>
        {record ? (
          <span className="font-ui text-caption text-ink-14">
            indexed {record.asOf.slice(0, 16).replace('T', ' ')} UTC
          </span>
        ) : null}
      </div>

      {state === 'failed' ? (
        <p className="rounded-panel border border-line-9 bg-surface-1 px-5 py-4 font-ui text-[14px] text-ink-10">
          The record could not be read. Nothing is implied about this account.
        </p>
      ) : !record ? (
        <p className="rounded-panel border border-line-9 bg-surface-1 px-5 py-4 font-ui text-[14px] text-ink-10">
          Reading the chain&hellip;
        </p>
      ) : (
        /* ★ PER-CELL BORDERS, NOT A CONTAINER BACKGROUND (spec §4), so a row that ends
           short cannot paint a bare slab across the page. */
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Cell
            label="KE"
            value={record.ke === null ? '—' : record.ke.toFixed(2)}
            note={record.band}
            hint="Lifetime rewards taken divided by Hive Power held"
          />
          <Cell
            label="Rewards"
            value={num(record.rewardsHive)}
            note="HIVE"
            hint="Author and curation rewards over the account's whole life"
          />
          <Cell
            label="Muted by"
            value={num(record.mutedBy)}
            note={record.mutedBy === 1 ? 'account' : 'accounts'}
            hint="Accounts that have muted this one. A mute is personal and free"
          />
          {/*
            ★★★ "NONE" IS A CLAIM, AND WE ONLY MAKE IT WHEN WE READ EVERY LIST. If any
            publisher's list could not be read, this says so instead — because the
            alternative is printing a clean record for a named human being on the
            strength of a request that failed. See `marksFor`.
          */}
          <Cell
            label="Lists"
            value={
              record.publishers.length > 0
                ? String(record.publishers.length)
                : record.listsIncomplete
                  ? '—'
                  : 'None'
            }
            note={
              record.publishers.length > 0
                ? record.publishers.map((p) => `@${p}`).join(', ')
                : record.listsIncomplete
                  ? 'lists unread'
                  : ''
            }
            hint={
              record.listsIncomplete
                ? 'At least one publisher list could not be read, so this is not a clean record — it is no record'
                : 'Published blacklists this account appears on, and who publishes them'
            }
            warn={record.publishers.length > 0}
          />
        </div>
      )}
    </div>
  );
}

/**
 * ★ A `<div>` WITH A `title`. Not a link, not a button, nothing focusable — see the
 * header. `title` is the hover the owner asked for and the only explanation that
 * reaches the screen.
 */
function Cell({
  label,
  value,
  note,
  hint,
  warn
}: {
  label: string;
  value: string;
  note?: string;
  hint: string;
  warn?: boolean;
}) {
  return (
    <div title={hint} className="rounded-control border border-line-9 bg-surface-1 px-4 py-3">
      <div className="font-ui text-caption uppercase tracking-label text-ink-14">{label}</div>
      <div
        className={`mt-0.5 font-num text-[19px] leading-[26px] tabular-nums ${
          warn ? 'text-ink-brand-6' : 'text-ink-2'
        }`}
      >
        {value}
      </div>
      {note ? <div className="mt-0.5 truncate font-ui text-caption text-ink-10">{note}</div> : null}
    </div>
  );
}
