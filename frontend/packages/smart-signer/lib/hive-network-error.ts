import { getLogger } from '@hive/ui/lib/logging';
import {
  advanceToNextRpcEndpoint,
  restorePreferredRpcEndpoint,
  currentRpcEndpoint
} from '@hive/common-hiveio-packages';

const logger = getLogger('app');

/**
 * ★ ONE DEFINITION OF "HIVE WAS UNREACHABLE" (2026-08-09).
 *
 * This list lived privately inside `signer/verify-authority.ts` and the server
 * had no equivalent, so the same blip was a friendly client message on one side
 * and a flat 500 on the other. Two copies of a rule drift; this codebase already
 * learned that when its two NSFW detectors disagreed and posts fell between them.
 *
 * The patterns are deliberately broad: mistaking a real auth failure for a
 * network one costs a pointless retry, while the reverse tells someone their
 * credentials are bad when they are fine.
 */
const NETWORK_ERROR_PATTERNS = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  // ★ BOTH SPELLINGS, AND THIS IS NOT PEDANTRY (2026-08-09). The list started
  // with `/timeout/i` only, and the fault-injection run failed 2/6 because wax
  // raises `WaxRequestTimeoutError: Request timed out: "POST https://api.hive.blog"`
  // — "timed out", which `/timeout/i` does not match. Nothing classified it as a
  // network failure, so the reader got the flat 500 this module exists to
  // prevent AND the retry never fired. Caught only because the harness injected
  // a real timeout instead of trusting the code to be right.
  /timed\s*out/i,
  /timeout/i,
  /fetch failed/i,
  /network\s+(error|failure|request|unavailable)/i,
  /possible network or CORS error/i,
  /abort/i,
  /socket hang up/i
];

/**
 * True when `error` looks like "we could not talk to the Hive node", as opposed
 * to "the node answered and said no". Walks the `cause` chain, because wax wraps
 * the real reason: the message that actually carried `ETIMEDOUT` on this box was
 * an `AggregateError` two levels down from a `WaxUnknownRequestError`.
 */
export function isHiveNetworkError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    // `type` as well as `name`: wax reports its class as `type`
    // ("WaxRequestTimeoutError") while `name` stays the generic "WaxError", so
    // matching on `name` alone throws away the most specific signal available.
    const waxType = (current as { type?: unknown }).type;
    const message =
      current instanceof Error
        ? `${current.name}: ${typeof waxType === 'string' ? `${waxType}: ` : ''}${current.message}`
        : String(current);
    if (NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(message))) return true;
    // AggregateError carries its real reasons in `errors`, not in `cause`.
    const aggregated = (current as { errors?: unknown[] }).errors;
    if (Array.isArray(aggregated) && aggregated.some((e) => isHiveNetworkError(e))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Run a Hive API call, retrying ONLY when the node could not be REACHED, and
 * moving to the next node each time that happens.
 *
 * Never retries an answer: a node that says "this signature is invalid" has done
 * its job, and asking again would turn a clear rejection into a slow one.
 *
 * Measured cause (2026-08-09): a login died on `AggregateError [ETIMEDOUT]` from
 * node's connect path while a direct request to the same endpoint answered in
 * 0.375 s. A retry covers that; failover covers the node simply being down.
 */
/**
 * ★★★ THE ALL-NODES-DOWN CASE HAS TO FAIL FAST, NOT THOROUGHLY (2026-08-18).
 *
 * Without a wall-clock budget, "try harder" is indistinguishable from "hang".
 * Each attempt can sit on the server's 8s socket timeout, so a rotation of six
 * dead nodes is 48s of a reader staring at a spinner before being told anything —
 * and every one of those seconds also pins a server request slot, so a total Hive
 * outage would take this app down with it rather than degrading it.
 *
 * A deadline turns that into an honest error in a few seconds. Reaching it stops
 * the loop even if attempts remain, because at that point what is missing is not
 * more tries, it is a working node.
 */
const DEFAULT_DEADLINE_MS = 12_000;

export async function withHiveRetry<T>(
  operation: () => Promise<T>,
  label: string,
  attempts = 3,
  backoffMs = 250,
  deadlineMs = DEFAULT_DEADLINE_MS
): Promise<T> {
  // A recovered preferred node is only discoverable by asking, and the start of a
  // guarded call is the one moment we know somebody wants an answer anyway.
  restorePreferredRpcEndpoint();

  const startedAt = Date.now();
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Captured BEFORE the call so a failure is attributed to the node that
    // actually served it, even if another request moves the process meanwhile.
    const attemptedEndpoint = currentRpcEndpoint();
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isHiveNetworkError(error) || attempt === attempts) throw error;
      if (Date.now() - startedAt >= deadlineMs) {
        logger.warn(
          '%s: giving up after %dms — every Hive node tried was unreachable',
          label,
          Date.now() - startedAt
        );
        throw error;
      }
      // First failure may just be a transient stall, so retry the same node once;
      // after that, assume the node is actually down and move off it.
      const movedTo = attempt > 1 ? advanceToNextRpcEndpoint(attemptedEndpoint) : undefined;
      logger.warn(
        '%s: could not reach the Hive node (attempt %d of %d)%s',
        label,
        attempt,
        attempts,
        movedTo ? ` — failing over to ${movedTo}` : ', retrying'
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError;
}
