'use client';

import { useEffect, useState } from 'react';
import { cn } from '@ui/lib/utils';
import { watchArm } from '@/blog/lib/inquisition/arm';
import { KE_BAND_TONE, TONE_TEXT_CLASS, type KeBand } from '@/blog/lib/inquisition/types';

/**
 * ════ THE RECORD ════
 *
 * ★★★ TYPE SIZES COME FROM LUMEN'S SCALE, AND I HAD ANSWERED "the fonts are too small"
 * BY MAKING THEM SMALLER. `tailwind.config.js` states the rule outright: `caption:
 * ['14px','20px'] // was 13 - the floor. Nothing lowercase goes below this.` This panel
 * shipped lowercase prose at 11.5px and labels at 8.5px, which is not a compactness
 * trade-off, it is below the floor the design system sets. Lowercase text is now
 * `text-caption` or larger. The only things allowed under it are the ALL-CAPS tracked
 * labels, which the scale does not govern.
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
  mutedBy: number | null;
  muterMvests: number | null;
  /** The three muters with the most stake, largest first. Absent on records built before 2026-09-22. */
  topMuters?: { account: string; hp: number }[];
  mutedByPartial?: boolean;
  /** True while the route is still computing the expensive half. */
  building?: boolean;
  ke: number | null;
  band: KeBand;
  rewardsHive: number;
  hp: number;
  downvotes: number | null;
  downvoters: number;
  lastDownvote: string | null;
  removedUsd: number | null;
  /** The figure is a minimum: part of the sum did not finish, or it was carried from an earlier build. */
  removedUsdFloor?: boolean;
  topDownvoters: { account: string; usd: number }[];
  topByCount: { account: string; votes: number }[];
  selfRewardUsd: number | null;
  selfRewardPct: number | null;
  /** The other direction: what this account cast, and what its downvotes took. */
  castVotes: number | null;
  castTargets: number;
  lastCast: string | null;
  removedFromOthersUsd: number | null;
  /** Same as `removedUsdFloor`, for what this account's downvotes took. */
  removedFromOthersFloor?: boolean;
  steemPosts: number | null;
  steemPartial: boolean;
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

const TONE: Record<Tone, string> = TONE_TEXT_CLASS;

const ago = (iso: string | null): string => {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 31) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

/**
 * ★ HBD, NOT USD. `total_payout_value` is HBD-denominated and the reward rate is
 * documented as HBD per rshare. HBD is soft-pegged to the dollar so the figures are
 * close, but the label has to say what the number is.
 *
 * ★ AND NO "$" IN FRONT OF IT (2026-09-22). The cells printed "$404" under a label reading
 * "REWARDS LOST (HBD)", which states two units for one number. Under a label that names
 * the unit the cell is the bare figure; in running text, where nothing else names it,
 * the figure carries "HBD".
 */
const hbdFigure = (n: number): string =>
  Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 });
const hbd = (n: number): string => `${hbdFigure(n)} HBD`;

/*
 * ★ A SMALL SHARE IS NOT ZERO (2026-09-22). One decimal printed @antisocialist's 0.046%
 * self-reward as a green "0.0%", which reads as "never voted for itself". Below 1% the
 * share keeps two decimals, and a share too small for those says so.
 */
const sharePct = (p: number): string =>
  p === 0 ? '0%' : p < 0.005 ? '<0.01%' : p < 1 ? `${p.toFixed(2)}%` : `${p.toFixed(1)}%`;

/** The three who took the most MONEY. Belongs under the money cell and nowhere else. */
const threeByValue = (list: { account: string; usd: number }[]): string =>
  list.map((t) => `@${t.account} ${hbd(t.usd)}`).join(', ');

const hpCompact = (hp: number): string =>
  hp >= 1_000_000 ? `${(hp / 1_000_000).toFixed(1)}M HP` : hp >= 1_000 ? `${Math.round(hp / 1_000)}k HP` : `${Math.round(hp)} HP`;

const threeByStake = (list: { account: string; hp: number }[]): string =>
  list.map((t) => `@${t.account} ${hpCompact(t.hp)}`).join(', ');

/*
 * ★★★ THE THREE WHO DOWNVOTED MOST OFTEN, WHICH IS NOT THE SAME LIST (owner, 2026-09-20:
 * "on downvotes received youre showing downvote value instead of downvote amount ... the
 * downvote amount on bar should show number of downvotes and who downvoted them most").
 *
 * `topByCount` was computed by the vote ledger, shipped over the wire, declared on the
 * type — and read by nothing. Both cells printed `topDownvoters`, which is ordered by HBD,
 * so the COUNT cell answered its own question in dollars: "981 downvotes, most: @innerhive
 * $112". One whale who downvoted twice outranked a bot that downvoted two hundred times.
 */
const threeByCount = (list: { account: string; votes: number }[]): string =>
  list.map((t) => `@${t.account} ${t.votes.toLocaleString()}`).join(', ');

function cellsFor(r: RecordData): Cell[] {
  return [
    {
      label: 'DOWNVOTES RECEIVED',
      /* ★ A dash when the count did not finish. It is the one figure on this strip
         expensive enough to time out on its own (23.2s for @haejin), and it now runs as
         its own query so the rest of the record survives it. */
      value: r.downvotes === null ? '—' : r.downvotes.toLocaleString(),
      exact:
        r.downvotes === null
          ? `not counted · ${r.downvoters.toLocaleString()} accounts have downvoted this one`
          : r.topByCount.length > 0
            ? `from ${r.downvoters.toLocaleString()} accounts · most often: ${threeByCount(r.topByCount)}`
            : `from ${r.downvoters.toLocaleString()} accounts · last ${ago(r.lastDownvote)}`,
      tone: r.downvotes === null ? 'dim' : r.downvoters >= 25 ? 'warn' : 'plain',
      body: `How many downvotes this account received over its whole history, counted as distinct posts (a downvote later withdrawn still counts, the same way the boards count) — the count, not what they cost it — from ${r.downvoters.toLocaleString()} distinct accounts, the last one ${ago(r.lastDownvote)}. The three named on hover are the ones who cast the most of them.`
    },
    {
      label: 'REWARDS LOST (HBD)',
      // ★ "+" = a minimum (2026-09-23, owner: "the max you extracted with a + that's the
      // max limit"): the whole-history sum is too big to finish in one query, so it is
      // summed in slices and a slice that did not answer leaves a floor.
      value: r.removedUsd === null ? '—' : `${hbdFigure(r.removedUsd)}${r.removedUsdFloor ? '+' : ''}`,
      exact:
        r.removedUsd === null
          ? 'not computed'
          : r.removedUsdFloor
            ? `at least ${hbd(r.removedUsd)} · the full sum is too big to finish`
          : r.topDownvoters.length > 0
            ? `whole history · most taken by: ${threeByValue(r.topDownvoters)}`
            : 'whole history',
      tone: r.removedUsd === null ? 'dim' : r.removedUsd >= 100 ? 'accent' : 'plain',
      body:
        r.removedUsd === null
          ? 'Not computed for this account, which is not the same as nothing having been taken.'
          : "What those downvotes took off this account's payouts across its whole history, in HBD as the chain declared it. Exact where the post still paid; modelled only where it was flattened to nothing."
    },
    {
      label: 'MUTED BY',
      /*
       * ★★ THIS FIGURE NOW COMES FROM THE CHAIN AND CAN BE `null`, WHICH IS A DASH.
       * It used to be a plain `number` read out of HiveSQL's `Mutes` table, which
       * answers "who mutes X" with between 1% and 69% of the truth — @berniesanders
       * rendered a confident 0 against a chain that says 638. A dash that says "not
       * read" on hover is the honest version of a number we could not get.
       */
      value:
        r.mutedBy === null ? '—' : `${r.mutedBy.toLocaleString()}${r.mutedByPartial ? '+' : ''}`,
      exact:
        r.mutedBy === null
          ? 'not read'
          : r.mutedByPartial
            ? `at least ${r.mutedBy.toLocaleString()} accounts · the walk stopped at its page limit`
            : r.muterMvests === null
              ? `${r.mutedBy.toLocaleString()} accounts`
              : r.topMuters && r.topMuters.length > 0
                ? `${r.mutedBy.toLocaleString()} accounts · ${r.muterMvests.toFixed(1)}M HP between them · most stake: ${threeByStake(r.topMuters)}`
                : `${r.mutedBy.toLocaleString()} accounts · ${r.muterMvests.toFixed(1)}M HP between them`,
      tone: r.mutedBy === null ? 'dim' : r.mutedBy >= 50 ? 'warn' : 'plain',
      body: 'A mute is free, personal and one-sided, so the stake behind the muters says more than the count does.'
    },
    {
      label: 'CROSSPOSTING',
      /*
       * ★★ THE `+` IS NOT DECORATION — IT IS THE DIFFERENCE BETWEEN A COUNT AND A FLOOR.
       * The Steem walk is capped at `MAX_PROFILE_PAGES` pages and sets `partial` when it
       * hits that cap, and this cell printed the number bare regardless: a floor rendered
       * as a total, indistinguishable from a complete count. The flag was computed, sent
       * over the wire and declared on the type, and then read by nothing. The board beside
       * it got this right; two surfaces of one feature disagreeing is the feature lying on
       * one of them.
       */
      value:
        r.steemPosts === null
          ? '—'
          : `${r.steemPosts.toLocaleString()}${r.steemPartial ? '+' : ''}`,
      exact:
        r.steemPosts === null
          ? 'not read'
          : r.steemPartial
            ? `at least ${r.steemPosts.toLocaleString()} · the walk stopped at its page limit`
            : r.steemLastPost
              ? `last one ${r.steemLastPost.slice(0, 10)} · ${ago(r.steemLastPost)}`
              : 'none since 2020-09-20',
      tone: r.steemPosts === null ? 'dim' : r.steemPosts > 0 ? 'warn' : 'ok',
      body: r.steemPartial
        ? 'Letters home to the old country since six months after the schism, as the old country itself keeps them; the first six months are forgiven, because writing there then was rarely a choice. This account writes home often enough that the count stopped at its page limit, so the real figure is higher.'
        : 'Letters home to the old country since six months after the schism, as the old country itself keeps them; the first six months are forgiven, because writing there then was rarely a choice.'
    },
    {
      label: 'KE RATIO',
      value: r.ke === null ? '—' : r.ke.toFixed(1),
      exact: r.ke === null ? 'no stake held' : `${r.ke.toFixed(2)} · ${r.band}`,
      tone: KE_BAND_TONE[r.band] ?? 'dim',
      body: `${r.rewardsHive.toLocaleString()} HIVE taken against ${r.hp.toLocaleString()} HP held: evidence of cash-out behaviour, never of abuse.`
    },
    {
      label: 'SELF-REWARD',
      value: r.selfRewardPct === null ? '—' : sharePct(r.selfRewardPct),
      exact:
        r.selfRewardUsd === null
          ? 'not computed'
          : `${hbd(r.selfRewardUsd)} of all the rewards this account's posts have paid`,
      tone: r.selfRewardPct === null ? 'dim' : r.selfRewardPct >= 25 ? 'warn' : 'ok',
      body: "The share of this account's post rewards that came from its own votes, counted in money rather than in votes so it does not flatter whales."
    },
    /*
     * ★★★ THE LAST TWO ARE THE OTHER SIDE OF THE SAME LEDGER (owner, 2026-09-20: "add the
     * inquisitor data in the bar as two last numbers ... how many downvotes you cast and
     * how much post rewards you removed"). Six figures about what was done TO an account
     * and nothing about what it did is a record that can only ever read as innocence.
     *
     * The labels are deliberately the mirror image of the first two: RECEIVED/LOST is what
     * happened to this account, CAST/REMOVED is what it did to others. "Removed" was the
     * old label for the money it LOST, which is exactly the confusion to avoid, so that
     * one is now "rewards lost".
     */
    {
      label: 'DOWNVOTES CAST',
      value: r.castVotes === null ? '—' : r.castVotes.toLocaleString(),
      exact:
        r.castVotes === null
          ? 'not counted'
          : r.castVotes === 0
            ? 'never downvoted anybody'
            : `on ${r.castTargets.toLocaleString()} accounts · last ${ago(r.lastCast)}`,
      tone: r.castVotes === null ? 'dim' : r.castVotes >= 100 ? 'warn' : 'plain',
      body:
        r.castVotes === null
          ? 'Not counted for this account, which is not the same as none having been cast.'
          : `Downvotes this account has cast over its whole history, counted the same way as the ones it received: distinct posts, not vote operations. ${r.castVotes === 0 ? 'It has never downvoted anybody.' : `Spread across ${r.castTargets.toLocaleString()} accounts, the last one ${ago(r.lastCast)}.`}`
    },
    {
      label: 'REWARDS REMOVED (HBD)',
      value:
        r.removedFromOthersUsd === null
          ? '—'
          : `${hbdFigure(r.removedFromOthersUsd)}${r.removedFromOthersFloor ? '+' : ''}`,
      exact:
        r.removedFromOthersUsd === null
          ? 'not computed'
          : r.removedFromOthersFloor
            ? `at least ${hbd(r.removedFromOthersUsd)} · the full sum is too big to finish`
          : r.removedFromOthersUsd === 0
            ? 'took nothing off anybody'
            : 'whole history · taken off other accounts',
      tone:
        r.removedFromOthersUsd === null ? 'dim' : r.removedFromOthersUsd >= 100 ? 'accent' : 'plain',
      body:
        r.removedFromOthersUsd === null
          ? 'Not computed for this account, which is not the same as nothing having been taken.'
          : "What this account's own downvotes took off other people's payouts, in HBD, across its whole history — valued exactly as the money it lost is, so the two numbers can be read against each other."
    }
  ];
}

/*
 * How many times the strip will come back for the slow half before giving up. With the
 * widening interval below this covers a little over two minutes, which is longer than
 * any record measured; past that, the dashes are the honest answer.
 */
const MAX_FILL_POLLS = 12;

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
          /*
           * ★★★ THE CHEAP HALF DOES NOT CARRY EVERY KEY, AND THE CELLS TEST FOR `null`
           * (2026-09-20). `profileRecord` returns the six figures it can get in a second;
           * `topDownvoters`, `topByCount`, the self-reward pair, the Steem trio and now the
           * cast pair are added by the slow half, so on a genuinely cold profile the first
           * response has them ABSENT rather than null. `r.selfRewardPct === null` is false
           * for `undefined`, and the next line calls `.toFixed()` on it, which throws
           * inside the render rather than printing a dash.
           *
           * Normalising here, once, is the fix: every cell already knows how to render
           * `null` and an empty list. It is done on the way in, not in eight cells.
           */
          setRecord({
            ...json,
            topDownvoters: json.topDownvoters ?? [],
            topByCount: json.topByCount ?? [],
            selfRewardUsd: json.selfRewardUsd ?? null,
            selfRewardPct: json.selfRewardPct ?? null,
            castVotes: json.castVotes ?? null,
            castTargets: json.castTargets ?? 0,
            lastCast: json.lastCast ?? null,
            removedFromOthersUsd: json.removedFromOthersUsd ?? null,
            steemPosts: json.steemPosts ?? null,
            steemPartial: json.steemPartial ?? false,
            steemLastPost: json.steemLastPost ?? null
          });
          setState('idle');
          /*
           * ★★★ COME BACK FOR THE SLOW HALF. The route answers immediately with the
           * figures that cost one indexed lookup and sets `building` while the
           * expensive ones (the deduplicated downvote tally at up to 23s, the vote
           * ledger, the Steem walk) are computed behind the response. Without this the
           * strip would show its dashes and never fill them, which is a worse lie than
           * the wait it replaced: a dash means "not computed", not "not computed yet,
           * and nobody is coming".
           *
           * ★ The interval widens as it goes. A cold record is usually ready inside
           * half a minute, but @haejin's tally alone is 23s and a large ledger is
           * longer, so a fixed 2s poll would ask thirty times for one answer.
           */
          if (json.building && attempt < MAX_FILL_POLLS) {
            const waitMs = Math.min(2000 * Math.pow(1.5, attempt), 15000);
            setTimeout(() => {
              if (!cancelled) ask(attempt + 1);
            }, waitMs);
          }
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
        <span className="font-num text-[11px] uppercase tracking-[0.14em] text-ink-brand-6">The record</span>
        <span className="font-num text-[11px] tracking-[0.06em] text-ink-14">{record ? 'hover any figure' : ''}</span>
      </div>

      {state === 'failed' ? (
        <p className="py-0.5 font-num text-caption text-ink-14">
          The record could not be read. Nothing is implied about this account.
        </p>
      ) : !record ? (
        <p className="py-0.5 font-num text-caption text-ink-14">Reading the chain&hellip;</p>
      ) : (
        <>
          <div className="grid grid-cols-2 items-end gap-x-3 gap-y-2 sm:grid-cols-4">
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
                    'font-num text-[10px] uppercase leading-[13px] tracking-[0.06em] transition-colors',
                    hover === i ? 'text-ink-brand-6' : 'text-ink-14'
                  )}
                  title={c.label}
                >
                  {c.label}
                </div>
                <div
                  className={cn(
                    'mt-px border-b pb-0.5 font-num text-[17px] leading-[24px] tabular-nums transition-colors',
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
          <div className="mt-2.5 min-h-[46px] border-t border-line-9 pt-2">
            {open ? (
              <>
                {/* ★ WRAPS, NEVER TRUNCATES (2026-09-22). This line carries the named accounts,
                    and `truncate` cut the third muter and the third downvoter at desktop width
                    and five of eight lines on a phone: the names are the point of the line. */}
                <p className="break-words font-num text-caption tracking-[0.01em] text-ink-brand-6">
                  {open.exact}
                </p>
                <p className="mt-1 font-ui text-caption leading-[20px] text-ink-10">{open.body}</p>
              </>
            ) : (
              <p className="font-num text-caption tracking-[0.02em] text-ink-14">
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
