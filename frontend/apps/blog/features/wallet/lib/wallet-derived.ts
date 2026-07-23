import Big from 'big.js';
import { GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import { FullAccount } from '@hive/common-hiveio-packages/wax';
import { convertStringToBig } from '@ui/lib/helpers';
import { convertToHP, powerdownHive } from '@ui/lib/utils';
import { Chain } from '@transaction/lib/chain';
import { getCurrentHpApr } from './hp-apr';

/** Hive's sentinel value for "no power-down scheduled". */
const NO_WITHDRAWAL_SCHEDULED = '1969-12-31T23:59:59';

export interface WalletPowerDown {
  isActive: boolean;
  nextPaymentHp: Big;
  remainingHp: Big;
  nextPaymentDate: Date | null;
  daysUntilNext: number;
  weeksLeft: number;
}

export interface WalletFigures {
  liquidHive: Big;
  liquidHbd: Big;
  savingsHive: Big;
  savingsHbd: Big;
  vestingHp: Big;
  delegatedOutHp: Big;
  receivedHp: Big;
  /** Effective HP: own stake, minus what you delegated out, plus what you received. */
  netHp: Big;
  hpApr: Big;
  powerDown: WalletPowerDown;
  rewardHive: Big;
  rewardHbd: Big;
  rewardVestingHp: Big;
  hasClaimableRewards: boolean;
}

export function deriveWalletFigures(
  account: FullAccount,
  dynamicData: GetDynamicGlobalPropertiesResponse,
  chain: Chain
): WalletFigures {
  const { total_vesting_shares: totalVestingShares, total_vesting_fund_hive: totalVestingFundHive } = dynamicData;

  const toHp = (vests: Big) => convertToHP(vests, chain, totalVestingShares, totalVestingFundHive);

  const vestingHp = toHp(convertStringToBig(account.vesting_shares));
  const delegatedOutHp = toHp(convertStringToBig(account.delegated_vesting_shares));
  const receivedHp = toHp(convertStringToBig(account.received_vesting_shares));
  const netHp = vestingHp.minus(delegatedOutHp).plus(receivedHp);

  const toWithdraw = typeof account.to_withdraw === 'number' ? account.to_withdraw : parseFloat(String(account.to_withdraw));
  const withdrawn = typeof account.withdrawn === 'number' ? account.withdrawn : parseFloat(String(account.withdrawn));
  const withdrawRateVests = convertStringToBig(account.vesting_withdraw_rate).toNumber();
  const remainingVests = Math.max(0, (toWithdraw - withdrawn) / 1_000_000);
  const remainingHp = toHp(new Big(remainingVests));
  const isActive = account.next_vesting_withdrawal !== NO_WITHDRAWAL_SCHEDULED && remainingVests > 0;

  const nextPaymentDate = isActive ? new Date(`${account.next_vesting_withdrawal}Z`) : null;
  const daysUntilNext = nextPaymentDate
    ? Math.max(0, Math.ceil((nextPaymentDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : 0;
  const weeksLeft =
    isActive && withdrawRateVests > 0 ? Math.max(1, Math.ceil(remainingVests / withdrawRateVests)) : 0;

  const powerDown: WalletPowerDown = {
    isActive,
    nextPaymentHp: isActive ? powerdownHive(account, dynamicData, chain) : new Big(0),
    remainingHp,
    nextPaymentDate,
    daysUntilNext,
    weeksLeft
  };

  const rewardHive = convertStringToBig(account.reward_hive_balance);
  const rewardHbd = convertStringToBig(account.reward_hbd_balance);
  const rewardVestingHp = toHp(convertStringToBig(account.reward_vesting_balance));

  return {
    liquidHive: convertStringToBig(account.balance),
    liquidHbd: convertStringToBig(account.hbd_balance),
    savingsHive: convertStringToBig(account.savings_balance),
    savingsHbd: convertStringToBig(account.savings_hbd_balance),
    vestingHp,
    delegatedOutHp,
    receivedHp,
    netHp,
    hpApr: getCurrentHpApr(dynamicData),
    powerDown,
    rewardHive,
    rewardHbd,
    rewardVestingHp,
    hasClaimableRewards: rewardHive.gt(0) || rewardHbd.gt(0) || rewardVestingHp.gt(0)
  };
}
