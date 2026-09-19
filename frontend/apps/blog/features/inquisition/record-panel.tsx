'use client';

import { useEffect, useState } from 'react';
import { cn } from '@ui/lib/utils';
import { watchArm } from '@/blog/lib/inquisition/arm';

/**
 * ════ THE RECORD ════
 *
 * ★★★ THIS IS THE MOCK'S PANEL, NOT MY SUMMARY OF IT (owner, 2026-09-19: "go back to
 * exactly what claude design made. enumerate everythign every stat, all text").
 *
 * What I shipped first was four cells in a card BELOW the profile card, with no hover
 * text and no source lines. The design has SEVEN figures — DOWNVOTES, REMOVED, MUTED BY,
 * STEEM, KE RATIO, SELF-VOTE, LISTED — in one inset strip INSIDE the identity card,
 * beside the stats, with `hover any figure` stated on it so a reader knows the
 * explanations exist. Hovering a figure brasses its label, underlines it, and opens a
 * paragraph saying what the number is, what it is not, and where it came from.
 *
 * ★★ THE HOVER IS THE POINT, AND IT WAS MISSING (owner: "you cant hover over to see what
 * it is who muted me"). Every one of these numbers is contestable, and a bare integer
 * next to a person's name with no explanation is exactly the pillory the spec spends a
 * page warning against. The body text below each figure is the product; the integer is
 * the headline.
 *
 * ★ NOTHING HERE IS CLICKABLE. Still true, still structural: no `<a>`, no `<button>`, no
 * `onClick`. `onMouseEnter`/`onFocus` reveal text and change no state anywhere else.
 * Keyboard readers get the same panel via focus, which the `title`-only version could
 * never offer.
 */

export interface RecordData {
  account: string;
  mutedBy: number;
  muterMvests: number;
  publishers: string[];
  ke: number | null;
  band: string;
  rewardsHive: number;
  hp: number;
  downvotes: number;
  downvoters: number;
  lastDownvote: string | null;
  removedUsd: number | null;
  selfVotePct: number | null;
  steemPosts: number | null;
  accountAgeDays: number;
  asOf: string;
  listsIncomplete?: boolean;
  unavailable?: boolean;
  unconfigured?: boolean;
}

type Tone = 'ok' | 'muted' | 'warn' | 'bad' | 'dim';

interface Cell {
  label: string;
  value: string;
  exact: string;
  tone: Tone;
  body: string;
  src: string;
}

const TONE: Record<Tone, string> = {
  ok: 'text-[#4ec780]',
  muted: 'text-[#f2f4f6]',
  warn: 'text-[#e8b33a]',
  bad: 'text-[#e8553a]',
  dim: 'text-[#8a929c]'
};

const ago = (iso: string | null): string => {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 31) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

const money = (n: number): string =>
  (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

/** The seven figures, in the mock's order, with the mock's own explanations. */
function cellsFor(r: RecordData): Cell[] {
  const listed = r.publishers.length;
  return [
    {
      label: 'DOWNVOTES',
      value: r.downvotes.toLocaleString(),
      exact: `${r.downvotes.toLocaleString()} · from ${r.downvoters.toLocaleString()} accounts`,
      tone: r.downvoters >= 25 ? 'warn' : 'muted',
      body: `Downvotes received over the account's whole history, from ${r.downvoters.toLocaleString()} distinct accounts. Last one ${ago(r.lastDownvote)}. Distinct voters matter more than the total — many downvotes from few accounts is a dispute, not a consensus.`,
      src: 'TxVotes where weight < 0, grouped by author'
    },
    {
      label: 'REMOVED',
      value: r.removedUsd === null ? '—' : money(-r.removedUsd),
      exact: r.removedUsd === null ? 'not computed' : `${money(-r.removedUsd)} over the last 3 months`,
      tone: r.removedUsd === null ? 'dim' : r.removedUsd >= 100 ? 'bad' : 'muted',
      body:
        r.removedUsd === null
          ? 'Not computed for this account. The figure is a sum over every post the account published, so it runs against a time budget and a dash here means the budget was spent — never that nothing was taken.'
          : "The USD those downvotes took off this account's payouts, measured as the payout lost on each post and converted at today's reward rate. The only figure here denominated in money, and the one people actually argue about.",
      src: 'Comments: vote_rshares − net_rshares × reward rate'
    },
    {
      label: 'MUTED BY',
      value: r.mutedBy.toLocaleString(),
      exact: `${r.mutedBy.toLocaleString()} · ${r.muterMvests.toFixed(1)}M HP between them`,
      tone: r.mutedBy >= 50 ? 'warn' : 'muted',
      body: `Accounts that have muted this one, holding ${r.muterMvests.toFixed(1)}M HP between them. A mute is personal, free and one-sided — it hides an account from one reader and costs nothing to cast — so the stake behind it says more than the count.`,
      src: 'HiveSQL Mutes(muter, muted)'
    },
    {
      label: 'STEEM',
      value: r.steemPosts === null ? '—' : r.steemPosts.toLocaleString(),
      exact: r.steemPosts === null ? 'not read' : `${r.steemPosts.toLocaleString()} since 2020-03-20`,
      tone: r.steemPosts === null ? 'dim' : r.steemPosts > 0 ? 'warn' : 'ok',
      body:
        'Posts published to the Steem chain after the Hive hardfork, asked of Steem’s own API rather than Hive’s. Reshares are excluded, so this is what the account published under its own name. Zero is the number everyone claims and nobody checks.',
      src: 'steem condenser_api.get_discussions_by_blog'
    },
    {
      label: 'KE RATIO',
      value: r.ke === null ? '—' : r.ke.toFixed(1),
      exact: r.ke === null ? 'no stake held' : `${r.ke.toFixed(2)} · ${r.band}`,
      tone: r.ke === null ? 'dim' : r.ke >= 10 ? 'bad' : r.ke >= 3 ? 'warn' : 'ok',
      body: `${r.rewardsHive.toLocaleString()} HIVE of rewards taken ÷ ${r.hp.toLocaleString()} HP held. Evidence of cash-out behaviour, never of abuse — someone living on their payouts and a reward-pool farm read as the same number, and it must never drive an automatic action.`,
      src: 'Accounts: posting + curation rewards ÷ vesting_shares'
    },
    {
      label: 'SELF-VOTE',
      value: '—',
      exact: 'not computed',
      tone: 'dim',
      /*
       * ★★★ THIS ONE IS DELIBERATELY BLANK, AND SAYING SO IS THE HONEST ANSWER.
       * The design wants the share of rewards that came from the account's OWN votes,
       * denominated in value. That needs each vote's rshares, and `TxVotes` carries only
       * the vote percentage — no rshares column exists. The cheap substitute (payout on
       * posts the author happened to self-vote) measures something else entirely and
       * returns ~99% for almost everybody: measured on @lordbutterfly, $19,720 of
       * $19,879. A figure that says the same thing about everyone is not a figure, and
       * printing it under this label would be a lie with a percent sign on it.
       */
      body: 'Not computed. This is the share of rewards that came from the account’s own votes, measured in value — and that needs each vote’s rshares, which the vote table does not carry. Counting votes instead would flatter whales and punish small accounts, so it is left blank rather than filled with the wrong measurement.',
      src: 'needs per-vote rshares — not available from HiveSQL'
    },
    {
      label: 'LISTED',
      value: r.listsIncomplete ? '—' : listed === 0 ? 'None' : String(listed),
      exact: r.listsIncomplete
        ? 'lists unread'
        : listed === 0
          ? 'on 0 published lists'
          : r.publishers.map((p) => `@${p}`).join(', '),
      tone: r.listsIncomplete ? 'dim' : listed === 0 ? 'ok' : 'bad',
      body: r.listsIncomplete
        ? 'At least one publisher’s list could not be read, so this is not a clean record — it is no record. Nothing is implied about the account.'
        : listed === 0
          ? 'On no published blacklist — not HiveWatchers, Spaminator, Steemcleaners or buildawhale. A listing attaches information to a name and warns on transfers; it does not mute anyone.'
          : `Listed by ${r.publishers.map((p) => `@${p}`).join(', ')}. Each publisher has its own scope and its own appeal route, which is why they are never merged into one verdict.`,
      src: 'bridge.get_follow_list · blacklisted + muted'
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
          // ★ A 429 is "slow down", not "no record" — the route is rate-limited and its
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
      className="mt-4 w-full min-w-0 rounded-[10px] border border-[#3a3226] bg-[rgba(14,15,17,.72)] px-4 py-3"
    >
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <span className="font-num text-[10px] uppercase tracking-[1.4px] text-[#c89b4a]">
          &#9906; The record
        </span>
        <span className="font-num text-[9.5px] tracking-[0.6px] text-[#6f757e]">
          {record ? 'hover any figure' : ''}
        </span>
      </div>

      {state === 'failed' ? (
        <p className="py-1 font-num text-[11.5px] text-[#8a929c]">
          The record could not be read. Nothing is implied about this account.
        </p>
      ) : !record ? (
        <p className="py-1 font-num text-[11.5px] text-[#8a929c]">Reading the chain&hellip;</p>
      ) : (
        <>
          {/*
            ★ SEVEN ACROSS, ONE ROW, LIKE THE MOCK. `flex-wrap` with a 20px gap dropped
            LISTED onto a second line and turned a compact dossier strip into a block. A
            seven-column grid keeps the shape at every width the card can take, and the
            columns size themselves to the widest value rather than to a guess.
          */}
          <div className="grid grid-cols-7 gap-x-2">
            {cells.map((c, i) => (
              <div
                key={c.label}
                tabIndex={0}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(-1)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(-1)}
                className="min-w-0 cursor-help rounded-sm outline-none focus-visible:bg-[rgba(200,155,74,.08)]"
              >
                <div
                  className={cn(
                    'font-num text-[9.5px] uppercase tracking-[0.9px] transition-colors',
                    hover === i ? 'text-[#c89b4a]' : 'text-[#6f757e]'
                  )}
                >
                  {c.label}
                </div>
                <div
                  className={cn(
                    'mt-0.5 border-b-[1.5px] pb-0.5 font-num text-[15px] leading-[20px] tabular-nums transition-colors',
                    TONE[c.tone],
                    hover === i ? 'border-b-[#c89b4a]' : 'border-b-transparent'
                  )}
                >
                  {c.value}
                </div>
              </div>
            ))}
          </div>

          {/*
            ★ THE EXPLANATION HAS A RESERVED SLOT. Rendering it only on hover made the
            card jump by the height of a paragraph every time the pointer crossed a
            figure, which moves the very number you were reaching for.
          */}
          <div className="mt-3 min-h-[58px] border-t border-[#2a2e34] pt-2.5">
            {open ? (
              <>
                <p className="font-num text-[10.5px] tracking-[0.3px] text-[#c89b4a]">{open.exact}</p>
                <p className="mt-1 break-words font-ui text-[12px] leading-[17px] text-[#aeb4bc]">{open.body}</p>
                <p className="mt-1 font-num text-[9.5px] tracking-[0.4px] text-[#6f757e]">{open.src}</p>
              </>
            ) : (
              <p className="font-num text-[10px] tracking-[0.4px] text-[#6f757e]">
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
