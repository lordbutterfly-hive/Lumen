// HABIT-layer level curve: fast early (dopamine), long-tail late (cosmetic flex).
// One perfect day (100 XP) ≈ one early level. This is the personal "Summoner
// level" — task-driven, cosmetic, and NEVER an input to the league tier.

export function xpForLevel(level: number): number {
  if (level < 10) return 100;
  if (level < 25) return 200;
  if (level < 50) return 400;
  return 800;
}

export function levelFromXp(lifetimeXp: number): { level: number; xp: number; xpToNext: number } {
  let level = 1;
  let remaining = Math.max(0, Math.floor(lifetimeXp));
  for (let guard = 0; guard < 100000; guard++) {
    const need = xpForLevel(level);
    if (remaining < need) return { level, xp: remaining, xpToNext: need - remaining };
    remaining -= need;
    level++;
  }
  return { level, xp: 0, xpToNext: xpForLevel(level) };
}
