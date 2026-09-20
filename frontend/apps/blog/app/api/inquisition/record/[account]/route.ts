import { NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { profileRecord } from '@/blog/lib/inquisition/boards-sql';
import { voteLedger } from '@/blog/lib/inquisition/vote-ledger';
import { steemPostsSinceFork } from '@/blog/lib/inquisition/crossposting';
import { hiveSqlConfigured } from '@/blog/lib/inquisition/hivesql';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';

const logger = getLogger('app');

export const dynamic = 'force-dynamic';

/**
 * ════ ONE ACCOUNT'S RECORD, FOR THE PROFILE STRIP ════
 *
 * ★★ THE PROFILE ITSELF NEVER WAITS FOR THIS. The strip fetches it client-side, only
 * when the mode is armed, so an unarmed reader's profile does exactly the work it did
 * before this feature existed — no extra query, no extra byte, no slower render. That
 * is the "don't break the server" requirement expressed as a call graph rather than a
 * promise.
 *
 * ★ 5-12s on a cold account, cached a day — it was 264ms until the downvote count was
 * deduplicated, and 264ms of a wrong number is worth less than 12s of a right one. The
 * ledger beside it already takes 12.1s, so this changes nothing a reader can feel.
 * A record is a slow-moving thing: mutes and listings
 * change on a human timescale and KE moves with lifetime totals.
 */
const cached = withTtlCache(
  (account: string) => profileRecord(account),
  (account: string) => account,
  {
    ttlMs: 24 * 60 * 60 * 1000,
    max: 300,
    name: 'inq-profile-record',
    // ★ `null` is "we could not ask", and caching it would turn one bad minute into a
    // day of a profile claiming it has no record. See hivesql.ts.
    shouldCache: (value) => value !== null
  }
);

export async function GET(
  _request: Request,
  { params }: { params: { account: string } }
): Promise<NextResponse> {
  const account = (params.account || '').replace(/^@/, '').toLowerCase();
  // Hive account names: 3-16 chars, lowercase, digits, dot and dash. Anything else is
  // not a name and never reaches the database.
  if (!/^[a-z0-9.-]{3,16}$/.test(account)) {
    return NextResponse.json({ error: 'bad account' }, { status: 400 });
  }
  if (!hiveSqlConfigured()) {
    return NextResponse.json({ account, unconfigured: true }, { headers: { 'cache-control': 'no-store' } });
  }
  try {
    /*
     * ★★ NO LISTINGS HERE AT ALL (owner: "remove the blacklists from mode and bar. it
     * wont work, we add that later"). The bridge reader, the publisher table and the
     * LISTED cell came out together rather than being left wired up and hidden, so
     * nothing on this path calls a blacklist publisher.
     */
    const [record, ledger, steem] = await Promise.all([
      cached(account),
      // ★ The vote ledger is the expensive half — 12.1s for 883 posts — and it is
      // allowed to fail without taking the record with it. A dash reads as "not
      // computed" and says so on hover; it never reads as zero.
      voteLedger(account).catch(() => null),
      steemPostsSinceFork(account).catch(() => null)
    ]);
    if (!record) {
      /*
       * ★★ SAY SO. "The record could not be read" was reaching the screen with nothing
       * written anywhere, which is the same silent-failure shape the boards had: the
       * only way to find out why was to reproduce it by hand. `profileRecord` returns
       * null when the chain rate is unreadable or the reader-lane query timed out, and
       * those are very different problems.
       */
      logger.warn(`inquisition: no record for @${account} — the vests rate or the reader query did not answer`);
      return NextResponse.json({ account, unavailable: true }, { headers: { 'cache-control': 'no-store' } });
    }
    return NextResponse.json(
      {
        ...record,
        // ★ `publishers` is gone with the blacklist board; nothing renders it.
        publishers: undefined,
        removedUsd: ledger ? ledger.removedUsd : null,
        topDownvoters: ledger?.topDownvoters ?? [],
        topByCount: ledger?.topByCount ?? [],
        selfRewardUsd: ledger ? ledger.selfRewardUsd : null,
        selfRewardPct: ledger ? ledger.selfRewardPct : null,
        steemPosts: steem ? steem.posts : null,
        // ★ The walk's own saturation flag. Dropping it printed a floor as a total.
        steemPartial: steem?.partial ?? false,
        steemLastPost: steem?.lastPost ?? null
      },
      { headers: { 'cache-control': 'private, max-age=300' } }
    );
  } catch (error) {
    logger.error(error, `inquisition: record request failed for @${account}`);
    return NextResponse.json({ account, unavailable: true }, { headers: { 'cache-control': 'no-store' } });
  }
}
