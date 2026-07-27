/**
 * Broadcast pacing for the publishing account.
 *
 * Hive enforces HIVE_MIN_REPLY_INTERVAL = 3 s per posting account
 * (protocol/config.hpp:46; asserted in hive_evaluator_social.cpp:212 — "You may
 * only comment once every 3 seconds"), and EVERY broadcast we make counts: the
 * container root post bumps the same `last_post` timestamp the child comments are
 * measured against. So this counter must be shared by every code path that
 * broadcasts, not per module — a container root published without recording it is
 * exactly what makes the next child fail.
 *
 * Single-process pacing. A second concurrent worker would need a DB-side lock
 * (e.g. an advisory lock keyed on the publishing account) instead.
 */

const MIN_INTERVAL_MS = 3500;

let lastBroadcastAt = 0;

/** Wait, if needed, until it is safe to broadcast again. */
export async function pauseForCommentInterval(): Promise<void> {
  const wait = lastBroadcastAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/** Record that a broadcast just happened. Call after EVERY successful broadcast. */
export function noteBroadcast(): void {
  lastBroadcastAt = Date.now();
}
