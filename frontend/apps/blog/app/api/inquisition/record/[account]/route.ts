import { NextResponse } from 'next/server';
import { marksFor } from '@/blog/lib/inquisition/blacklists';
import { profileRecord } from '@/blog/lib/inquisition/boards-sql';
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
    const [record, listing] = await Promise.all([
      cached(account),
      marksFor(account).catch(() => ({ marks: [], missing: ['all'] }))
    ]);
    if (!record) {
      return NextResponse.json({ account, unavailable: true }, { headers: { 'cache-control': 'no-store' } });
    }
    const publishers = [...new Set(listing.marks.map((m) => m.publisher))];
    return NextResponse.json(
      {
        ...record,
        publishers,
        // ★ An incomplete read is reported, never rendered as a clean record.
        listsIncomplete: listing.missing.length > 0
      },
      { headers: { 'cache-control': 'private, max-age=300' } }
    );
  } catch {
    return NextResponse.json({ account, unavailable: true }, { headers: { 'cache-control': 'no-store' } });
  }
}
