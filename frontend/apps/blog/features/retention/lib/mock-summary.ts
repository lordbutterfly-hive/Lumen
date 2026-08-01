import { LeagueTier, RetentionSummary } from '../types';
import { DAILY_TASKS } from './tasks';
import { levelFromXp } from './xp';

// Lifetime XP of the demo account. Everything level-shaped is DERIVED from it by
// the real curve (xp.ts) so the mock can never disagree with the production math:
// 900 XP carries you to level 10, then 200/level ⇒ 3,820 ⇒ level 24, 120/200 in.
const MOCK_LIFETIME_XP = 3820;

// Mock RetentionSummary so the whole UI (navbar showcase, EXP bar, popover,
// byline emblem, profile card) builds and demos BEFORE the real chain-derive
// route exists. use-retention.ts toggles mock↔real via an env flag.
export function mockSummary(username = 'demo'): RetentionSummary {
  const { level, xp, xpToNext } = levelFromXp(MOCK_LIFETIME_XP);
  return {
    // Every number below except streakDays/activeWeeks is invented and
    // identical for every user — see RetentionSummary.habitSource.
    habitSource: 'mock',
    username,
    rank: { tier: LeagueTier.Torch, division: 2, standing: 63, showBylineEmblem: true },
    habit: { level, xp, xpToNext, lifetimeXp: MOCK_LIFETIME_XP, streakDays: 12, activeWeeks: 14 },
    tasks: DAILY_TASKS.map((t, i) => ({
      id: t.id,
      xp: t.xp,
      verifiable: t.verifiable,
      ticksStreak: t.ticksStreak,
      done: i < 3
    })),
    tenureYear: 2021,
    gate: { engagement: 0.4, tenure: 1, activeWeeks: 0.7 }
  };
}
