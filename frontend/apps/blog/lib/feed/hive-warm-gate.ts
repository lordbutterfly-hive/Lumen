import 'server-only';

/**
 * ★★★ ONE OUTBOUND-WARM BUDGET, SHARED BY BOTH WARMERS (2026-08-15).
 *
 * Two background warmers now exist and neither knew about the other:
 *   - `topic-warmer.ts` — 16 tags per cycle against `api.hive.blog`
 *   - `viewer-warmer.ts` — one ranked build per viewer, each a ~30-way
 *     `getPost` burst against the same node
 *
 * Both files independently state the rule ("IT MUST NOT STAMPEDE THE NODE… a
 * burst is how you get rate-limited into the empty feeds this route's history
 * is full of"), and both enforce it only against THEMSELVES. Measured on this
 * box on 2026-08-15, with both running:
 *
 *   topic-warmer: could not warm #silvergoldstackers: WaxError … timeout 8000
 *   topic-warmer: warmed 15/16 tags in 61893ms (1 failed)
 *   viewer-warmer: cycle warmed 0/1 viewers in 17264ms (1 failed, 0 in backoff)
 *
 * The viewer build did not fail on its own merits — it failed while the node
 * was saturated by the other warmer. Two correct-in-isolation components
 * producing a wrong system is exactly the class of defect this wave was told to
 * watch for, and it only appears when both are enabled at once.
 *
 * ★ WHY `globalThis` AND NOT A MODULE VARIABLE. Next bundles each route
 * separately and BOTH compiled routes carry their own inlined copy of these
 * modules — proven this session when `/api/feed/warm` reported
 * `builderRegistered:false` on 23 of 31 calls while another copy in the same
 * process held the builder. A module-level flag here would be per-copy and this
 * gate would silently not gate. `Symbol.for` resolves one slot per process.
 *
 * This is a COURTESY gate, deliberately not a queue: a warmer that finds the
 * node busy SKIPS its cycle and tries again on its own schedule. Queueing would
 * convert node slowness into unbounded memory and a thundering retry, which is
 * the failure it exists to prevent.
 */
const GATE = Symbol.for('lumen.feed.hiveWarmGate');

interface GateState {
  /** Name of the warmer currently holding the budget, or null. */
  holder: string | null;
  /** When it took the budget — used only for the stale-holder escape hatch. */
  since: number;
}

/**
 * A crashed cycle that never released would block the other warmer forever, so
 * a holder older than this is treated as gone. Set well above the slowest
 * measured cycle (topic warmer: 98,458ms on 2026-08-15) so a genuinely slow
 * cycle is never stolen from.
 */
const STALE_HOLDER_MS = 5 * 60_000;

function state(): GateState {
  const carrier = globalThis as typeof globalThis & { [GATE]?: GateState };
  carrier[GATE] ??= { holder: null, since: 0 };
  return carrier[GATE];
}

/** Who holds the outbound warm budget right now, or null if it is free. */
export function hiveWarmHolder(): string | null {
  const s = state();
  if (s.holder && Date.now() - s.since > STALE_HOLDER_MS) {
    s.holder = null;
  }
  return s.holder;
}

/**
 * Take the budget for `name`. Returns false when another warmer holds it — the
 * caller must then skip its cycle, not wait.
 */
export function acquireHiveWarm(name: string): boolean {
  const s = state();
  if (hiveWarmHolder() !== null) return false;
  s.holder = name;
  s.since = Date.now();
  return true;
}

/** Release the budget. Safe to call when not held, and safe to call twice. */
export function releaseHiveWarm(name: string): void {
  const s = state();
  if (s.holder === name) {
    s.holder = null;
    s.since = 0;
  }
}
