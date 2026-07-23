import { DailyTaskId } from '../types';

// The Daily 5 (HABIT layer). Complete up to 5 credited tasks/day, ONE credit per
// task-type — so the 51st comment pays nothing and there is no spam quota. The
// forgeable tasks (show-up, read) fill only the cosmetic EXP bar and NEVER the
// league (anti-farm invariant AF-2). Ordered trivial → stretch (Duolingo casual
// goal: any one genuine act keeps the Ember lit).
export interface TaskDef {
  id: DailyTaskId;
  xp: number;
  verifiable: boolean; // on-chain (server-verified) vs forgeable (client localStorage)
  ticksStreak: boolean;
  labelKey: string;
}

export const DAILY_TASKS: TaskDef[] = [
  { id: 'show-up', xp: 5, verifiable: false, ticksStreak: false, labelKey: 'retention.task.show_up' },
  { id: 'read', xp: 10, verifiable: false, ticksStreak: true, labelKey: 'retention.task.read' },
  { id: 'react', xp: 15, verifiable: true, ticksStreak: true, labelKey: 'retention.task.react' },
  { id: 'reply', xp: 20, verifiable: true, ticksStreak: true, labelKey: 'retention.task.reply' },
  { id: 'create', xp: 30, verifiable: true, ticksStreak: true, labelKey: 'retention.task.create' }
];

export const PERFECT_DAY_BONUS = 20;
export const MAX_DAILY_XP = DAILY_TASKS.reduce((s, t) => s + t.xp, 0) + PERFECT_DAY_BONUS; // 100

export function dailyXp(doneIds: DailyTaskId[]): number {
  const done = new Set(doneIds);
  let xp = 0;
  for (const t of DAILY_TASKS) if (done.has(t.id)) xp += t.xp;
  if (done.size >= DAILY_TASKS.length) xp += PERFECT_DAY_BONUS;
  return xp;
}
