import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import {
  DAILY_GOAL_MAX,
  DAILY_GOAL_MIN,
  readDailyGoalFor,
  writeDailyGoalFor
} from '@/blog/lib/lite/repositories/hive-retention-repository';
import { dropStreakCache } from '@/blog/lib/lite/retention/streak-cache';

const logger = getLogger('app');

/**
 * ════ THE DAILY GOAL, SERVER-HELD ════
 *
 * The goal moved out of localStorage on 2026-08-09 because it now GATES THE STREAK. While
 * it was cosmetic, `daily-goal.ts` said plainly that "editing it in localStorage changes
 * the ring you look at and nothing else" — true then, and the reason a council seat
 * correctly called the picker decorative. Wiring it to the streak makes it an input to a
 * chain-derived number, and that number is only worth anything because it cannot be
 * self-inflated. A goal a reader could edit in devtools would hand them their own streak.
 *
 * ★ SESSION-SCOPED, LIKE `/api/lite/retention`. It takes no account parameter and answers
 * only about the caller. A username parameter would be an enumeration surface and a lie
 * about what the server will honour — nobody may read or set anybody else's goal.
 */

/** The identity the goal is stored under: a lite ULID, else the Hive account name. */
async function actorKey(): Promise<string | null> {
  try {
    // Same session helper `/api/lite/retention` uses, so this route agrees with the rest
    // of the app about who is calling rather than introducing a second notion of it.
    const session = await getLiteSession();
    const user = session.user;
    if (!user?.isLoggedIn) return null;
    // A lite account's identity IS its ULID — its handle is display only and can change.
    // Keying on the handle would silently orphan the goal on a rename.
    return user.userId || user.username || null;
  } catch {
    return null;
  }
}

export async function GET() {
  const key = await actorKey();
  if (!key) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    return NextResponse.json({ goal: await readDailyGoalFor(key) });
  } catch (err) {
    logger.warn(err, 'retention/goal: read failed');
    // Degrade to the smallest goal rather than failing the card. The smallest goal is
    // also the safe one: it cannot cause a streak to be lost to a target nobody chose.
    return NextResponse.json({ goal: DAILY_GOAL_MIN });
  }
}

export async function POST(req: NextRequest) {
  const key = await actorKey();
  if (!key) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let goal: unknown;
  try {
    goal = (await req.json())?.goal;
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const n = Number(goal);
  if (!Number.isFinite(n) || n < DAILY_GOAL_MIN || n > DAILY_GOAL_MAX) {
    return NextResponse.json({ error: 'goal out of range' }, { status: 400 });
  }

  try {
    const written = await writeDailyGoalFor(key, n);
    // ★★ AND DROP THE STREAK ROUTE'S CACHED ANSWER (2026-08-09, runtime-proven bug).
    //
    // Without this, the write succeeded, this route answered 200 with the new goal, and
    // `/api/streak/[user]` kept serving a body computed against the OLD goal for up to its
    // 5-minute TTL. Measured live: hard reloads at 19s, 47s, 122s and 256s all still read
    // `0/4` and "Day 2 holds when you reach 4 today" after a write of 2; it flipped at 320s.
    // The card's `refetch()` was re-requesting a route that had nothing new to say, so the
    // picker looked inert — and INTERMITTENTLY inert, because a cache miss makes it instant.
    //
    // Best-effort by nature: it is a process-local Map, so a multi-worker deployment can
    // land the write on a worker that never filled the cache. That is exactly why the entry
    // also carries `goalUsed` and is re-validated on read — see streak-cache.ts. Neither
    // defence is sufficient alone.
    dropStreakCache(key);
    return NextResponse.json({ goal: written });
  } catch (err) {
    logger.error(err, 'retention/goal: write failed');
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }
}
