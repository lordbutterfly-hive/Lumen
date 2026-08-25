import { NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getChain } from '@transaction/lib/chain';
import { getAccounts, getDynamicGlobalProperties } from '@transaction/lib/hive-api';
import { getWitnessesByVote } from '@transaction/lib/hive';
import { buildWitnessRows } from '@/blog/features/witnesses/lib/build-witness-rows';
import { WITNESS_FETCH_LIMIT } from '@/blog/features/witnesses/lib/constants';

const logger = getLogger('app');

/**
 * ★★★ THE HIGHEST-PRIORITY FIX IN THIS PASS. `features/witnesses/hooks/use-
 * witnesses-data.ts` built the ENTIRE `/witnesses` page client-side —
 * `getDynamicGlobalProperties`, `getWitnessesByVote`, `getAccounts`, and its
 * own `useQuery({queryFn: getChain})` (for `chain.calculateHpApr`/
 * `chain.calculateWitnessVotesHp`, via `buildWitnessRows`) — every one with
 * NO `enabled` guard. `/witnesses` has no sign-in wall at all, so this ran
 * for EVERY visitor, anonymous or signed in, just to view a read-only table.
 *
 * One route instead of four separate ones: `dgp`/`witnesses`/`accounts` feed
 * directly into `buildWitnessRows`, which ALSO needs the live chain instance
 * for `calculateWitnessVotesHp` — splitting those across requests would mean
 * either shipping the chain instance to the browser (impossible, it's a wax
 * object) or re-deriving it from JSON on the client, which is exactly the
 * "reimplement wax's math in JS" risk `/api/vests-to-hp` deliberately avoids.
 * Doing the merge here, where the real chain instance already exists for
 * free, is the same trade.
 *
 * `ownVotes` is passed as an empty set — this route has no signed-in
 * identity to give it (and takes none: the whole point is this data is
 * identical for every visitor). The client hook overlays the VIEWER's own
 * votes (`fetchWitnessVotes`, per-viewer, already its own route) onto
 * `rows[].isVoted` afterwards — a pure, chain-free `Set.has()` check, so it
 * costs nothing to keep that step client-side.
 */
/**
 * ★★★ FROZEN AT BUILD TIME until 2026-08-25 — same defect as
 * `/api/dynamic-global-properties`, see that route's note for the mechanism.
 * The 2026-08-23 build served `last_confirmed_block_num=109,285,066` and vote
 * totals ~41h old; a witness vote cast after the build could never appear.
 *
 * 60s rather than `force-dynamic` because of exactly what the comment above
 * describes: this route is FOUR upstream calls (`getDynamicGlobalProperties`,
 * `getWitnessesByVote(100)`, `getAccounts` over all 100 owners, `getChain`),
 * and `/witnesses` has no sign-in wall, so every anonymous visitor would
 * trigger the set. This route exists to stop that work happening per-VIEWER in
 * the browser; making it per-REQUEST on the server would hand most of the cost
 * straight back. Witness votes move on the scale of minutes at the very
 * fastest, so one refresh a minute is live for every practical purpose.
 *
 * The per-viewer half is unaffected: `isVoted` is overlaid client-side from
 * `fetchWitnessVotes` (its own per-viewer route), so caching this shared
 * payload cannot leak or stale one viewer's votes into another's.
 */
export const revalidate = 60;

export async function GET(): Promise<NextResponse> {
  try {
    const [dgp, witnesses] = await Promise.all([getDynamicGlobalProperties(), getWitnessesByVote(WITNESS_FETCH_LIMIT)]);
    const owners = witnesses.map((w) => w.owner);
    const accountList = owners.length > 0 ? await getAccounts(owners) : [];
    const accounts = new Map(accountList.map((a) => [a.name, a]));
    const chain = await getChain();

    let hpAprPercent: number | null = null;
    try {
      hpAprPercent = chain.calculateHpApr(
        dgp.head_block_number,
        dgp.vesting_reward_percent,
        dgp.virtual_supply,
        dgp.total_vesting_fund_hive
      );
    } catch (error) {
      logger.error(error, 'calculateHpApr failed');
    }

    const rows = buildWitnessRows({ witnesses, accounts, dgp, chain, ownVotes: new Set() });
    // `hpVotes` is a `Big.js` instance — its enumerable fields (`s`/`e`/`c`) are
    // NOT the decimal value, so serializing it as-is would hand the client
    // Big's internal representation instead of a usable number. Sent as a
    // plain string; `fetchWitnessesPage` (`lib/chain-fetch.ts`) rewraps it in
    // `Big(...)` on the way back in, once, so nothing downstream of the hook
    // has to know the wire shape differs from the in-memory one.
    const wireRows = rows.map((row) => ({ ...row, hpVotes: row.hpVotes.toString() }));

    return NextResponse.json(
      {
        rows: wireRows,
        headBlock: dgp.head_block_number,
        hpAprPercent,
        hbdInterestRatePercent: dgp.hbd_interest_rate / 100,
        witnessCount: witnesses.length
      },
      { headers: { 'cache-control': 'private, no-store' } }
    );
  } catch (error) {
    logger.error(error, 'witnesses page data lookup failed');
    return NextResponse.json({ error: 'witnesses_page_unavailable' }, { status: 502 });
  }
}
