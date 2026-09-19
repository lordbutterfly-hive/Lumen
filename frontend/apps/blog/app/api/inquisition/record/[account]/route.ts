import { NextResponse } from 'next/server';
import { profileRecord } from '@/blog/lib/inquisition/boards-sql';
import { voteLedger } from '@/blog/lib/inquisition/vote-ledger';
import { steemPostsSinceFork } from '@/blog/lib/inquisition/crossposting';
import { hiveSqlConfigured } from '@/blog/lib/inquisition/hivesql';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';

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
 * ★ 264ms measured, cached a day. A record is a slow-moving thing: mutes and listings
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
     * ★★ THE LISTINGS COME FROM THE SAME INDEX THE BOARD READS, not from SQL — see
     * `profileRecord`. `marksFor` is served from the shared blacklist cache, so this is
     * a map lookup on all but the first call of the day and adds nothing to the 264ms.
     * If the index is unreachable the strip shows the rest of the record rather than
     * failing whole: a missing listing is shown as none-known, never as a clean record.
     */
    /*
     * ★★ THE LISTINGS ARE GONE FROM THE RECORD (owner, 2026-09-19: "remove the
     * blacklists from mode and bar. it wont work, we add that later"). The bridge
     * fallback, the publisher table and the LISTED cell all came out together rather
     * than being left wired up and hidden, so nothing here calls a blacklist publisher
     * any more.
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
      return NextResponse.json({ account, unavailable: true }, { headers: { 'cache-control': 'no-store' } });
    }
    return NextResponse.json(
      {
        ...record,
        // ★ `publishers` is gone with the blacklist board; nothing renders it.
        publishers: undefined,
        removedUsd: ledger ? ledger.removedUsd : null,
        topDownvoters: ledger?.topDownvoters ?? [],
        topPosts: ledger?.topPosts ?? [],
        selfRewardUsd: ledger ? ledger.selfRewardUsd : null,
        selfRewardPct: ledger ? ledger.selfRewardPct : null,
        steemPosts: steem ? steem.posts : null,
        steemLastPost: steem?.lastPost ?? null
      },
      { headers: { 'cache-control': 'private, max-age=300' } }
    );
  } catch {
    return NextResponse.json({ account, unavailable: true }, { headers: { 'cache-control': 'no-store' } });
  }
}
