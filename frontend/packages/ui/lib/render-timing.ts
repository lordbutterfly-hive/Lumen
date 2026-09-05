import { getLogger } from './logging';

const logger = getLogger('app');

/**
 * ★★★ WHERE A SERVER RENDER ACTUALLY SPENDS ITS TIME, OFF BY DEFAULT
 * (2026-09-05, cold-profile fix).
 *
 * ★ IN `packages/ui`, NOT `apps/blog`, SINCE 2026-09-05 (evening). The stage
 * that turned out to dominate a cold profile lives in `packages/transaction`
 * (`hive-api.ts`'s `getAccountFull`), which cannot import from the app -- there
 * is no `@/blog/*` path in that package's tsconfig and the dependency would
 * point the wrong way. The alternative was a second copy of this file with the
 * same shape, i.e. two timers to keep in step; one module both sides already
 * import (`@ui/*`) is strictly better. Nothing about the behaviour changed in
 * the move.
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

/**
 * ★★★ EVERY FIELD IS SANITISED, BECAUSE ONE OF THEM IS UNTRUSTED INPUT
 * (2026-09-05, review of the live instrument). This line is SPACE-DELIMITED
 * `key=value`, and at least one emitter puts a URL segment in it: the profile
 * layout's `generateMetadata` reaches `getAccountFullCached` with whatever
 * `/@<param>` contained, so a request for `/@a%20total=1ms` would have written
 *
 *     render-timing: account-full user=a total=1ms account=812ms ... total=830ms
 *
 * -- a forged field, ahead of the real one, in the log a latency decision is
 * about to be made from. Log injection is not a crash and nothing would ever
 * have flagged it; it just quietly poisons the measurement.
 *
 * The rule is the Hive account-name charset (`[a-z0-9.-]`, lower-cased first
 * because that is what a Hive name is), everything else becomes `_`, capped at
 * 32 characters. Applied to the LABEL, every KEY and every VALUE -- not just
 * `user` -- so a field added later cannot reopen this by being the one nobody
 * sanitised. Our own values (`812ms`, `won`, `not-an-account`, `3500`) already
 * live inside that charset and pass through unchanged.
 */
export function sanitiseTimingField(value: string | number): string {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '_')
    .slice(0, 32);
}

/** The whole cost of "off": one shared frozen object, two empty functions. */
const NO_OP: RenderTimer = Object.freeze({
  mark: () => undefined,
  done: () => undefined
});

/**
 * `process.env` READ THROUGH A GUARD, because this module is now reachable from
 * the CLIENT bundle too (`hive-api.ts` is: several surfaces call a Hive node
 * directly from the browser). `@ui/config/lists/banned-authors.ts` already
 * guards its own `process.env` read for exactly this reason -- "so bundlers that
 * inline `process.env` in browser builds cannot throw". In a browser this
 * resolves to an empty environment, so the timer is simply OFF there, which is
 * the correct answer: `LUMEN_RENDER_TIMING` is a server variable and is never
 * shipped to the client.
 */
function currentEnv(): Record<string, string | undefined> {
  try {
    return typeof process !== 'undefined' && process.env ? process.env : {};
  } catch {
    return {};
  }
}

export function renderTimingEnabled(env: Record<string, string | undefined> = currentEnv()): boolean {
  return env.LUMEN_RENDER_TIMING === 'yes';
}

/**
 * A single duration, for work that does NOT fit the sequential `mark()` model --
 * two branches of a `Promise.all`, say, where "time since the previous mark" is
 * meaningless because they overlap. Start one per branch and read it when that
 * branch settles.
 *
 * Returns **-1**, never a throw and never a plausible-looking 0, when the clock
 * could not be read: a missing number must be visible in the log line as a
 * missing number, not silently indistinguishable from "instant". A caller that
 * emits its line before a branch has settled reports the same -1, and means the
 * same thing by it: NOT MEASURED, not "took no time".
 */
export interface RenderStopwatch {
  elapsedMs(): number;
}

export function renderStopwatch(): RenderStopwatch {
  let started: number | null = null;
  try {
    started = performance.now();
  } catch {
    started = null;
  }
  return {
    elapsedMs(): number {
      try {
        return started === null ? -1 : Math.round(performance.now() - started);
      } catch {
        return -1;
      }
    }
  };
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
  env: Record<string, string | undefined> = currentEnv()
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
        stages.push(`${sanitiseTimingField(stage)}=${Math.round(now - previous)}ms`);
        previous = now;
      } catch {
        // An instrument may not break a render. See this module's doc comment.
      }
    },
    done(extra?: Record<string, string | number>): void {
      try {
        const total = Math.round(performance.now() - started);
        const head = extra
          ? Object.entries(extra).map(
              ([key, value]) => `${sanitiseTimingField(key)}=${sanitiseTimingField(value)}`
            )
          : [];
        log(
          `render-timing: ${sanitiseTimingField(label)} ${[...head, ...stages, `total=${total}ms`].join(' ')}`
        );
      } catch {
        // Same: a failed log line is not a failed page.
      }
    }
  };
}
