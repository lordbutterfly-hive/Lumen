import 'server-only';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import { OP, monthsAgo, walkAccountOps } from './haf';
import type { Bounded, KeRatio } from './types';
import { keBand, nowIso } from './types';

/**
 * ════ THE SIGNALS, BOUNDED — NOT YET WIRED TO A SURFACE ════
 *
 * ★★★ SAY THE QUIET PART: NOTHING RENDERS THIS FILE TODAY. An adversarial review
 * (2026-09-19) found that `record.ts` — the only consumer — pointed at a `refresh.ts`
 * that was never written, so the whole HAF signal path was dead and the constraint
 * "no KE band words on screen" was being met vacuously rather than by design.
 * `record.ts` is deleted; this file is kept, deliberately, for two reasons:
 *
 *   1. The profile Record strip is the next thing to build and this is its data layer.
 *   2. HiveSQL is funded by a DHF proposal, which is not a promise of forever. When it
 *      lapses, HAF is how KE and downvotes-received still get answered — slower and
 *      bounded, but answered.
 *
 * It is not imported by any route or component. If that is still true the next time
 * somebody reads this, delete it rather than leaving a third dead module behind.
 *
 * Downvotes received, distinct downvoters, and the KE ratio. All come off HAF, all are
 * bounded, and every one can come back saying it only counted part of the picture.
 *
 * ★★★ MUTES RECEIVED IS NOT HERE, AND THE REASON IS MEASURED. `loadMutes` below is
 * kept because the parsing is right and the moment a source appears it is two lines to
 * wire, but it returns nothing useful today: HAF's `/accounts/{name}/operations` indexes
 * a `custom_json` against its SENDER, not its target. Asked for @lordbutterfly's
 * custom_jsons over 24 months, 19,333 operations came back and the follow ops among them
 * had the account as neither `follower` nor `following` — so "who mutes X" is simply not
 * in that feed. It needs HiveSQL (DHF-funded, one query, but registration is a human
 * step) or another aggregate. The board says so rather than showing a zero.
 *
 * ★★★ THE CAP IS THE DESIGN, NOT A LIMITATION. @lordbutterfly has 241,248 vote
 * operations. Walking that at render time is how a feature takes a server down, and
 * walking it in a nightly job for every account on Hive is how a feature takes a
 * public API down. So each read has a page cap and a time floor, and when the cap is
 * what stopped it the result says `partial: true`. The UI then shows "at least N",
 * never N — the spec's "receipts or it is cut" rule applied to our own arithmetic.
 */

/** Rolling twelve months, which is what the boards say they cover. */
const WINDOW_MONTHS = 12;
const VOTE_BOUNDS = { maxPages: 8, pageSize: 1000, since: '' };
const MUTE_BOUNDS = { maxPages: 4, pageSize: 1000, since: '' };

interface VoteValue {
  voter?: string;
  author?: string;
  weight?: number;
}

export interface DownvoteSignal {
  downvotes: Bounded;
  voters: Bounded;
  /** The account behind the most downvotes in the window, or null. */
  topSource: string | null;
}

/**
 * Downvotes RECEIVED — `author === account && weight < 0`.
 *
 * ★★ THE SPEC SAID THIS NEEDED AN INDEXER AND IT DOES NOT. See `haf.ts`'s header for
 * the correction and the measurement. `/accounts/{name}/operations?operation-types=0`
 * returns every vote the account is involved in, as voter OR as author, and the body
 * carries all three fields the filter needs.
 *
 * ★ VOTERS, NOT VOLUME, IS THE NUMBER THAT MEANS SOMETHING. 903 downvotes from 12
 * accounts is a dispute; 212 from 29 is a consensus. Both are returned so the board
 * can sort on the honest one, and so a reader can see the pair rather than one figure
 * chosen for them.
 */
async function loadDownvotes(account: string): Promise<DownvoteSignal> {
  const since = monthsAgo(WINDOW_MONTHS);
  const { ops, partial } = await walkAccountOps(account, OP.vote, { ...VOTE_BOUNDS, since });

  const perVoter = new Map<string, number>();
  let downvotes = 0;
  for (const op of ops) {
    const v = op.op?.value as VoteValue | undefined;
    if (!v || v.author !== account) continue;
    if (typeof v.weight !== 'number' || v.weight >= 0) continue;
    downvotes += 1;
    if (v.voter) perVoter.set(v.voter, (perVoter.get(v.voter) ?? 0) + 1);
  }

  let topSource: string | null = null;
  let best = 0;
  for (const [voter, n] of perVoter) {
    if (n > best) {
      best = n;
      topSource = voter;
    }
  }

  const asOf = nowIso();
  return {
    downvotes: { value: downvotes, partial, asOf },
    voters: { value: perVoter.size, partial, asOf },
    topSource
  };
}

interface FollowJson {
  id?: string;
  json?: string;
}

/**
 * Mutes RECEIVED — follow ops naming this account with `what: ['ignore']`.
 *
 * ★★ AN UNMUTE IS AN EMPTY `what`, AND IGNORING IT INFLATES THE COUNT FOREVER. Mute
 * and follow are exclusive toggles on Hive: muting writes `what: ['ignore']`, undoing
 * it writes `what: []` for the same pair. Counting only the first gives a number that
 * can never go down, which is exactly the kind of figure this feature must not
 * produce. The walk keeps the LAST state per muter and counts those still set.
 */
async function loadMutes(account: string): Promise<Bounded> {
  const since = monthsAgo(WINDOW_MONTHS * 4);
  const { ops, partial } = await walkAccountOps(account, OP.customJson, { ...MUTE_BOUNDS, since });

  // Newest first from HAF, so the FIRST state seen per muter is the current one.
  const settled = new Map<string, boolean>();
  for (const op of ops) {
    const v = op.op?.value as FollowJson | undefined;
    if (!v || v.id !== 'follow' || typeof v.json !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(v.json);
    } catch {
      continue;
    }
    // ['follow', { follower, following, what }]
    if (!Array.isArray(parsed) || parsed[0] !== 'follow') continue;
    const body = parsed[1] as { follower?: string; following?: string; what?: unknown } | undefined;
    if (!body || body.following !== account || !body.follower) continue;
    if (settled.has(body.follower)) continue;
    const what = Array.isArray(body.what) ? body.what : [];
    settled.set(body.follower, what.includes('ignore'));
  }

  let mutedBy = 0;
  for (const isMuted of settled.values()) if (isMuted) mutedBy += 1;
  return { value: mutedBy, partial, asOf: nowIso() };
}

/**
 * ★★ HAF RETURNS NAI ASSET OBJECTS, NOT STRINGS, and the difference is a silent zero.
 * `vesting_payout` is `{ nai: '@@000000037', amount: '63024466666', precision: 6 }`.
 * My first version read it with `parseFloat` as if it were `"123.456 VESTS"`, got
 * NaN -> 0 for every row, and produced `KE = 0.00` for two accounts with millions of
 * vests held. Nothing threw. Read `amount` and divide by `10 ** precision`.
 */
interface NaiAsset {
  amount?: string;
  precision?: number;
}

interface AuthorRewardValue {
  author?: string;
  vesting_payout?: NaiAsset;
}

interface CurationRewardValue {
  curator?: string;
  reward?: NaiAsset;
}

const asset = (a: NaiAsset | undefined): number => {
  if (!a || typeof a.amount !== 'string') return 0;
  const n = Number.parseFloat(a.amount);
  if (!Number.isFinite(n)) return 0;
  return n / 10 ** (a.precision ?? 6);
};

/**
 * KE = Σ(author + curation rewards, in VESTS) ÷ VESTS held.
 *
 * ★ THE RATIO IS TAKEN IN VESTS, NOT HP, ON PURPOSE. Both halves are vests, so the
 * HP conversion rate cancels out and the number does not move when the global vesting
 * fund does. Converting each side to HP first would introduce a rate that changes
 * daily into a ratio that is supposed to describe an account's own history.
 *
 * ★★ WHAT THIS NUMBER IS NOT is written in `types.ts` beside `keBand`, where the
 * thresholds live, and it stays in the code: the owner's instruction is that the band
 * words ship bare with no explanation on screen.
 */
async function loadKe(account: string, vestingShares: number): Promise<KeRatio> {
  /*
   * ★★ A PARTIAL KE IS A FLATTERING KE, WHICH IS THE WORST DIRECTION TO BE WRONG IN.
   * The numerator is rewards taken; capping the walk drops the oldest of them and the
   * ratio comes out LOW. Measured: @gtg has 46,789 curation rewards, so a six-page cap
   * read 12% of them and produced a number that made the account look like a purer
   * holder than it is. This is only ever computed in the background refresh, never in
   * a render, so it can afford the pages — and when even 60 is not enough the caller
   * gets `partial: true` and the UI declines to print a figure at all.
   */
  const since = '2016-03-24T00:00:00'; // Steem genesis; rewards predate the Hive fork.
  const bounds = { maxPages: 60, pageSize: 1000, since };

  const [author, curation] = await Promise.all([
    walkAccountOps(account, OP.authorReward, bounds),
    walkAccountOps(account, OP.curationReward, bounds)
  ]);

  /*
   * ★ `curation_reward_operation.author` IS THE POST'S AUTHOR, NOT THE EARNER. The
   * earner is `curator`. Summing without that filter counts curation somebody else
   * earned on this account's posts as this account's reward, which inflates KE for
   * anyone who gets curated — the opposite of what the number is supposed to show.
   */
  let rewardVests = 0;
  for (const op of author.ops) {
    const v = op.op?.value as AuthorRewardValue | undefined;
    if (v?.author !== account) continue;
    rewardVests += asset(v.vesting_payout);
  }
  for (const op of curation.ops) {
    const v = op.op?.value as CurationRewardValue | undefined;
    if (v?.curator !== account) continue;
    rewardVests += asset(v.reward);
  }

  const partial = author.partial || curation.partial;
  const value = vestingShares > 0 ? rewardVests / vestingShares : null;
  return {
    value,
    rewardsHp: rewardVests,
    hpHeld: vestingShares,
    band: keBand(value),
    partial,
    asOf: nowIso()
  };
}

export const downvotesReceived = withTtlCache(loadDownvotes, (a: string) => a, {
  ttlMs: 24 * 60 * 60 * 1000,
  max: 300,
  name: 'inq-downvotes'
});

export const mutesReceived = withTtlCache(loadMutes, (a: string) => a, {
  ttlMs: 24 * 60 * 60 * 1000,
  max: 300,
  name: 'inq-mutes'
});

export const keRatio = withTtlCache(loadKe, (a: string) => a, {
  ttlMs: 24 * 60 * 60 * 1000,
  max: 300,
  name: 'inq-ke'
});
