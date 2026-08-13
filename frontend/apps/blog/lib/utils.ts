import sanitize from 'sanitize-html';
import remarkableStripper from '../lib/remmarkable-stripper';
import { Entry, JsonMetadata, FullAccount } from '@hive/common-hiveio-packages/wax';
import dayjs from 'dayjs';
import { TFunction } from 'i18next';
import { proxifyImageSrc, Symbol, accountReputation } from '@hive/ui';
import { convertStringToBig, formatNaiAsset } from '@ui/lib/helpers';

// Re-export Symbol and accountReputation for backwards compatibility
export { Symbol, accountReputation };
// NaiMap is replaced by NaiToSymbol from @hive/ui

export const DEFAULT_OBSERVER = 'hive.blog';

/**
 * ★★★ THE CHAIN `observer` FOR THE CURRENT VIEWER — NEVER A LITE ACCOUNT.
 *
 * `observer` personalises Hive reads (have I voted this, do I follow them, am I
 * subscribed) and only means anything for a REAL chain account. A Lumen lite
 * handle has no chain account at all, so passing it makes the node answer
 * `Account <name> does not exist` — and it was being passed from TWELVE places,
 * each written as the same unguarded `user.isLoggedIn ? user.username : …`.
 *
 * The server-side equivalent (`getObserver` in lib/auth-utils.ts) has always
 * refused a lite account, citing spec §A.5 as a must-fix. The client never got
 * the same rule, which is why an upvote could show a red "Error" toast on top
 * of its own success: the vote itself worked, and `bridge.get_community` /
 * `bridge.get_follow_list` alongside it did not.
 *
 * One function so the rule lives in one place, and so the next person who needs
 * an observer cannot accidentally reintroduce this.
 */
export function chainObserver(user: {
  isLoggedIn?: boolean;
  username?: string;
  account_tier?: string;
}): string {
  if (!user?.isLoggedIn || !user.username) return DEFAULT_OBSERVER;
  if (user.account_tier === 'lite') return DEFAULT_OBSERVER;
  return user.username;
}
export type SortTypes = 'trending' | 'hot' | 'created' | 'payout' | 'muted';

export interface Preferences {
  nsfw: 'hide' | 'warn' | 'show';
  blog_rewards: '0%' | '50%' | '100%';
  comment_rewards: '0%' | '50%' | '100%';
  referral_system: 'enabled' | 'disabled';
}

export const DEFAULT_PREFERENCES: Preferences = {
  nsfw: 'warn',
  blog_rewards: '50%',
  comment_rewards: '50%',
  referral_system: 'enabled'
};

export type sortTypes = 'trending' | 'hot' | 'created' | 'payout' | 'muted';
export const sortToTitle = (sort: sortTypes) => {
  switch (sort) {
    case 'trending':
      return 'Trending';
    case 'hot':
      return 'Hot';
    case 'created':
      return 'New';
    case 'payout':
      return 'Pending';
    case 'muted':
      return 'Muted';
    default:
      return 'Trending';
  }
};

export const debounce = (fn: Function, delay: number) => {
  let timer: ReturnType<typeof setTimeout>;
  return function (...args: any[]) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
    }, delay);
  };
};

export function extractBodySummary(body: string, stripQuotes = false) {
  let desc = body;

  if (stripQuotes) desc = desc.replace(/(^(\n|\r|\s)*)>([\s\S]*?).*\s*/g, '');
  return normalizeExcerpt(desc);
}

/**
 * ★ SHARED TAIL, FACTORED OUT OF `extractBodySummary` (O6 build map item 2,
 * 2026-08-13). Previously this pipeline (markdown -> plain text -> entity
 * decode -> truncate) only ran on the body-fallback path. A post whose
 * `json_metadata.description` is PRESENT skipped all of it — `getPostSummary`
 * returned that field verbatim, raw entities and all (`&#039;`, unrendered
 * `<i class=…>`/`![](…)` from a third-party posting client). Proven live on
 * `/search`: the same post's dek showed `don&#039;t stop…![](https://…)` while
 * a post with no `description` at all rendered clean, through this exact
 * function.
 *
 * Text only — the result is safe to render as a JSX text child (React escapes
 * on render) but must never be handed to `dangerouslySetInnerHTML`.
 */
export function normalizeExcerpt(text: string): string {
  let desc = remarkableStripper.render(text); // render markdown to html
  desc = sanitize(desc, { allowedTags: [] }); // remove all html, leaving text
  desc = htmlDecode(desc);

  // Strip any raw URLs from preview text
  desc = desc.replace(/https?:\/\/[^\s]+/g, '');

  // Grab only the first line (not working as expected. does rendering/sanitizing strip newlines?)
  // eslint-disable-next-line prefer-destructuring
  desc = desc.trim().split('\n')[0];

  if (desc.length > 200) {
    desc = desc.substring(0, 200).trim();

    // Truncate, remove the last (likely partial) word (along with random punctuation), and add ellipses
    desc = desc
      .substring(0, 180)
      .trim()
      .replace(/[,!?]?\s+[^\s]+$/, '…');
  }

  return desc;
}

/**
 * Clean a TITLE for display: decode entities, strip any stray markup, collapse
 * whitespace. Deliberately NOT run through `normalizeExcerpt` — a title is not
 * an excerpt, and must never be truncated or have its "first line only" rule
 * applied.
 *
 * ★ Exported here per the O6 build map so this fix is ready to wire in, but
 * NOT yet applied anywhere: every call site that renders a raw `post.title` /
 * `entry.title` (`medium-post-card.tsx`, `lite-feed-strip.tsx`,
 * `profile-comment-card.tsx`, `[permlink]/content.tsx`) sits outside this
 * agent's owned files — see the delivery report.
 */
export function normalizeTitle(title: string): string {
  const stripped = sanitize(title, { allowedTags: [] });
  return htmlDecode(stripped).replace(/\s+/g, ' ').trim();
}

export function getPostSummary(jsonMetadata: JsonMetadata, body: string, stripQuotes = false) {
  const shortDescription = jsonMetadata?.description ? jsonMetadata?.description : jsonMetadata?.summary;

  if (!shortDescription) {
    return extractBodySummary(body, stripQuotes);
  }

  return normalizeExcerpt(shortDescription);
}

/**
 * Decode HTML entities back to plain text — named (`&rsquo;`) AND numeric,
 * both decimal (`&#39;`) and hex (`&#x27;`). ★ Widened 2026-08-13 (O6 item 2):
 * the previous regex (`/&[a-z]+;/g`) matched named entities only, so the
 * on-chain `&#039;` this bug report was filed against passed straight
 * through untouched. An unrecognised named entity, or a malformed/
 * out-of-range numeric one, is left byte-identical rather than guessed at.
 *
 * Input is UNTRUSTED — any Hive account can write arbitrary bytes into a
 * title or `json_metadata.description` — so a malformed `&#…;` must never
 * throw (`String.fromCodePoint` throws on an out-of-range code point).
 */
export const htmlDecode = (txt: string) =>
  txt.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity: string) => {
    const inner = entity.slice(1, -1);
    if (inner[0] === '#') {
      const isHex = inner[1] === 'x' || inner[1] === 'X';
      const codePoint = parseInt(isHex ? inner.slice(2) : inner.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return entity;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return entity;
      }
    }
    const char = (htmlCharMap as Record<string, string>)[inner.toLowerCase()];
    return char ? char : entity;
  });

const htmlCharMap = {
  amp: '&',
  quot: '"',
  lt: '<',
  gt: '>',
  nbsp: ' ',
  apos: "'",
  // ★ ADDED (O6 item 2) — the exact second entity family the report named:
  // named, and previously absent from this map entirely, so it fell through
  // untouched even though `htmlDecode` was already being called.
  acute: '´',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  hearts: '♥',
  trade: '™',
  hellip: '…',
  pound: '£',
  // ★ FIXED (O6 item 2) — this was `''`: `&copy;` was being DELETED, not
  // decoded, everywhere `extractBodySummary`/`normalizeExcerpt` runs.
  copy: '©'
};

export function amt(string_amount: string) {
  return parsePayoutAmount(string_amount);
}

export function parsePayoutAmount(amount: string) {
  return parseFloat(String(amount).replace(/\s[A-Z]*$/, ''));
}

export function fmt(decimal_amount: number | string, asset = null) {
  return formatDecimal(Number(decimal_amount)).join('') + (asset ? ' ' + asset : '');
}

function fractional_part_len(value: number) {
  const parts = (Number(value) + '').split('.');
  return parts.length < 2 ? 0 : parts[1].length;
}

export function formatDecimal(value: number, decPlaces = 2, truncate0s = true) {
  let fl, j;
  // eslint-disable-next-line no-void,no-restricted-globals
  if (value === null || value === void 0 || isNaN(value)) {
    return ['N', 'a', 'N'];
  }
  if (truncate0s) {
    fl = fractional_part_len(value);
    if (fl < 2) fl = 2;
    if (fl < decPlaces) decPlaces = fl;
  }
  const decSeparator = '.';
  const thouSeparator = ',';
  const sign = value < 0 ? '-' : '';
  const abs_value = Math.abs(value);
  const i = parseInt(abs_value.toFixed(decPlaces), 10) + '';
  j = i.length;
  j = i.length > 3 ? j % 3 : 0;
  // @ts-ignore
  const decPart = decPlaces
    ? decSeparator +
      // @ts-ignore
      Math.abs(abs_value - i)
        .toFixed(decPlaces)
        .slice(2)
    : '';
  return [
    sign +
      (j ? i.substr(0, j) + thouSeparator : '') +
      i.substr(j).replace(/(\d{3})(?=\d)/g, '$1' + thouSeparator),
    decPart
  ];
}

export function extractLinks(text: string): string[] {
  const urlRegex = /https?:\\?\/\\?\/[^\s]+/g;
  const markdownImageRegex = /!\[.*?\]\((https?:\\?\/\\?\/[^\s]+)\)/g;
  const otherUrlRegex = /https?:\/\/[^\s\)]*\/[^\s\)]*/g;
  const matches: string[] = [];
  const otherMatches = text.match(otherUrlRegex);
  if (otherMatches) {
    otherMatches.forEach((match) => {
      matches.push(match);
    });
  }
  const standaloneMatches = text.match(urlRegex);
  if (standaloneMatches) {
    standaloneMatches.forEach((match) => {
      const cleanedMatch = match.endsWith(')') ? match.slice(0, -1) : match;
      matches.push(cleanedMatch);
    });
  }
  const markdownImageMatches = text.match(markdownImageRegex);
  if (markdownImageMatches) {
    markdownImageMatches.forEach((match) => {
      const urlMatch = match.match(/https?:\\?\/\\?\/[^\s]+/);
      if (urlMatch) {
        const cleanedMatch = urlMatch[0].endsWith(')') ? urlMatch[0].slice(0, -1) : urlMatch[0];
        matches.push(cleanedMatch);
      }
    });
  }
  return matches;
}

export function extractPictureFromPostBody(urls: string[]): string[] {
  const picturesRegex = /(?:https?:\/\/)?(?:images\.hive\.blog)\/([a-zA-Z0-9_\/-]+\.(jpeg|png|jpg|webp))/i;

  const picturesFromPostBody: string[] = [];
  for (const url of urls) {
    const match = url.match(picturesRegex);
    if (match && match[1]) {
      picturesFromPostBody.push(proxifyImageSrc(match[0]));
    }
  }

  return picturesFromPostBody;
}

export function hoursAndMinutes(date: Date, t: TFunction<'common_blog', undefined>) {
  const today = dayjs();
  const cooldownMin = dayjs(date).diff(today, 'minute') % 60;
  const cooldownH = dayjs(date).diff(today, 'hour');

  return (
    (cooldownH === 1
      ? t('global.time.an_hour')
      : cooldownH > 1
        ? cooldownH + ' ' + t('global.time.hours')
        : '') +
    (cooldownH && cooldownMin ? ' and ' : '') +
    (cooldownMin === 1
      ? t('global.time.a_minute')
      : cooldownMin > 0
        ? cooldownMin + ' ' + t('global.time.minutes')
        : '')
  );
}

export function getRewardsString(account: FullAccount, t: TFunction<'common_blog', undefined>): string {
  const nothingToClaim = t('global.no_rewards');
  const hiveAmount = convertStringToBig(account.reward_hive_balance);
  const hbdAmount = convertStringToBig(account.reward_hbd_balance);
  const vestingHiveAmount = convertStringToBig(account.reward_vesting_hive);

  const reward_hive = hiveAmount.gt(0) ? formatNaiAsset(account.reward_hive_balance, 'HIVE') : null;
  const reward_hbd = hbdAmount.gt(0) ? formatNaiAsset(account.reward_hbd_balance, 'HBD') : null;
  const reward_hp = vestingHiveAmount.gt(0) ? formatNaiAsset(account.reward_vesting_hive, 'HP') : null;

  const rewards = [];
  if (reward_hive) rewards.push(reward_hive);
  if (reward_hbd) rewards.push(reward_hbd);
  if (reward_hp) rewards.push(reward_hp);

  let rewards_str;
  switch (rewards.length) {
    case 3:
      rewards_str = `${rewards[0]}, ${rewards[1]} and ${rewards[2]}`;
      break;
    case 2:
      rewards_str = `${rewards[0]} and ${rewards[1]}`;
      break;
    case 1:
      rewards_str = `${rewards[0]}`;
      break;
    default:
      rewards_str = nothingToClaim;
  }
  return rewards_str;
}

export function netVests(account: FullAccount) {
  const vests = convertStringToBig(account.vesting_shares);
  const delegated = convertStringToBig(account.delegated_vesting_shares);
  const received = convertStringToBig(account.received_vesting_shares);
  return vests.minus(delegated).plus(received).toNumber();
}

export function compareDates(dateStrings: string[]) {
  const dates = dateStrings.map((dateStr) => dayjs(dateStr));

  const today = dayjs();
  let closestDate = dates[0];
  let minDiff = Math.abs(today.diff(dates[0], 'day'));

  dates.forEach((date) => {
    const diff = Math.abs(date.diff(today, 'day'));
    if (diff < minDiff) {
      minDiff = diff;
      closestDate = date;
    }
  });

  return closestDate.format('YYYY-MM-DDTHH:mm:ss');
}

export const getMutedComments = (list: string[], discussion: Record<string, Entry>) => {
  const filteredByAuthorMuted: Record<string, Entry> = {};
  Object.keys(discussion).map((key) => {
    filteredByAuthorMuted[key] = {
      ...discussion[key],
      stats: {
        flag_weight: discussion[key].stats?.flag_weight ?? 0,
        gray: list.includes(discussion[key].author) ? true : (discussion[key].stats?.gray ?? false),
        hide: discussion[key].stats?.hide ?? false,
        total_votes: discussion[key].stats?.total_votes ?? 0,
        is_pinned: discussion[key].stats?.is_pinned ?? false,
        muted_reasons: discussion[key].stats?.muted_reasons
      }
    };
  });
  return filteredByAuthorMuted;
};
export function extractUrlsFromJsonString(jsonString: string): string[] {
  const urlRegex = /((?:https?:\/\/|www\.)[^\s]+)/g;
  const matches = jsonString.match(urlRegex);
  return matches || [];
}

export function extractYouTubeVideoIds(urls: string[]): string[] {
  const youtubeLinkRegex =
    /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=|embed|shorts\/|v\/)?([a-zA-Z0-9_-]+)/i;

  const youtubeVideoIds: string[] = [];
  for (const url of urls) {
    const match = url.match(youtubeLinkRegex);
    if (match && match[1]) {
      youtubeVideoIds.push(match[1]);
    }
  }
  return youtubeVideoIds;
}
