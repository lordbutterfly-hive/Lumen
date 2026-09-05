/**
 * ★★★ THE KILL SWITCH FOR THE BANNED-FOLLOW-EDGE FAN-OUT (2026-09-05), so the
 * fan-out can be MEASURED off rather than argued about. Pure, no imports, no
 * I/O -- unit-tested next door under this package's own mocha runner.
 *
 * WHAT IT GATES. `hive-api.ts`'s `bannedFollowEdges` issues
 * `2 * <ban list size>` `bridge.get_relationship_between_accounts` calls (twelve
 * on today's six-name list) on every cache-cold `getAccountFull`, purely to
 * SUBTRACT banned accounts from the follower/following counts that
 * `bridge.get_profile`'s own `stats` already carries. Measured on prod over 45
 * minutes / 950 profile renders, the layout stage that awaits `getAccountFull`
 * is p50 800ms, p90 2194ms, max 9470ms -- the dominant cold stage.
 *
 * WHY A SWITCH RATHER THAN A DELETION. The fan-out is not obviously wrong; it
 * is obviously EXPENSIVE, and those are different claims. Removing it outright
 * would trade a known display correction for an unknown latency win, decided on
 * a code read. With the switch, the same binary answers both questions on the
 * box, on real traffic, with the render-timing line as the ruler -- and if the
 * win is not there, one env var puts it back with no deploy.
 *
 * ONLY THE EXACT STRING `no` DISABLES IT (case-insensitive, trimmed). NOT
 * `false`, NOT `0`, NOT `off`. This gate decides what the site DISPLAYS -- a
 * follower count that silently stops being corrected because somebody wrote
 * `false` where the code wanted `no` is a worse outcome than a switch that
 * simply did not take. Unset means enabled, so the default is today's
 * behaviour, unchanged.
 *
 * SERVER-SIDE ONLY, and deliberately so: `LUMEN_*` variables are plain
 * `process.env` (like `LUMEN_BANNED_AUTHORS`) and never reach the browser
 * through react-env. A browser-side `getAccountFull` therefore always sees the
 * default and keeps correcting. That is the honest scope of the A/B: it moves
 * SERVER render time, which is what the profile layout's cold stage is made of.
 *
 * ★ THE ONE BROWSER CALLER, NAMED so nobody has to re-grep for it:
 * `apps/blog/features/lite-auth/upgrade/upgrade-panel.tsx`'s `onChainOwnerKeys`
 * dynamically imports `@transaction/lib/hive-api` and calls `getAccountFull` up
 * to five times while it waits for a freshly broadcast account to appear in a
 * block. That runs in the page, where `process.env.LUMEN_BANNED_FOLLOW_EDGES`
 * does not exist, so it keeps the fan-out with the switch off -- twelve extra
 * calls per attempt, from the client, unaffected by this experiment. It is not a
 * render path and it is not what the A/B measures; it is listed here so the
 * result is not mistaken for "the fan-out is gone everywhere".
 */
export const BANNED_FOLLOW_EDGES_ENV = 'LUMEN_BANNED_FOLLOW_EDGES';

/**
 * `env` is injectable for the test; production passes nothing and gets a guarded
 * read of `process.env` -- guarded because this module is reachable from the
 * client bundle, where a bundler may leave no `process` at all (the same guard
 * `@ui/config/lists/banned-authors.ts` uses, and for the same reason).
 */
function currentEnv(): Record<string, string | undefined> {
  try {
    return typeof process !== 'undefined' && process.env ? process.env : {};
  } catch {
    return {};
  }
}

export function bannedFollowEdgesEnabled(env: Record<string, string | undefined> = currentEnv()): boolean {
  const raw = env[BANNED_FOLLOW_EDGES_ENV];
  if (typeof raw !== 'string') return true;
  return raw.trim().toLowerCase() !== 'no';
}
