import { getLogger } from '@ui/lib/logging';
import { liteConfig } from '../config';
import { getAccountCreator, hasAccountCreator } from './account-creator';

/**
 * ACT-claim worker (spec §F.1). Keeps a small pool of Account Creation Tokens
 * ready so upgrades don't block. Real recurring cost (RC-backed HP or 3 HIVE) —
 * the claim itself is behind the AccountCreator seam (active authority).
 */

const logger = getLogger('app');
const DEFAULT_MIN_POOL = 5;

export async function runActClaimOnce(minPool = DEFAULT_MIN_POOL): Promise<{ claimed: boolean }> {
  if (!liteConfig.enabled || !hasAccountCreator()) return { claimed: false };
  const creator = getAccountCreator();
  const pending = await creator.pendingActCount();
  if (pending >= minPool) return { claimed: false };
  const { trxId } = await creator.claimAct();
  logger.info('Claimed an ACT (pool was %d/%d, trx %s)', pending, minPool, trxId);
  return { claimed: true };
}
