import { ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';
import Big from 'big.js';
import { convertStringToBig } from './helpers';
import { TFunction } from 'i18next';
import type { FullAccount, Entry, IVote, HiveChain } from '@hive/common-hiveio-packages/wax';
import type { GetDynamicGlobalPropertiesResponse, NaiAsset } from '@hiveio/wax';
import { parseDate2 } from './parse-date';
import { EAssetName, Symbol, getNaiToSymbol, getPrecision } from './asset-constants';

// Re-export getRoundedAbbreveration from math-utils for backward compatibility
export { getRoundedAbbreveration } from './math-utils';

export interface Asset {
  amount: number;
  symbol: Symbol;
}

/**
 * Parses a string or NaiAsset into an Asset object.
 * Requires asset constants to be initialized via initializeAssetConstants().
 */
export const parseAsset = (sval: string | NaiAsset): Asset => {
  if (typeof sval === 'string') {
    const sp = sval.split(' ');
    return { amount: parseFloat(sp[0]), symbol: Symbol[sp[1] as keyof typeof Symbol] };
  } else {
    const naiToSymbol = getNaiToSymbol();
    return {
      amount: parseFloat(sval.amount.toString()) / Math.pow(10, sval.precision),
      symbol: naiToSymbol[sval.nai]
    };
  }
};

export const prepareVotes = (entry: Entry, votes: IVote[]) => {
  let totalPayout = 0;

  const { pending_payout_value, author_payout_value, curator_payout_value, payout } = entry;

  if (pending_payout_value && author_payout_value && curator_payout_value) {
    totalPayout =
      parseAsset(entry.pending_payout_value).amount +
      parseAsset(entry.author_payout_value).amount +
      parseAsset(entry.curator_payout_value).amount;
  }

  if (payout && Number(totalPayout.toFixed(3)) !== payout) {
    totalPayout += payout;
  }
  const voteRshares = votes && votes.reduce((a, b) => a + b.rshares, 0);
  const ratio = totalPayout / voteRshares;

  return votes.map((a) => {
    const rew = a.rshares * ratio;

    return Object.assign({}, a, {
      reward: rew,
      timestamp: parseDate2(a.time).getTime(),
      percent: a.percent / 100
    });
  });
};

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★★ tailwind-merge HAS TO BE TOLD ABOUT OUR FONT SCALE, OR IT DELETES IT.
 * (2026-08-20, owner-reported: "you made the payouts too small".)
 *
 * `twMerge` only knows Tailwind's DEFAULT size names — xs, sm, base, lg, xl and
 * so on. This app replaced that scale with its own (`tailwind.config.js`
 * `fontSize`: `body-lg`, `caption`, `read`, `lede`, `stat`, the numeric steps,
 * ...). Faced with `text-body-lg`, twMerge cannot match it against the font-size
 * group, so it falls through and classifies it as a text COLOUR — colours being
 * the group that accepts arbitrary names.
 *
 * The consequence is silent and specific: any element that sets a custom size
 * AND a colour in the same `cn()`, size first, loses the SIZE. twMerge sees two
 * "text colours", keeps the last, and drops the other. The class never reaches
 * the DOM at all, so nothing in the stylesheet can explain the wrong size and
 * devtools shows no losing rule — it shows no rule.
 *
 * MEASURED: the feed card's payout is written `text-body-lg` (17px) and
 * rendered at 15px, inherited, with `text-body-lg` absent from `className`,
 * because `text-[color:var(--pc-payout)]` follows it. That is the second time
 * the owner has reported this exact figure as too small — the first fix
 * (2026-08-14, `text-sm` -> `text-body-lg`) could never have worked, because the
 * class it added was being thrown away.
 *
 * Eight `cn()` call sites across the app have this shape today. Declaring the
 * scale fixes all of them and stops the next one happening.
 *
 * ★ WHY THE LIST IS SPELLED OUT rather than imported from the Tailwind config:
 * this package cannot import the config (it is a CommonJS file outside the
 * package's own graph), and a wrong-but-silent drift is exactly what this fixes.
 * If a size is added to `fontSize` in `tailwind.config.js`, ADD IT HERE TOO.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const FONT_SIZES = [
  '12', '13', '14', '15', '16', '17', '18', '20', '22', '24', '26', '30', '34', '44', '60',
  'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl',
  'meritum-display', 'caption', 'body-sm', 'body', 'body-lg', 'read', 'lede', 'heading',
  'stat', 'title', 'display', 'hero', 'micro', 'label', 'label-lg'
];

const twMerge = extendTailwindMerge({
  classGroups: {
    'font-size': [{ text: FONT_SIZES }]
  }
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export const blockGap = (
  head_block: number,
  last_block: number,
  t: TFunction<'common_wallet', undefined>
) => {
  if (!last_block || last_block < 1) return 'forever';
  const secs = (head_block - last_block) * 3;
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (secs < 60) return t('witnesses_page.bock_gap.just_now');
  if (secs < 120) return t('witnesses_page.bock_gap.recently');
  if (mins < 120) return mins + t('witnesses_page.bock_gap.mins_ago');
  if (hrs < 48) return hrs + t('witnesses_page.bock_gap.hrs_ago');
  if (days < 14) return days + t('witnesses_page.bock_gap.days_ago');
  if (weeks < 4) return weeks + t('witnesses_page.bock_gap.weeks_ago');
  if (months < 24) return months + t('witnesses_page.bock_gap.months_ago');
  return years + t('witnesses_page.bock_gap.years_ago');
};

// BUG FIXED (was `/\\B.../`): a regex LITERAL only needs `\B` (zero-width
// non-boundary) — `\\B` matches a literal backslash-then-"B", which never
// occurs in a numeric string, so `.replace()` found nothing and every
// caller (wallet balances, HP on both the legacy and redesigned profile,
// the post-hover HP popover) silently rendered ungrouped digits, e.g. HP
// "63241" instead of "63,241". This is the shared thousands-separator
// helper for the whole app — grep call sites before ever touching this
// regex again, and add a test if you do.
export const numberWithCommas = (x: string) => x.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function convertToHP(
  vests: Big | NaiAsset,
  chain: HiveChain,
  totalVestingShares: NaiAsset,
  totalVestingFundHive: NaiAsset,
  div: number = 1
): Big {
  // Convert Big to NaiAsset if needed
  let vestsAsNai: NaiAsset;
  if ('nai' in vests) {
    vestsAsNai = vests;
  } else {
    // Convert Big to satoshis (multiply by 10^precision)
    const vestsPrecision = getPrecision(EAssetName.VESTS);
    const satoshis = vests.times(Big(10).pow(vestsPrecision)).toFixed(0);
    vestsAsNai = chain.vestsSatoshis(satoshis);
  }

  // Use wax's vestsToHp for the conversion
  const hpAsset = chain.vestsToHp(vestsAsNai, totalVestingFundHive, totalVestingShares);

  // Convert NaiAsset back to Big and apply divisor
  const hpBig = Big(hpAsset.amount).div(Big(10).pow(hpAsset.precision));
  return hpBig.div(div);
}

export function powerdownHive(
  accountData: FullAccount,
  dynamicData: GetDynamicGlobalPropertiesResponse,
  chain: HiveChain
): Big {
  const withdrawRateVests = convertStringToBig(accountData.vesting_withdraw_rate).toNumber();
  const toWithdraw =
    typeof accountData.to_withdraw === 'number'
      ? accountData.to_withdraw
      : parseFloat(String(accountData.to_withdraw));
  const withdrawn =
    typeof accountData.withdrawn === 'number'
      ? accountData.withdrawn
      : parseFloat(String(accountData.withdrawn));
  const remainingVests = (toWithdraw - withdrawn) / 1000000;
  const vests = Math.min(withdrawRateVests, remainingVests);

  // Convert vests to NaiAsset and use wax for conversion
  const vestsPrecision = getPrecision(EAssetName.VESTS);
  const satoshis = Math.floor(vests * Math.pow(10, vestsPrecision)).toString();
  const vestsAsNai = chain.vestsSatoshis(satoshis);

  const hpAsset = chain.vestsToHp(
    vestsAsNai,
    dynamicData.total_vesting_fund_hive,
    dynamicData.total_vesting_shares
  );

  return Big(hpAsset.amount).div(Big(10).pow(hpAsset.precision));
}

export function findAndParseJSON(value: string) {
  const valueJSON = value.slice(value.indexOf('{'), value.lastIndexOf('}') + 1);
  return JSON.parse(valueJSON);
}

export function isJSON(value: string) {
  try {
    JSON.parse(value);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Return cookie value for given cookie name. For use on client only.
 * When cookie doesn't exist returns empty string.
 *
 * @param name - Cookie name
 * @returns Cookie value or empty string if not found
 */
export const getCookie = (name: string): string => {
  if (typeof document === 'undefined') return '';
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop()?.split(';').shift() ?? '';
  return '';
};

/**
 * Checks if a string is a valid Hive community identifier.
 * Matches hivemind's validation: ^hive-[123]\d{4,6}$
 * Community names have 5-7 digits after 'hive-', first digit must be 1, 2, or 3.
 *
 * @param value - The string to check (can be undefined)
 * @returns true if the string is a valid community identifier, false otherwise
 *
 * @example
 * isCommunity('hive-123456')  // true (6 digits, starts with 1)
 * isCommunity('hive-12345')   // true (5 digits, starts with 1)
 * isCommunity('hive-1234567') // true (7 digits, starts with 1)
 * isCommunity('hive-999999')  // false (first digit must be 1/2/3)
 * isCommunity('hive-1234')    // false (too few digits)
 * isCommunity(undefined)      // false
 */
export function isCommunity(value: string | undefined | null): boolean {
  if (!value) return false;
  return /^hive-[123]\d{4,6}$/.test(value);
}
