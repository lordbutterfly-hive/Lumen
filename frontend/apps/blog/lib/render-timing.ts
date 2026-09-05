import { getLogger } from '@ui/lib/logging';

const logger = getLogger('app');

/**
 * ★★★ WHERE A SERVER RENDER ACTUALLY SPENDS ITS TIME, OFF BY DEFAULT
 * (2026-09-05, cold-profile fix).
 *
 * WHY THIS EXISTS. Every number we had for the profile render came from the
 * OUTSIDE (curl TTFB), which cannot tell a slow upstream from a slow merge from
 * a slow trim -- and this session already shipped and retracted two conclusions
 * built on outside-only numbers (see HANDOFF-2026-09-05 section 3). A per-stage
 * line from INSIDE the render is the instrument that settles those arguments,
 * and the audience-split budget in `lib/feed/posts-prefetch-budget.ts` needs
 * exactly one measurement to be judged on: did the race win, and what did the
 * wait actually cost.
 *
 * WHY IT IS OFF BY DEFAULT, AND WHAT "OFF" MEANS. `LUMEN_RENDER_TIMING=yes`
 * turns it on; anything else returns the shared no-op timer below, so a
 * production render does no `performance.now()` call, builds no string, and
 * allocates nothing per stage. Instrumentation that costs something when it is
 * off is instrumentation that changes the thing it measures.
 *
 * `performance.now()`, NOT `Date.now()`, for the reason `warm-server-caches.ts`
 * spells out at length: a wall clock is not monotonic, this box resyncs against
 * its host, and the first version of that warm timer printed a NEGATIVE
 * duration. A duration must come from a monotonic source.
 *
 * IT MUST NEVER MATTER. `mark()` and `done()` swallow everything they could
 * possibly throw and return void, so no render can fail, slow down or take a
 * different branch because a log line could not be produced. A timer is an
 * observer; it is never a participant.
 */
export interface RenderTimer {
  /** Close the stage that just finished, recording its own duration. */
  mark(stage: string): void;
  /** Emit the one line (if enabled). `extra` is prefixed as `key=value` pairs. */
  done(extra?: Record<string, string | number>): void;
}

/** The whole cost of "off": one shared frozen object, two empty functions. */
const NO_OP: RenderTimer = Object.freeze({
  mark: () => undefined,
  done: () => undefined
});

export function renderTimingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.LUMEN_RENDER_TIMING === 'yes';
}

/**
 * Module-level, not an inline default expression: a default arrow would be
 * ALLOCATED on every `renderTimer()` call, including the disabled ones this
 * module exists to make free.
 */
const defaultSink = (line: string): void => logger.info(line);

/**
 * A timer for one render. `log` and `env` are injectable for the test only;
 * production passes neither and gets `getLogger('app').info` and `process.env`.
 *
 * The emitted line, e.g.:
 *   render-timing: profile-posts user=bozz anon=true race=won posts=1234ms
 *   attach=12ms block=3ms merge=8ms trim=1ms total=1290ms
 * Each stage is the time since the PREVIOUS mark (so the stages sum to roughly
 * `total`), and `total` is measured from `renderTimer()` itself.
 */
export function renderTimer(
  label: string,
  log: (line: string) => void = defaultSink,
  env: Record<string, string | undefined> = process.env
): RenderTimer {
  if (!renderTimingEnabled(env)) return NO_OP;
  // ★ EVEN THE FIRST READING IS GUARDED (2026-09-05, review). `mark`/`done`
  // caught their own `performance.now()`, but this one sat outside any try --
  // so with the flag ON, a runtime without `performance` would have thrown from
  // `renderTimer()` itself and failed the render it was only supposed to watch.
  // A timer that cannot start simply reports nothing.
  let started: number;
  try {
    started = performance.now();
  } catch {
    return NO_OP;
  }
  let previous = started;
  const stages: string[] = [];
  return {
    mark(stage: string): void {
      try {
        const now = performance.now();
        stages.push(`${stage}=${Math.round(now - previous)}ms`);
        previous = now;
      } catch {
        // An instrument may not break a render. See this module's doc comment.
      }
    },
    done(extra?: Record<string, string | number>): void {
      try {
        const total = Math.round(performance.now() - started);
        const head = extra ? Object.entries(extra).map(([key, value]) => `${key}=${value}`) : [];
        log(`render-timing: ${label} ${[...head, ...stages, `total=${total}ms`].join(' ')}`);
      } catch {
        // Same: a failed log line is not a failed page.
      }
    }
  };
}
