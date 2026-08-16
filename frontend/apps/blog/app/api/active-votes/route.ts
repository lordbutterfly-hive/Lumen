import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getActiveVotes } from '@transaction/lib/hive-api';
import type { IVote } from '@hive/common-hiveio-packages/wax';
import { litePostIdOf } from '@/blog/lib/lite/render/lite-post-id';
import { getPostById } from '@/blog/lib/lite/repositories/post-repository';
import { getLiteVotersForPost } from '@/blog/lib/lite/repositories/engagement-repository';
import { liteConfig } from '@/blog/lib/lite/config';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `components/hooks/use-active-votes.ts`
 * called `getActiveVotes` directly — it reaches `getChain()` and downloads
 * `wax.common.wasm`. Used to render a post's vote list/count in the browser.
 *
 * NOT CACHED: a post's votes change continuously during its payout window,
 * which is exactly when this is looked at most.
 *
 * ★★★ THE CLIENT'S `author` IS NOT TRUSTED FOR A LUMEN PERMLINK (2026-08-16,
 * QA B2). Reported: `GET ?author=testeraccount&permlink=lumen-01m05…` 502ing
 * TWELVE times per page load, with the raw `active votes request failed: HTTP
 * 502` string landing in an error toast's `<h1>` (see
 * `packages/ui/components/error-toast-content.tsx:30`) and the payout number
 * next to it picking up the toast's destructive red. `testeraccount` is a
 * Lumen DISPLAY name, not a Hive account — Hivemind's `list_votes` has nothing
 * to resolve it to and errors. The caller (`app/[param]/[p2]/[permlink]/
 * content.tsx:170`) builds `author` from the URL's `p2` segment, which on a
 * Lumen-authored post's own on-chain URL IS the display name; the real chain
 * author (the shared publishing account, here `hbd-temp`) sits on
 * `postData.author`/`litePost.chainAuthor` a few lines away and was never
 * consulted. That call site is outside this fix's file list (`features/
 * votes/**`, this route, `lib/lite/**` vote paths, and locales only) — it
 * needs its own, separate client-side fix; see the handoff notes for exactly
 * what.
 *
 * What THIS route can fix on its own, and does: for a Lumen permlink
 * (`lumen-<ulid>` / `lite-<ulid>`), the real on-chain author is recoverable
 * from the PERMLINK ALONE via `lumen_post` — the same trust rule
 * `lib/lite/content/engagement-target.ts` already applies ("the author
 * segment is not allowed to decide"). So `resolveChainAuthor` below ignores
 * whatever the client sent for a Lumen post and looks the real author up
 * itself, which repairs this exact bug server-side regardless of whether the
 * client ever gets fixed. For an ordinary Hive permlink there is no
 * `lumen_post` row and the client's `author` is used exactly as before.
 *
 * ★★★ A CHAIN FAILURE NOW DEGRADES TO A QUIET EMPTY LIST INSTEAD OF A 502
 * (2026-08-16, QA B2 items 2-4). This used to throw the 502 straight at the
 * client. Every consumer found (`components/hooks/use-active-votes.ts`'s
 * `useActiveVotesQuery`, and `content.tsx`'s own inline `useQuery`) uses
 * React Query's untouched defaults — no `retry` override, no
 * `useErrorBoundary` — so a real failure meant up to 3 separate query
 * instances each retrying 3 times with no cap tailored to this endpoint (12
 * requests fits three instances × 4 attempts each), and once retries were
 * exhausted, `onError`/`handleError` turned the thrown Error's message
 * straight into the toast's `<h1>` noted above. Both of those consumers are
 * outside this fix's file list too. Returning `200 []` here instead means
 * `fetch().ok` is true, so `fetchJson` (lib/chain-fetch.ts) never throws in
 * the first place — nothing to retry, nothing for `onError` to hand to a
 * heading, on EVERY caller, without touching any of them. The failure is
 * still logged below so it stays diagnosable; it just never reaches the DOM
 * as an unrecoverable page/toast error for what is, from a reader's chair,
 * "this post shows no votes right now."
 *
 * ★ LUMEN'S OWN VOTES ARE MERGED IN (2026-08-16, QA B2 "IMPORTANT part 2").
 * A lite vote is Lumen-local by design (`lumen_vote` — see
 * `engagement-repository.ts`'s `castVote`) and never reaches Hivemind, so
 * `getActiveVotes` alone always under-counts a post that has lite voters —
 * including, notably, EVERY vote on a lite-authored post from another lite
 * reader. `getLiteVotersForPost` supplies those rows; a lite voter is never
 * double-counted against a chain voter of the same resolved name (dedup
 * below), which matters for an account that has since upgraded and voted
 * again for real.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestedAuthor = (req.nextUrl.searchParams.get('author') ?? '').trim().replace(/^@/, '').toLowerCase();
  const permlink = (req.nextUrl.searchParams.get('permlink') ?? '').trim();
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(requestedAuthor)) {
    return NextResponse.json({ error: 'author_required' }, { status: 400 });
  }
  if (!/^[a-z0-9-]{1,255}$/.test(permlink)) {
    return NextResponse.json({ error: 'permlink_required' }, { status: 400 });
  }

  const author = await resolveChainAuthor(requestedAuthor, permlink);

  // Chain votes: best-effort. A failure here must not blank the whole
  // response — see the doc block above for why "quiet empty" beats a 502.
  let chainVotes: IVote[] = [];
  try {
    chainVotes = await getActiveVotes(author, permlink);
  } catch (error) {
    logger.error(error, 'active votes lookup failed for %s/%s', author, permlink);
  }

  const liteVotes = await safeLiteVotes(author, permlink);
  // Case-insensitive: a lite voter's resolved name (COALESCE(hive_account_name,
  // display_name) — see getLiteVotersForPost) can carry the display_name's
  // original casing, while a chain voter name is always lowercase.
  const chainVoters = new Set(chainVotes.map((v) => v.voter.toLowerCase()));
  const votes = [...chainVotes, ...liteVotes.filter((v) => !chainVoters.has(v.voter.toLowerCase()))];

  return NextResponse.json(votes, { headers: { 'cache-control': 'private, no-store' } });
}

/**
 * The real on-chain author for a Lumen post, resolved from its PERMLINK
 * alone. Returns `requestedAuthor` unchanged for anything that is not one of
 * ours (no `lumen_post` row), or if the lite backend is unavailable/unwired —
 * same "never worse than before" posture as `mergeLumenEngagement`.
 */
async function resolveChainAuthor(requestedAuthor: string, permlink: string): Promise<string> {
  if (!liteConfig.enabled || !liteConfig.databaseUrl) return requestedAuthor;
  const postId = litePostIdOf({ permlink });
  if (!postId) return requestedAuthor;
  try {
    const row = await getPostById(postId);
    if (row?.hiveAuthor && row.hivePermlink && row.hivePermlink.toLowerCase() === permlink) {
      return row.hiveAuthor.toLowerCase();
    }
  } catch (error) {
    logger.warn('active-votes: could not resolve Lumen post author for %s: %o', permlink, error);
  }
  return requestedAuthor;
}

/** Lumen-local voters, shaped as `IVote`. Never throws — see doc block above. */
async function safeLiteVotes(author: string, permlink: string): Promise<IVote[]> {
  if (!liteConfig.enabled || !liteConfig.databaseUrl) return [];
  try {
    const voters = await getLiteVotersForPost(author, permlink);
    return voters.map((v) => ({
      voter: v.voter,
      percent: v.weight,
      weight: v.weight,
      // A lite vote earns no curation reward (lite posts decline all
      // rewards) — magnitude is deliberately near-zero rather than 0 exactly,
      // so a post with ONLY lite votes still gets a nonzero `voteRshares` sum
      // in `prepareVotes` (packages/ui/lib/utils.ts) instead of a 0/0 divide.
      // The sign still carries the up/down direction every consumer reads
      // (`vote-tallies.ts`'s `splitTally`, the voters popover's `[-]` marker).
      rshares: v.weight > 0 ? 1 : v.weight < 0 ? -1 : 0,
      reputation: 0,
      time: v.updatedAt
    }));
  } catch (error) {
    logger.warn('active-votes: could not merge Lumen votes for %s/%s: %o', author, permlink, error);
    return [];
  }
}
