// Lumen retention — shared types. Two STRICTLY-SEPARATED layers (see
// /mnt/o/HIVE-BLOG-REBUILD/RETENTION-BUILD-MAP-2026-07-20.md):
//   - HABIT  (Level / XP / streak): task-driven, cosmetic, personal. Worthless
//     to a bot, so safe to be emitted-based.
//   - LEAGUE (Lightkeeper tier): keystone-gated — received stake-weighted
//     engagement + tenure + rolling active-weeks. The ONLY *visible* rank.
//     EXP / tasks / streak are NEVER inputs to it (anti-farm invariant AF-1).

export enum LeagueTier {
  Ember = 'ember',
  Spark = 'spark',
  Candle = 'candle',
  Torch = 'torch',
  Lantern = 'lantern',
  Beacon = 'beacon',
  Halo = 'halo',
  Aurora = 'aurora',
  Lumen = 'lumen'
}

export enum LeagueBand {
  Kindling = 'kindling', // Ember, Spark, Candle — no byline emblem
  MadeLight = 'made-light', // Torch, Lantern, Beacon — byline emblem
  Celestial = 'celestial' // Halo, Aurora, Lumen — capped apex
}

// Divisions I..IV within the six lower tiers; undefined for the capped apex.
export type Division = 1 | 2 | 3 | 4;

export interface LeagueRank {
  tier: LeagueTier;
  division?: Division;
  standing: number; // 0..100 Standing Score (drives the progress-to-next bar)
  showBylineEmblem: boolean; // true from Torch up (Made Light band and above)
}

export interface HabitProgress {
  level: number;
  xp: number; // xp into the current level
  xpToNext: number; // xp remaining to reach the next level
  lifetimeXp: number;
  streakDays: number;
  activeWeeks: number; // rolling active-weeks (also a league gate input)
}

export type DailyTaskId = 'show-up' | 'read' | 'react' | 'reply' | 'create';

export interface DailyTask {
  id: DailyTaskId;
  xp: number;
  verifiable: boolean; // on-chain (server-verified) vs forgeable (client localStorage)
  ticksStreak: boolean;
  done: boolean;
}

export interface RetentionSummary {
  username: string;
  rank: LeagueRank;
  habit: HabitProgress;
  tasks: DailyTask[];
  tenureYear: number; // "Member since <year>"
  // Honest "what's gating your next promotion" breakdown, each 0..1.
  gate: { engagement: number; tenure: number; activeWeeks: number };
}
