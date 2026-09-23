import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { CACHE_DIR } from '@/blog/lib/inquisition/board-store';

export const dynamic = 'force-dynamic';

/**
 * ════ HOW FAR THE WARM HAS GOT ════
 *
 * Owner, 2026-09-23: "i have no way to check how far along the warm we are". The warm
 * script (/opt/lumen/warm-inquisition.sh) rewrites `warm-status.json` after every record;
 * this adds the share done, the rate so far and when it should finish at that rate.
 * Counts and one account name, nothing else, so it is safe to leave public.
 */
export async function GET(_request: Request): Promise<NextResponse> {
  const headers = { 'cache-control': 'no-store' };
  let status: Record<string, unknown>;
  try {
    status = JSON.parse(readFileSync(join(CACHE_DIR, 'warm-status.json'), 'utf8'));
  } catch {
    return NextResponse.json({ state: 'no warm pass has reported yet' }, { status: 404, headers });
  }
  const built = Number(status.built) || 0;
  const failed = Number(status.failed) || 0;
  const due = Number(status.due) || 0;
  const done = built + failed;
  const left = Math.max(0, due - done);
  const started = Date.parse(String(status.startedAt));
  const updated = Date.parse(String(status.updatedAt));
  const minutes = (updated - started) / 60_000;
  const perMinute = minutes > 0 ? done / minutes : null;
  const etaMinutes = status.state === 'running' && perMinute ? Math.round(left / perMinute) : null;
  return NextResponse.json(
    {
      ...status,
      done,
      left,
      percent: due > 0 ? Math.round((done / due) * 1000) / 10 : 100,
      perMinute: perMinute === null ? null : Math.round(perMinute * 10) / 10,
      etaMinutes,
      finishesAround: etaMinutes === null ? null : new Date(updated + etaMinutes * 60_000).toISOString(),
      // ★ A pass that died leaves "running" behind; the age of the last update says so.
      minutesSinceUpdate: Math.round((Date.now() - updated) / 60_000)
    },
    { headers }
  );
}
