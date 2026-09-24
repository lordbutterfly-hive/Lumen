import type { Entry } from '@hive/common-hiveio-packages/wax';
import { ulidFloor, ulidTime } from '@/blog/lib/lite/ids';

/**
 * A Lumen (lite) account's profile Posts tab with reblog comments on: their own posts
 * AND their reblogs (with their comment, including one still publishing), newest first
 * (quote reblog spec v2 3.3, 3.5; owner: "allow plain reblogs on your profile").
 *
 * Both lists page on ONE time cursor: `bt:<ms>` = items strictly older than that
 * millisecond (a legacy post-id cursor is read as its ULID time).
 */
export function parseLiteCursor(before?: string): { postsBefore?: string; time: Date | null } {
  if (!before) return { time: null };
  if (before.startsWith('bt:')) {
    const ms = Number(before.slice(3));
    return Number.isFinite(ms) ? { postsBefore: ulidFloor(ms), time: new Date(ms) } : { time: null };
  }
  const ms = ulidTime(before);
  return { postsBefore: before, time: ms === null ? null : new Date(ms) };
}

export interface TimedEntry {
  entry: Entry;
  ms: number;
}

/** Newest `limit` of both lists, and where the next page starts (null: no more). */
export function mergeLiteProfile(own: TimedEntry[], reblogs: TimedEntry[], limit: number, moreOwn: boolean, moreReblogs: boolean): { entries: Entry[]; nextBefore: string | null } {
  const all = [...own, ...reblogs].sort((a, b) => b.ms - a.ms);
  const page = all.slice(0, limit);
  const more = all.length > limit || moreOwn || moreReblogs;
  const last = page[page.length - 1];
  return { entries: page.map((i) => i.entry), nextBefore: more && last ? `bt:${last.ms}` : null };
}
