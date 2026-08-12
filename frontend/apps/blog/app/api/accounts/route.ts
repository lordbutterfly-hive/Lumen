import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getAccounts } from '@transaction/lib/hive-api';

const logger = getLogger('app');

const MAX_BATCH = 100;

/**
 * ★ Same rule as `/api/account`, batched. `use-witnesses-data.ts`'s
 * `accountsQuery` called `getAccounts` directly to resolve witness owner
 * profiles on the (unauthenticated) `/witnesses` page.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const raw = req.nextUrl.searchParams.get('usernames') ?? '';
  const usernames = raw
    .split(',')
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);
  if (usernames.length === 0) {
    return NextResponse.json({ error: 'usernames_required' }, { status: 400 });
  }
  // A caller-controlled batch size must not turn into an unbounded upstream request.
  if (usernames.length > MAX_BATCH) {
    return NextResponse.json({ error: 'too_many_usernames' }, { status: 400 });
  }
  try {
    const accounts = await getAccounts(usernames);
    return NextResponse.json(accounts, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'accounts batch lookup failed for %d usernames', usernames.length);
    return NextResponse.json({ error: 'accounts_unavailable' }, { status: 502 });
  }
}
