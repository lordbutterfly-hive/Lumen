import type {
  FullAccount,
  AccountFollowStats,
  IVote,
  IVoteListItem,
  IFeedHistory,
  Community,
  IAccountNotification,
  IFollow,
  IFollowList,
  FollowListType,
  IWitness,
  IListWitnessVotes,
  IUnreadNotifications,
  Entry
} from '@hive/common-hiveio-packages/wax';
import type { GetDynamicGlobalPropertiesResponse, NaiAsset } from '@hiveio/wax';
import Big from 'big.js';

/**
 * ★★★ SHARED GATEWAY FOR EVERY BROWSER CHAIN READ THAT WAS MOVED SERVER-SIDE
 * (2026-08-12). See `/api/account/route.ts` for the rule this whole file is an
 * instance of: `getChain()` INSTANTIATES `@hiveio/wax` at runtime, which
 * fetches `wax.common.wasm` (2.34 MB) the moment the chain client is
 * CONSTRUCTED — so any of these reads, called directly from a `'use client'`
 * component or hook, downloaded the whole thing.
 *
 * Every function here is a thin `fetch()` against the matching `/api/*`
 * route, which does the exact same chain call the client used to do, just on
 * the server. Deliberately ONE file rather than duplicating a `fetchX`
 * wrapper per consumer (the earlier fixes to `topics.tsx` and `app-
 * header.tsx` each define their own local wrapper because each is used from
 * exactly one place; several of the reads below — account, communities,
 * notifications — are each called from three or more independent
 * components, so a shared module is what the project's own DRY rule in
 * CLAUDE.md asks for here).
 *
 * Every route behind these is `private, no-store` — see each route file for
 * why caching was deliberately left for a later pass.
 */

async function fetchJson<T>(url: string, errorLabel: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    // ★ CARRY THE ROUTE'S OWN CODE (2026-09-05). Routes answer `{ error: 'search_timeout' }`
    // and the like precisely so a caller can tell a deterministic failure from a blip;
    // dropping the body here had left `search-results.tsx`'s retry predicate matching
    // a message that never contained what it looked for. Read once, best effort.
    let code = '';
    try {
      const body = (await res.json()) as { error?: unknown } | null;
      if (body && typeof body.error === 'string') code = body.error;
    } catch {
      /* not JSON, nothing to add */
    }
    throw new Error(`${errorLabel} request failed: HTTP ${res.status}${code ? ` (${code})` : ''}`);
  }
  return (await res.json()) as T;
}

export function fetchAccount(username: string): Promise<FullAccount> {
  return fetchJson(`/api/account?username=${encodeURIComponent(username)}`, 'account');
}

/** Matches the unexported `Manabar` shape `packages/transaction/lib/hive-api.ts` returns. */
export interface ManabarReading {
  max: string;
  current: string;
  percentageValue: number;
  cooldown: Date;
}
export interface ManabarSet {
  upvote: ManabarReading;
  downvote: ManabarReading;
  rc: ManabarReading;
}
/** The wire shape: identical to `ManabarReading` except `cooldown` travels as an ISO string over JSON. */
type ManabarReadingWire = Omit<ManabarReading, 'cooldown'> & { cooldown: string };
interface ManabarSetWire {
  upvote: ManabarReadingWire;
  downvote: ManabarReadingWire;
  rc: ManabarReadingWire;
}
export async function fetchManabar(username: string): Promise<ManabarSet | null> {
  const wire = await fetchJson<ManabarSetWire | null>(
    `/api/manabar?username=${encodeURIComponent(username)}`,
    'manabar'
  );
  // `cooldown` is a real `Date` in the pre-fix return type (every consumer, e.g.
  // `hoursAndMinutes()` in `lib/utils.ts`, expects one) — JSON has no Date type,
  // so it crosses the wire as an ISO string and is reinflated here, once, rather
  // than pushing `new Date(...)` onto every call site.
  if (!wire) return null;
  const reinflate = (r: ManabarReadingWire): ManabarReading => ({ ...r, cooldown: new Date(r.cooldown) });
  return { upvote: reinflate(wire.upvote), downvote: reinflate(wire.downvote), rc: reinflate(wire.rc) };
}

export function fetchFollowCount(username: string): Promise<AccountFollowStats> {
  return fetchJson(`/api/follow-count?username=${encodeURIComponent(username)}`, 'follow count');
}

export function fetchActiveVotes(author: string, permlink: string): Promise<IVote[]> {
  return fetchJson(
    `/api/active-votes?author=${encodeURIComponent(author)}&permlink=${encodeURIComponent(permlink)}`,
    'active votes'
  );
}

export function fetchDynamicGlobalProperties(): Promise<GetDynamicGlobalPropertiesResponse> {
  return fetchJson('/api/dynamic-global-properties', 'dynamic global properties');
}

export function fetchFeedHistory(): Promise<IFeedHistory> {
  return fetchJson('/api/feed-history', 'feed history');
}

export function fetchCommunities(sort: string, query: string | null, observer: string): Promise<Community[] | null> {
  const params = new URLSearchParams({ sort, observer });
  if (query) params.set('query', query);
  return fetchJson(`/api/communities?${params.toString()}`, 'communities');
}

export function fetchCommunity(name: string, observer: string): Promise<Community | null> {
  const params = new URLSearchParams({ name, observer });
  return fetchJson(`/api/community?${params.toString()}`, 'community');
}

export function fetchCommunitySubscribers(community: string): Promise<string[][] | null> {
  return fetchJson(`/api/community/subscribers?community=${encodeURIComponent(community)}`, 'community subscribers');
}

export function fetchSubscriptions(account: string): Promise<string[][] | null> {
  return fetchJson(`/api/subscriptions?account=${encodeURIComponent(account)}`, 'subscriptions');
}

/**
 * The account-notifications *count*, not the list — backs the header bell's
 * badge. Same route `app-header.tsx` fixed first (`/api/notifications/
 * unread`); shared here so `retention-nudge.tsx`'s independent call site uses
 * the identical fetcher instead of a second hand-written copy.
 */
export function fetchUnreadNotifications(account: string): Promise<IUnreadNotifications> {
  return fetchJson(`/api/notifications/unread?account=${encodeURIComponent(account)}`, 'unread notifications');
}

export function fetchAccountNotifications(
  account: string,
  lastId: number | null = null,
  limit = 50
): Promise<IAccountNotification[] | null> {
  const params = new URLSearchParams({ account, limit: String(limit) });
  if (lastId) params.set('lastId', String(lastId));
  return fetchJson(`/api/notifications/account?${params.toString()}`, 'account notifications');
}

export type AccountExistsResult =
  | { validFormat: false; status: 'not_found' }
  | { validFormat: true; status: 'exists'; data: FullAccount }
  | { validFormat: true; status: 'not_found' }
  | { validFormat: true; status: 'api_error'; error: string };

export function fetchAccountExists(name: string): Promise<AccountExistsResult> {
  return fetchJson(`/api/account-exists?name=${encodeURIComponent(name)}`, 'account exists');
}

export function fetchPostStatus(
  author: string,
  permlink: string,
  observer: string
): Promise<{ post: unknown | null }> {
  const params = new URLSearchParams({ author, permlink });
  if (observer) params.set('observer', observer);
  return fetchJson(`/api/post-status?${params.toString()}`, 'post status');
}

/**
 * `getPost`, typed — same `/api/post-status` route `fetchPostStatus` above
 * already hits (deliberately reused rather than adding a second route for the
 * same `bridge.get_post` call), unwrapped to the bare `Entry | null` shape
 * `getPost` itself returned. `content.tsx`'s main `postData` query (the
 * highest-traffic read in the app) called `getPost` directly — the one call
 * on that page the sibling `crossPostData`/`fetchPostStatus` fix (2026-08-12)
 * did not reach, because it has `initialData` and does not download the WASM
 * on the FIRST render. It still called `getPost` — i.e. `getChain()` — from
 * the browser on every later refetch (`staleTime: MEDIUM` expiring, a window
 * refocus, or the SSR-observer-race key change the `communityData` query
 * right below it is already documented for), so it is fixed the same way as
 * every other read in this file, not left resting on "the fast path happens
 * not to hit it."
 */
export async function fetchPost(author: string, permlink: string, observer: string): Promise<Entry | null> {
  const { post } = await fetchPostStatus(author, permlink, observer);
  return (post as Entry | null) ?? null;
}

export function fetchCommunityRoles(community: string): Promise<string[][] | null> {
  return fetchJson(`/api/community-roles?community=${encodeURIComponent(community)}`, 'community roles');
}

/** One account's row in one community, reduced server-side. See the route. */
export interface CommunityRoleOfAccount {
  account: string;
  role: string | null;
  title: string | null;
}
/**
 * ★ THE POST PAGE ASKS ONE QUESTION, NOT FOR THE LIST (2026-08-13). Its only use
 * of community roles is "may this viewer moderate here", which it computed by
 * downloading every role row in the community and searching it in the browser —
 * 593 rows for `hive-141359`, measured — to produce one boolean. The reduction
 * belongs on the side that already holds the list. `fetchCommunityRoles` above is
 * unchanged and still backs `/roles/[tag]`, which genuinely renders the table.
 */
export function fetchCommunityRoleOfAccount(
  community: string,
  account: string
): Promise<CommunityRoleOfAccount> {
  const params = new URLSearchParams({ community, account });
  return fetchJson(`/api/community-roles?${params.toString()}`, 'community role');
}

/** Matches `WitnessRow` (`features/witnesses/lib/types.ts`) except `hpVotes` travels as a string — see the route. */
type WitnessRowWire<T> = Omit<T, 'hpVotes'> & { hpVotes: string };
export interface WitnessesPageData<TRow> {
  rows: TRow[];
  headBlock: number;
  hpAprPercent: number | null;
  hbdInterestRatePercent: number | null;
  witnessCount: number;
}
/**
 * The combined `/witnesses` page fetch — see
 * `apps/blog/app/api/witnesses-page/route.ts` for why this bundles four
 * former chain reads (dgp, witness list, account batch, and the
 * chain-instance math `buildWitnessRows` needs) into one request. Generic
 * over the exact `WitnessRow` shape so this file does not have to import
 * `features/witnesses/lib/types.ts` just for one type parameter.
 */
export async function fetchWitnessesPage<TRow extends { hpVotes: Big }>(): Promise<WitnessesPageData<TRow>> {
  const wire = await fetchJson<WitnessesPageData<WitnessRowWire<TRow>>>('/api/witnesses-page', 'witnesses page');
  return { ...wire, rows: wire.rows.map((row) => ({ ...row, hpVotes: Big(row.hpVotes) })) as TRow[] };
}

export function fetchWitnessVotes(username: string, limit: number, order: string): Promise<IListWitnessVotes> {
  const params = new URLSearchParams({ username, limit: String(limit), order });
  return fetchJson(`/api/witness-votes?${params.toString()}`, 'witness votes');
}

export interface SearchParams {
  pattern: string;
  sort?: string;
  author?: string;
  observer?: string;
  start_author?: string;
  start_permlink?: string;
  limit?: number;
}
/** Mirrors `SearchSuggestions` in `lib/search/suggest-rank.ts` (server); duplicated as a wire type so this browser module imports no server code. */
export interface SearchSuggestionsWire {
  accounts: Array<{ name: string; kind: 'hive' | 'lite'; displayName?: string }>;
  tags: string[];
}
/**
 * The header typeahead. `signal` is React Query's per-query AbortSignal, so a
 * request for "phot" is cancelled the moment "photo" supersedes it, instead of
 * both landing and the older one painting last.
 */
export function fetchSearchSuggestions(query: string, signal?: AbortSignal): Promise<SearchSuggestionsWire> {
  return fetchJson(`/api/search/suggest?q=${encodeURIComponent(query)}`, 'search suggestions', { signal });
}

/** Mirrors `PersonResult` in `lib/search/people.ts` (server). */
export interface SearchPersonWire {
  name: string;
  kind: 'hive' | 'lite';
  displayName: string;
  about: string;
  reputation: number | null;
  postCount: number | null;
  followers: number | null;
}
export function fetchSearchPeople(query: string, mode: 'prefix' | 'topic'): Promise<SearchPersonWire[]> {
  const params = new URLSearchParams({ q: query, mode });
  return fetchJson(`/api/search/people?${params.toString()}`, 'search people');
}

export function fetchSearch(search: SearchParams): Promise<Entry[]> {
  const params = new URLSearchParams({ pattern: search.pattern });
  if (search.sort) params.set('sort', search.sort);
  if (search.author) params.set('author', search.author);
  if (search.observer) params.set('observer', search.observer);
  if (search.start_author) params.set('start_author', search.start_author);
  if (search.start_permlink) params.set('start_permlink', search.start_permlink);
  if (search.limit) params.set('limit', String(search.limit));
  return fetchJson(`/api/search?${params.toString()}`, 'search');
}

export interface FollowListParams {
  account: string;
  start?: string | null;
  type?: string;
  limit?: number;
}
function followParams(p: FollowListParams): URLSearchParams {
  const params = new URLSearchParams({ account: p.account });
  if (p.start) params.set('start', p.start);
  if (p.type) params.set('type', p.type);
  if (p.limit) params.set('limit', String(p.limit));
  return params;
}
export function fetchFollowers(params: FollowListParams): Promise<IFollow[]> {
  return fetchJson(`/api/followers?${followParams(params).toString()}`, 'followers');
}
export function fetchFollowing(params: FollowListParams): Promise<IFollow[]> {
  return fetchJson(`/api/following?${followParams(params).toString()}`, 'following');
}

/**
 * `bridge.get_follow_list` (mute/blacklist), not `condenser_api.get_following`
 * (`fetchFollowing` above) — a different relationship, same shared-gateway
 * reasoning. See `apps/blog/app/api/follow-list/route.ts`; this was the one
 * read behind `useModerationStatus`/`use-follow-list.tsx` that ~33 sibling
 * reads already had a server route for and this one did not.
 */
export function fetchFollowList(observer: string, type: FollowListType): Promise<IFollowList[]> {
  const params = new URLSearchParams({ observer, type });
  return fetchJson(`/api/follow-list?${params.toString()}`, 'follow list');
}

/**
 * "Has `voter` already voted on this exact post/comment" — the read behind
 * every vote button's initial state (`votes-component.tsx`) and the
 * post-broadcast confirmation poll (`use-vote-mutation.ts`). See
 * `apps/blog/app/api/comment-vote/route.ts`. Always `limit: 1` server-side —
 * both callers only ever check one voter against one post, never paginate.
 */
export function fetchListVotesByCommentVoter(
  author: string,
  permlink: string,
  voter: string
): Promise<{ votes: IVoteListItem[] }> {
  return queueCommentVote(author, permlink, voter);
}

/**
 * ★★★ COALESCED INTO ONE REQUEST (2026-08-13). Measured signed-in on
 * `/@lordbutterfly`: **19 `/api/comment-vote` requests on one page load**,
 * 400-590ms each, one per rendered post — every `VotesComponent` on a feed,
 * profile tab or comment thread mounts and asks for its own card. The browser
 * serialises them behind its per-host connection limit, which is what put the
 * last request on that page 12.7 seconds after the click.
 *
 * Every caller keeps its own `useQuery` and its own cache entry — nothing above
 * this line changes. What changes is that the requests LEAVE together: calls
 * landing in the same tick are collected and sent to `/api/comment-vote/bulk`
 * as one round trip, and each caller's promise is settled from the batch.
 *
 * The flush is a `setTimeout(0)`, not a microtask: React mounts the cards across
 * a render pass, and a microtask would fire between them and send batches of one.
 *
 * Batches are per-voter (a batch is always one viewer's own vote state) and are
 * chunked to the route's own `MAX_TARGETS`, so a very long thread sends two
 * requests rather than silently losing the tail.
 *
 * No fallback to the single-item route on failure, deliberately: the bulk route
 * never throws for an individual target (it reports that one as "no vote"), so
 * the only way this rejects is a total request failure — which would equally have
 * failed all 19 individual requests.
 */
interface PendingCommentVote {
  author: string;
  permlink: string;
  resolve: (value: { votes: IVoteListItem[] }) => void;
  reject: (reason: unknown) => void;
}

const COMMENT_VOTE_BATCH_MAX = 100; // mirrors MAX_TARGETS in app/api/comment-vote/bulk/route.ts
const pendingCommentVotes = new Map<string, PendingCommentVote[]>();
let commentVoteFlushScheduled = false;

function queueCommentVote(
  author: string,
  permlink: string,
  voter: string
): Promise<{ votes: IVoteListItem[] }> {
  return new Promise((resolve, reject) => {
    const queue = pendingCommentVotes.get(voter) ?? [];
    queue.push({ author, permlink, resolve, reject });
    pendingCommentVotes.set(voter, queue);

    if (commentVoteFlushScheduled) return;
    commentVoteFlushScheduled = true;
    setTimeout(() => {
      commentVoteFlushScheduled = false;
      const batches = [...pendingCommentVotes];
      pendingCommentVotes.clear();
      for (const [batchVoter, waiting] of batches) {
        for (let i = 0; i < waiting.length; i += COMMENT_VOTE_BATCH_MAX) {
          void flushCommentVotes(batchVoter, waiting.slice(i, i + COMMENT_VOTE_BATCH_MAX));
        }
      }
    }, 0);
  });
}

async function flushCommentVotes(voter: string, waiting: PendingCommentVote[]): Promise<void> {
  const params = new URLSearchParams({
    voter,
    targets: JSON.stringify(waiting.map((w) => [w.author, w.permlink]))
  });
  try {
    const body = await fetchJson<{ votes: Record<string, IVoteListItem | null> }>(
      `/api/comment-vote/bulk?${params.toString()}`,
      'comment vote'
    );
    for (const w of waiting) {
      const vote = body.votes?.[`${w.author.toLowerCase()}/${w.permlink}`] ?? null;
      // Same shape the single-item route returns, so callers are unchanged.
      w.resolve({ votes: vote ? [vote] : [] });
    }
  } catch (error) {
    for (const w of waiting) w.reject(error);
  }
}

export function fetchRebloggedBy(author: string, permlink: string): Promise<string[]> {
  return fetchJson(
    `/api/reblogged-by?author=${encodeURIComponent(author)}&permlink=${encodeURIComponent(permlink)}`,
    'reblogged by'
  );
}

/**
 * See `apps/blog/app/api/vests-to-hp/route.ts` for why this reuses the exact
 * `convertToHP` computation server-side rather than reimplementing the ratio
 * here. `totalVestingFundHive`/`totalVestingShares` travel as opaque JSON —
 * whatever shape `getDynamicGlobalProperties()` returned — and are reflected
 * straight back into the same `convertToHP` call the client used to make.
 */
export async function fetchVestsToHp(
  vests: Big,
  totalVestingShares: NaiAsset,
  totalVestingFundHive: NaiAsset
): Promise<Big> {
  const params = new URLSearchParams({
    vests: vests.toString(),
    totals: JSON.stringify({ totalVestingFundHive, totalVestingShares })
  });
  const hpString = await fetchJson<string>(`/api/vests-to-hp?${params.toString()}`, 'vests to HP');
  return Big(hpString);
}

export interface ProposalVotersResponse {
  /** Real, uncapped voter count — for the dialog's title, independent of how many `voters` rows came back. */
  total: number;
  /** Sorted descending by HP, capped server-side — see `app/api/proposal-votes/route.ts`. */
  voters: { voter: string; hp: number }[];
}

export function fetchProposalVoters(proposalId: number): Promise<ProposalVotersResponse> {
  return fetchJson(`/api/proposal-votes?proposalId=${proposalId}`, 'proposal voters');
}
