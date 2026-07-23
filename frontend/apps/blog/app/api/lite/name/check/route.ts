import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { checkNameAvailability } from '@/blog/lib/lite/names/vetting';

const logger = getLogger('app');

/**
 * GET /api/lite/name/check?name=<name> — read-only availability check for live
 * UX feedback (format + reserved + on-chain existence). Does not reserve.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const name = req.nextUrl.searchParams.get('name');
  if (!name) {
    return NextResponse.json({ error: 'name_required' }, { status: 400 });
  }
  try {
    const result = await checkNameAvailability(name);
    return NextResponse.json(result);
  } catch (error) {
    logger.error(error, 'Lite name check failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
