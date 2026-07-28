import { getLogger } from '@ui/lib/logging';
import { siteConfig } from '@ui/config/site';
import { liteConfig } from '../config';

const logger = getLogger('app');

/**
 * Resource-credit pre-flight for the publisher.
 *
 * Every broadcast spends RC. Without a check, the publisher keeps trying as RC drains
 * and eventually every job fails on a generic "not enough RC" error, retries, and
 * burns its attempts — turning a funding problem into a queue of permanently failed
 * posts. So: look before broadcasting, and stop cleanly while there is still headroom.
 *
 * Deliberately FAILS OPEN. If the RC endpoint is unreachable we allow the broadcast:
 * a node hiccup must not halt publishing, and the broadcast itself will surface a real
 * RC error if there genuinely is one.
 */

/** Cache so a 25-job drain does not make 25 identical RC queries. */
const CACHE_MS = 30_000;
let cached: { at: number; rc: number } | null = null;

export interface RcStatus {
  ok: boolean;
  /** Percent of max RC remaining, or null when it could not be read. */
  percent: number | null;
  reason?: string;
}

async function readRcPercent(account: string): Promise<number | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.rc;
  try {
    const res = await fetch(siteConfig.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'rc_api.find_rc_accounts',
        params: { accounts: [account] },
        id: 1
      })
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      result?: { rc_accounts?: { max_rc?: string; rc_manabar?: { current_mana?: string } }[] };
    };
    const rc = data.result?.rc_accounts?.[0];
    const max = Number(rc?.max_rc ?? 0);
    const current = Number(rc?.rc_manabar?.current_mana ?? 0);
    if (!max) return null;
    const percent = Math.max(0, Math.min(100, (current / max) * 100));
    cached = { at: Date.now(), rc: percent };
    return percent;
  } catch {
    return null;
  }
}

/**
 * Is there enough RC to keep publishing? Below the floor the drain stops rather than
 * grinding jobs into terminal failures — the queue is durable, so waiting costs
 * nothing but a delay.
 */
export async function checkRc(): Promise<RcStatus> {
  const account = liteConfig.frontendAccount;
  if (!account) return { ok: true, percent: null };

  const percent = await readRcPercent(account);
  if (percent === null) return { ok: true, percent: null }; // fail open, see header

  if (percent < liteConfig.rcFloorPercent) {
    logger.error(
      'Publisher paused: @%s RC at %s%% is below the %s%% floor — posts will queue until it recovers (power up to raise capacity)',
      account,
      percent.toFixed(1),
      liteConfig.rcFloorPercent
    );
    return {
      ok: false,
      percent,
      reason: `RC at ${percent.toFixed(1)}% is below the ${liteConfig.rcFloorPercent}% floor`
    };
  }
  if (percent < liteConfig.rcFloorPercent * 2) {
    logger.warn('Publisher RC getting low: @%s at %s%%', account, percent.toFixed(1));
  }
  return { ok: true, percent };
}

/** Test/ops hook: forget the cached reading. */
export function resetRcCache(): void {
  cached = null;
}
