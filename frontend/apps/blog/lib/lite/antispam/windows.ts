/** Time-window keys + account-age helper for rate limiting (spec §H). */

export function dayKey(now: Date = new Date()): string {
  return `d:${now.toISOString().slice(0, 10)}`; // d:YYYY-MM-DD (UTC)
}

export function hourKey(now: Date = new Date()): string {
  return `h:${now.toISOString().slice(0, 13)}`; // h:YYYY-MM-DDTHH (UTC)
}

export function ageDays(createdAt: Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000);
}
