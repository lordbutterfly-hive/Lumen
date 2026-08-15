'use client';

import { FC } from 'react';

/**
 * THE RAIL LEDGER — "the tabs that fill up".
 *
 * ★★★ EVERY ROW IS BUILT FROM FLOW STATE, NEVER FROM A PER-STEP ARRAY.
 * The caller derives these rows from what the reader has actually typed
 * (`build-ledger.ts`), and a row whose value is not known yet renders as a
 * dash rather than as a number. A ledger that shows a price the reader never
 * entered is a lie in the UI, and this is the one panel on the screen whose
 * whole job is to be believed.
 *
 * This file is markup only: it does not know what a step is.
 */

export interface MeritumLedgerRow {
  /** Stable React key. Not shown. */
  id: string;
  /** The small caps label on the left. Already translated. */
  label: string;
  /** The value on the right, or null while it is genuinely not known. */
  value: string | null;
  /** Renders the value in the brand ink. Used for Lumen's cut, nothing else. */
  brand?: boolean;
}

export interface MeritumRailLedgerProps {
  rows: MeritumLedgerRow[];
  /** What an unfilled row shows. Translated by the caller. */
  emptyLabel: string;
}

const MeritumRailLedger: FC<MeritumRailLedgerProps> = ({ rows, emptyLabel }) => (
  /* The 1px gap over a line-coloured background IS the row divider — one
     element per rule, and no border to double up at the ends. */
  <dl className="flex w-full flex-col gap-px bg-meritum-line-card">
    {rows.map((row) => (
      <div key={row.id} className="flex items-baseline justify-between gap-3.5 bg-meritum-rail px-0.5 py-2.5">
        {/*
          ★ LABELS ARE READ, SO THEY GET A READABLE TOKEN (2026-08-15, pill audit).
          This was `text-meritum-ink-faint` (#9ca3af), measured at **2.37:1** on
          the #f6f7f8 rail — barely half the 4.5:1 WCAG AA floor for normal text.
          `ink-faint` is for decoration (the tape's separator glyph); a field
          label naming what the value means is content. `ink-3` (#4b5563) is
          ~7.1:1 on the same ground and still reads as secondary.
        */}
        <dt className="text-12 font-bold uppercase tracking-[0.1em] text-meritum-ink-3">{row.label}</dt>
        <dd
          className={`truncate font-serif text-15 font-semibold tabular-nums ${
            row.value === null ? 'text-meritum-ink-faint' : row.brand ? 'text-meritum-ink-brand' : 'text-meritum-ink'
          }`}
        >
          {row.value ?? emptyLabel}
        </dd>
      </div>
    ))}
  </dl>
);

export default MeritumRailLedger;
