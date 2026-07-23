// Pure streak + rolling-active-weeks derivation. Input is the set of UTC days on
// which the account did a genuine (streak-ticking) act — derived server-side from
// on-chain history so it can't be self-inflated. A banked freeze bridges one
// missed day (Duolingo mercy; prevents the churn cliff).

export interface StreakInputs {
  actDaysUTC: string[]; // 'YYYY-MM-DD' days with a genuine act (unordered, may dup)
  todayUTC: string; // 'YYYY-MM-DD'
  freezeAvailable: number; // banked freezes that can each bridge one gap
}

export interface StreakResult {
  streakDays: number;
  activeWeeks: number; // distinct ISO weeks in the trailing 26 with >= 1 act
}

export function computeStreak(inp: StreakInputs): StreakResult {
  const days = new Set(inp.actDaysUTC);
  let streak = 0;
  let freezes = Math.max(0, inp.freezeAvailable);

  // If today has no act *yet*, don't break mid-day — count the run ending yesterday.
  let cursor = parse(inp.todayUTC);
  if (!days.has(fmt(cursor))) cursor = addDays(cursor, -1);

  for (let guard = 0; guard < 3650; guard++) {
    const key = fmt(cursor);
    if (days.has(key)) {
      streak++;
    } else if (freezes > 0) {
      freezes--; // a banked freeze bridges one missed day
    } else {
      break;
    }
    cursor = addDays(cursor, -1);
  }

  const cutoff = addDays(parse(inp.todayUTC), -26 * 7);
  const weeks = new Set<string>();
  for (const d of inp.actDaysUTC) {
    const dt = parse(d);
    if (dt.getTime() >= cutoff.getTime()) weeks.add(isoWeek(dt));
  }

  return { streakDays: streak, activeWeeks: weeks.size };
}

function parse(d: string): Date {
  return new Date(d + 'T00:00:00Z');
}
function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}
function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${weekNo}`;
}
