import { GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import { convertStringToBig } from '@ui/lib/helpers';
import Big from 'big.js';

/**
 * Estimated APR (as a plain number, e.g. 11.4 meaning "11.4%") for staking
 * HIVE into Hive Power (HP).
 *
 * Same formula the standalone @hive/wallet app uses (see
 * apps/wallet/lib/utils.ts#getCurrentHpApr) — reproduced here because Next.js
 * apps in this monorepo don't import each other's app code, only shared
 * packages. Derives the current chain inflation rate from the block height
 * (9.5% at block 7,000,000, decreasing 0.01% every 250,000 blocks, floor
 * 0.95%), then applies the vesting-reward share of that inflation to the
 * total vesting fund to get an annualized rate. `currentInflationRate` is
 * carried as a bare percent number (9.5, not 0.095) throughout — that is
 * intentional and matches the source formula; do not re-normalize it.
 */
export function getCurrentHpApr(data: GetDynamicGlobalPropertiesResponse): Big {
  const initialInflationRate = 9.5;
  const initialBlock = 7_000_000;

  const decreaseRateBlocks = 250_000;
  const decreasePercentPerIncrement = 0.01;

  const deltaBlocks = data.head_block_number - initialBlock;
  const decreaseIncrements = deltaBlocks / decreaseRateBlocks;

  let currentInflationRate = initialInflationRate - decreaseIncrements * decreasePercentPerIncrement;
  if (currentInflationRate < 0.95) {
    currentInflationRate = 0.95;
  }

  const vestingRewardPercent = data.vesting_reward_percent / 10000;
  const virtualSupply = convertStringToBig(data.virtual_supply);
  const totalVestingFunds = convertStringToBig(data.total_vesting_fund_hive);

  return virtualSupply.times(currentInflationRate).times(vestingRewardPercent).div(totalVestingFunds);
}
