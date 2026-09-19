'use client';

import { useEffect, useState } from 'react';
import { cn } from '@ui/lib/utils';
import { watchArm } from '@/blog/lib/inquisition/arm';

/**
 * ════ THE RECORD ════
 *
 * ★★★ LUMEN'S TOKENS, NOT THE MOCK'S HEX (owner, 2026-09-19: "i told you not to use
 * their fonts anywhere. you used them. I told you not to use their colors anywhere, you
 * used them"). Every colour below is a Lumen token that already flips with the theme:
 *
 *     their #4ec780  ->  text-ink-ok-2     (identical in dark; Lumen already had it)
 *     their #c89b4a  ->  text-ink-brand-6  (our accent, not their brass)
 *     their #f2f4f6  ->  text-ink-2
 *     their #8a929c  ->  text-ink-14
 *     their #aeb4bc  ->  text-ink-10
 *     their #e8b33a  ->  text-ink-warn-3
 *     their #3a3226  ->  border-line-brand-10
 *     their #2a2e34  ->  border-line-9
 *
 * Not one raw hex remains, so this panel is themed by the same ramp as the other 58
 * routes and cannot drift from them.
 *
 * ★★ SIX FIGURES, AND THE PANEL IS SHORT. It was "far bigger then it needs to be": the
 * cells were 15px with a 58px reserved paragraph slot, on a card that already carries the
 * identity. LISTED is gone entirely (blacklists come out of the mode for now), the type
 * is down a step, and the explanation slot is one tight line plus one sentence.
 *
 * ★★ ONE SENTENCE EACH, AND THE TOP THREE WHERE THEY EARN THEIR PLACE. Downvotes and
 * value removed both name the three accounts responsible, because "990 downvotes" with
 * nobody attached is the pillory the spec warns about, while "990, mostly from these
 * three" is a fact a reader can go and check.
 *
 * ★ NOTHING HERE IS CLICKABLE. No `<a>`, no `<button>`, no `onClick`. Hover and focus
 * reveal text and change no state anywhere else.
 */

export interface RecordData {
  account: string;
  mutedBy: number;
  muterMvests: number;
  ke: number | null;
  band: string;
  rewardsHive: number;
  hp: number;
  downvotes: number;
  downvoters: number;
  lastDownvote: string | null;
  removedUsd: number | null;
  topDownvoters: { account: string; usd: number }[];
  topPosts: { permlink: string; usd: number }[];
  selfRewardUsd: number | null;
  selfRewardPct: number | null;
  steemPosts: number | null;
  steemLastPost: string | null;
  accountAgeDays: number;
  asOf: string;
  unavailable?: boolean;
  unconfigured?: boolean;
}

type Tone = 'ok' | 'plain' | 'warn' | 'accent' | 'dim';

interface Cell {
  label: string;
  value: string;
  exact: string;
  tone: Tone;
  body: string;
}

const TONE: Record<Tone, string> = {
  ok: 'text-ink-ok-2',
  plain: 'text-ink-2',
  warn: 'text-ink-warn-3',
  accent: 'text-ink-brand-6',
  dim: 'text-ink-14'
};

const ago = (iso: string | null): string => {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 31) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

const usd = (n: number): string =>
  '$' + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 });

const three = (list: { account: string; usd: number }[]): string =>
  list.map((t) => `@${t.account} ${usd(t.usd)}`).join(', ');

function cellsFor(r: RecordData): Cell[] {
  return [
    {
      label: 'DOWNVOTES RECEIVED',
      value: r.downvotes.toLocaleString(),
      exact:
        r.topDownvoters.length > 0
          ? `from ${r.downvoters.toLocaleString()} accounts · most: ${three(r.topDownvoters)}`
          : `from ${r.downvoters.toLocaleString()} accounts · last ${ago(r.lastDownvote)}`,
      tone: r.downvoters >= 25 ? 'warn' : 'plain',
      body: `Downvotes received over the account's whole history, from ${r.downvoters.toLocaleString()} distinct accounts, the last one ${ago(r.lastDownvote)}.`
    },
    {
      label: 'REMOVED',
      value: r.removedUsd === null ? '—' : usd(r.removedUsd),
      exact:
        r.removedUsd === null
          ? 'not computed'
          : r.topDownvoters.length > 0
            ? `whole history · most: ${three(r.topDownvoters)}`
            : 'whole history',
      tone: r.removedUsd === null ? 'dim' : r.removedUsd >= 100 ? 'accent' : 'plain',
      body:
        r.removedUsd === null
          ? 'Not computed for this account, which is not the same as nothing having been taken.'
          : "What those downvotes took off this account's payouts across its whole history, each post valued at its own payout rate on the day it paid."
    },
    {
      label: 'MUTED BY',
      value: r.mutedBy.toLocaleString(),
      exact: `${r.mutedBy.toLocaleString()} accounts · ${r.muterMvests.toFixed(1)}M HP between them`,
      tone: r.mutedBy >= 50 ? 'warn' : 'plain',
      body: 'A mute is free, personal and one-sided, so the stake behind the muters says more than the count does.'
    },
    {
      label: 'STEEM',
      value: r.steemPosts === null ? '—' : r.steemPosts.toLocaleString(),
      exact:
        r.steemPosts === null
          ? 'not read'
          : r.steemLastPost
            ? `last one ${r.steemLastPost.slice(0, 10)} · ${ago(r.steemLastPost)}`
            : 'none since 2020-09-20',
      tone: r.steemPosts === null ? 'dim' : r.steemPosts > 0 ? 'warn' : 'ok',
      body: 'Posts published to Steem since six months after the fork, asked of Steem itself; the migration window is excluded because posting there then was rarely a choice.'
    },
    {
      label: 'KE RATIO',
      value: r.ke === null ? '—' : r.ke.toFixed(1),
      exact: r.ke === null ? 'no stake held' : `${r.ke.toFixed(2)} · ${r.band}`,
      tone: r.ke === null ? 'dim' : r.ke >= 10 ? 'accent' : r.ke >= 3 ? 'warn' : 'ok',
      body: `${r.rewardsHive.toLocaleString()} HIVE taken against ${r.hp.toLocaleString()} HP held: evidence of cash-out behaviour, never of abuse.`
    },
    {
      label: 'SELF-REWARD',
      value: r.selfRewardPct === null ? '—' : `${r.selfRewardPct.toFixed(1)}%`,
      exact:
        r.selfRewardUsd === null
          ? 'not computed'
          : `${usd(r.selfRewardUsd)} of every reward this account's posts have paid`,
      tone: r.selfRewardPct === null ? 'dim' : r.selfRewardPct >= 25 ? 'warn' : 'ok',
      body: "The share of this account's post rewards that came from its own votes, counted in money rather than in votes so it does not flatter whales."
    }
  ];
}

export default function RecordPanel({ account }: { account: string }) {
  const [armed, setArmed] = useState(false);
  const [record, setRecord] = useState<RecordData | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [hover, setHover] = useState(-1);

  useEffect(() => watchArm(setArmed), []);

  useEffect(() => {
    if (!armed || !account) return;
    let cancelled = false;
    setState('loading');
    const ask = (attempt: number): void => {
      fetch(`/api/inquisition/record/${encodeURIComponent(account)}`)
        .then((r) => {
          // ★ A 429 is "slow down", not "no record": this route is rate-limited and its
          // 429 body is plain text, which an unguarded r.json() would have thrown on.
          if (r.status === 429 && attempt === 0) {
            const after = Number(r.headers.get('retry-after'));
            const waitMs = Math.min((Number.isFinite(after) && after > 0 ? after : 5) * 1000, 30000);
            setTimeout(() => {
              if (!cancelled) ask(1);
            }, waitMs);
            throw new Error('retrying');
          }
          if (!r.ok) throw new Error(`record ${r.status}`);
          return r.json();
        })
        .then((json: RecordData) => {
          if (cancelled) return;
          if (json.unavailable || json.unconfigured || typeof json.asOf !== 'string') {
            setState('failed');
            return;
          }
          setRecord(json);
          setState('idle');
        })
        .catch((error: Error) => {
          if (!cancelled && error?.message !== 'retrying') setState('failed');
        });
    };
    ask(0);
    return () => {
      cancelled = true;
    };
  }, [armed, account]);

  if (!armed) return null;

  const cells = record ? cellsFor(record) : [];
  const open = hover >= 0 && hover < cells.length ? cells[hover] : null;

  return (
    <div
      data-testid="inquisition-record"
      className="mt-3 w-full min-w-0 rounded-control border border-line-brand-10 bg-[var(--amb-1)] px-4 py-2.5"
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="font-num text-[9.5px] uppercase tracking-[0.14em] text-ink-brand-6">The record</span>
        <span className="font-num text-[9px] tracking-[0.06em] text-ink-14">{record ? 'hover any figure' : ''}</span>
      </div>

      {state === 'failed' ? (
        <p className="py-0.5 font-num text-[11px] text-ink-14">
          The record could not be read. Nothing is implied about this account.
        </p>
      ) : !record ? (
        <p className="py-0.5 font-num text-[11px] text-ink-14">Reading the chain&hellip;</p>
      ) : (
        <>
          <div className="grid grid-cols-3 items-end gap-x-3 gap-y-2 sm:grid-cols-6">
            {cells.map((c, i) => (
              <div
                key={c.label}
                tabIndex={0}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(-1)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(-1)}
                className="min-w-0 cursor-help rounded-sm outline-none"
              >
                {/* ★ NOT `truncate`. "DOWNVOTES RECEIVED" is the longest label and the
                    only one that overflowed its column, so it read "DOWNVOTES RECEI…"
                    permanently. It wraps to two lines instead; the row has the height. */}
                <div
                  className={cn(
                    'font-num text-[8.5px] uppercase leading-[11px] tracking-[0.06em] transition-colors',
                    hover === i ? 'text-ink-brand-6' : 'text-ink-14'
                  )}
                  title={c.label}
                >
                  {c.label}
                </div>
                <div
                  className={cn(
                    'mt-px border-b pb-0.5 font-num text-[13px] leading-[18px] tabular-nums transition-colors',
                    TONE[c.tone],
                    hover === i ? 'border-b-line-brand-10' : 'border-b-transparent'
                  )}
                >
                  {c.value}
                </div>
              </div>
            ))}
          </div>

          {/* ★ A RESERVED SLOT, so the card does not jump by a paragraph's height every
              time the pointer crosses a figure and moves the number you were reaching for. */}
          <div className="mt-2 min-h-[34px] border-t border-line-9 pt-1.5">
            {open ? (
              <>
                <p className="truncate font-num text-[10px] tracking-[0.02em] text-ink-brand-6" title={open.exact}>
                  {open.exact}
                </p>
                <p className="mt-0.5 font-ui text-[11.5px] leading-[16px] text-ink-10">{open.body}</p>
              </>
            ) : (
              <p className="font-num text-[9.5px] tracking-[0.04em] text-ink-14">
                indexed {record.asOf.slice(0, 16).replace('T', ' ')} UTC &middot; account{' '}
                {Math.floor(record.accountAgeDays / 365)}y old
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
