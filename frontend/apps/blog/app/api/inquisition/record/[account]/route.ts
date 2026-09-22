import { NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { profileRecord, type ProfileRecord } from '@/blog/lib/inquisition/boards-sql';
import { fillInBackground, isFilling } from '@/blog/lib/inquisition/record';
import { hiveSqlConfigured } from '@/blog/lib/inquisition/hivesql';
import { readRecord, recordStale, writeRecord } from '@/blog/lib/inquisition/board-store';

const logger = getLogger('app');

export const dynamic = 'force-dynamic';

/**
 * ════ ONE ACCOUNT'S RECORD, FOR THE PROFILE STRIP ════
 *
 * ★★★ SERVED FROM DISK, AND THE ONE PERSON WHO EVER WAITS IS WHOEVER ARRIVES BEFORE THE
 * FIRST BUILD (owner, 2026-09-20: "make sure the warming of data on profile pages is
 * near instant. I dont want to wait for it to lead 20 seconds like reputation does").
 *
 * The figures are expensive and no amount of tuning changes that: the deduplicated
 * downvote tally is 4.9s for @lighteye and 23.2s for @haejin, the vote ledger is 12.1s
 * on a modest account and up to `PER_ACCOUNT_MS` on a large one, and the Steem walk is
 * up to six requests to somebody else's node. Twenty seconds is a fair description of
 * what an armed profile used to cost.
 *
 * Three things fix it, and none of them is a faster query:
 *
 *   1. THE RESULT GOES ON DISK, so it is computed once for everybody rather than once
 *      per worker. It used to be a `withTtlCache`, which is per process: three workers
 *      meant three computations of the same profile, and every deploy threw all three
 *      away. A file is shared and survives a restart.
 *   2. THE ANSWER COMES IN TWO HALVES. The cheap half (KE, stake, mute count, account
 *      age) is about a second, and it is returned immediately with `building: true`
 *      while the expensive half is computed behind the reader. The strip already
 *      renders a dash for anything it does not have, so it fills in rather than
 *      blocking on the slowest figure.
 *   3. THE ACCOUNTS PEOPLE ACTUALLY OPEN ARE WARMED WEEKLY, off the five boards, so the
 *      common case never even hits the two-halves path. See `warmRecords`.
 *
 * ★★ AND IT REFRESHES ONCE A WEEK, matching the boards. A record is a slow-moving
 * thing: mutes and downvotes accumulate on a human timescale, KE moves with lifetime
 * totals. Re-deriving it more often would cost the database a great deal to produce a
 * figure nobody could tell apart from last week's.
 */

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
    const stored = readRecord<ProfileRecord>(account);

    /*
     * ★★★ THE WHOLE POINT: a stored record is served without touching HiveSQL at all.
     * This is the path essentially every reader takes, and it is a file read.
     *
     * A stale record is served too, and refreshed behind the response. Last week's mute
     * count is not meaningfully different from today's, and stale-while-revalidate is
     * the difference between a strip that appears and a strip that spins.
     */
    if (stored?.complete) {
      if (recordStale(stored)) fillInBackground(account, stored.record, true);
      // ★ `building` is true while a refill is in flight (2026-09-22). A partial record
      // used to answer `building: false` the instant its refill was kicked off, so the
      // nightly warm counted it built, moved on, and started the next one; a dozen
      // fills then shared two slow-lane slots and every one of them timed out again,
      // which is how 102 records stayed partial night after night. The strip already
      // re-asks while building; the warm script waits for it.
      const filling = isFilling(account);
      return NextResponse.json(
        { ...stored.record, building: filling },
        { headers: { 'cache-control': filling ? 'no-store' : 'private, max-age=300' } }
      );
    }

    // ★ A first build already running in another worker: its cheap half is on disk.
    // Recomputing it here would only overwrite that file, possibly after the finished
    // record had landed on top of it.
    if (stored && isFilling(account)) {
      return NextResponse.json({ ...stored.record, building: true }, { headers: { 'cache-control': 'no-store' } });
    }

    // Nothing usable on disk. Pay for the cheap half only, and hand it over now.
    const base = await profileRecord(account);
    if (!base) {
      logger.warn(`inquisition: no record for @${account} — the vests rate or the reader query did not answer`);
      return NextResponse.json({ account, unavailable: true }, { headers: { 'cache-control': 'no-store' } });
    }

    // ★ Store the half we have, so a restart mid-fill does not start from nothing, and
    // mark it incomplete so nothing mistakes it for the finished article.
    writeRecord(account, base, false);
    fillInBackground(account, base);

    return NextResponse.json(
      // ★ `building: true` is what tells the strip to come back. Everything the slow
      // half owns is absent rather than zero, and the strip renders absent as a dash.
      { ...base, building: true },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    logger.error(error, `inquisition: record request failed for @${account}`);
    return NextResponse.json({ account, unavailable: true }, { headers: { 'cache-control': 'no-store' } });
  }
}
