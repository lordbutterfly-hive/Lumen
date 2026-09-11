import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireActiveLiteUser } from '@/blog/lib/lite/http/actor';
import { listRecentFollowersWithTime } from '@/blog/lib/lite/repositories/follow-repository';
import { findUsersByIds } from '@/blog/lib/lite/repositories/user-repository';
import * as dmMessages from '@/blog/lib/lite/repositories/dm-message-repository';
import { viewerBlockedKeySet } from '@/blog/lib/lite/social/block-filter';
import { actorKey } from '@/blog/lib/lite/social/follow-actor';
import { listByUser } from '@/blog/lib/lite/repositories/credential-repository';
import { walletDid } from '@/blog/lib/lite/wallet/did-pkh';

/**
 * ★★★ SOMEBODY BOUGHT YOUR MERITUM (2026-09-11, owner's request).
 *
 * A buy is a CHAIN event, so it is not in the Lumen DB beside follows and DMs —
 * but it belongs in the same bell, and this is the route that already merges the
 * non-chain half of it. The Magi indexer parses the contract's own `bought` log
 * into `lumen_ct_bought_events` (creator, actor, minted, cost, ts), so the rows
 * are read from there rather than by replaying contract outputs.
 *
 * SERVER-SIDE, not from the browser: the creator identity a buy is keyed by is
 * the CONTRACT's account id, and deciding which ids belong to this reader is an
 * auth question. Doing it here means the client is never trusted to say whose
 * token it is — the same reason the follow and DM halves resolve their actor
 * from the session rather than the query string.
 */
const INDEXER_URL = process.env.REACT_APP_CREATOR_TOKENS_INDEXER_URL?.replace(/\/+$/, '');
const CONTRACT_ID = process.env.REACT_APP_CREATOR_TOKENS_CONTRACT_ID;
/** HBD carries 3 decimals; the indexer stores base units as strings. */
const hbd = (baseUnits: string): number => Number(baseUnits || '0') / 1000;

interface BoughtRow {
  creator: string;
  actor: string;
  minted: string;
  total_due: string;
  indexer_ts: string;
}

/**
 * Every contract account id this reader owns a market under. A full Hive session
 * is `hive:<username>` — proven by signature at login. A lite session owns
 * whatever `did:pkh` its bound wallets produce, because a wallet identity
 * registers its market under its OWN did (use-live-studio.ts's `creatorAccount`).
 */
async function creatorKeysFor(actor: { userId?: string; hive?: string }): Promise<string[]> {
  if (actor.hive) return [`hive:${actor.hive}`];
  if (!actor.userId) return [];
  const creds = await listByUser(actor.userId).catch(() => []);
  return creds.map((c) => walletDid(c.method, c.externalRef, c.network)).filter((d): d is string => !!d);
}

const logger = getLogger('app');

/**
 * ★★★ LUMEN-NATIVE NOTIFICATIONS — currently, new followers.
 *
 * WHY THIS EXISTS (2026-08-09, tester BASELINE-03). The bell had exactly one
 * data source, `bridge.account_notifications`, which is the CHAIN. A Lumen
 * follow is never written to chain, so gaining a follower produced silence: the
 * tester followed identity A from identity B, watched the button flip to
 * "Following", and A's bell still read "No notifications yet" — before and
 * after, identically.
 *
 * That is not only a lite-account problem. A full Hive account followed by a
 * lite reader is equally invisible, because the bell cannot see Lumen at all.
 *
 * WHAT THIS DELIBERATELY IS NOT: a general notification system. Votes, reblogs
 * and replies are not here. Follows are the case the tester proved silent, they
 * are derivable from data we already keep exactly, and shipping the one real
 * thing beats a table of speculative event types nobody emits yet. When votes
 * and replies need it, they get the same treatment — read from the rows that
 * already record them, rather than a second copy that can disagree.
 *
 * "No notifications yet" is also a promise of "eventually", and for this whole
 * class of event it was false. Now it is only shown when it is true.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  // A caller may ask about a HIVE account they are signed in as; a lite caller
  // is resolved from its own session. Either way the answer is about the
  // authenticated reader — never an arbitrary name from the query string, which
  // would make one person's follower list readable by anyone.
  const hiveParam = (req.nextUrl.searchParams.get('hive') ?? '').trim().replace(/^@/, '');

  let actor: { userId?: string; hive?: string } | null = null;
  // Hoisted so the block-list lookup below can key on the SAME session that
  // established the actor, rather than re-reading the cookie.
  let sessionUser: Awaited<ReturnType<typeof getLiteSession>>['user'] | undefined;
  try {
    const session = await getLiteSession();
    sessionUser = session.user;
    const u = session.user;
    // ★★★ AUTH-01 / CHAIN-03 FIX (2026-09-08): APPLY THE SAME LITE-vs-HIVE
    // DISCRIMINATOR THE OTHER READERS USE (interests/route.ts `whichReader`, and 6
    // more). A session is a LITE actor when it carries a Lumen `userId` OR
    // `account_tier: 'lite'`; it is a full HIVE actor only when it has a `username`
    // and is NEITHER. `username` is a self-chosen display_name for a lite session
    // but a signature-proven Hive account for a full one — so it may be trusted as a
    // Hive account ONLY in the full-Hive case.
    const isLiteActor = !!u && (!!u.userId || u.account_tier === 'lite');
    if (isLiteActor) {
      // A lite session resolves ONLY through its actor check, and a refusal is
      // TERMINAL. The old code fell through on refusal to trust `u.username` as a
      // Hive account, so a revoked/suspended lite user whose display_name collides
      // with a real Hive account name (e.g. after an ordinary self-upgrade bumped
      // the session epoch) read that account's private notifications and DM senders.
      const checked = await requireActiveLiteUser(u, session);
      if (checked.ok) actor = { userId: checked.user.userId };
      // else: no fallback — a refused lite session is signed out for this endpoint.
    } else if (u?.username && hiveParam && u.username === hiveParam) {
      // Full Hive session: `username` is proven by signature at login, so it is the
      // authority on its OWN account — and only its own (bound by `=== hiveParam`).
      actor = { hive: hiveParam };
    }
  } catch {
    actor = null;
  }
  if (!actor) return NextResponse.json({ error: 'not_signed_in' }, { status: 401 });

  try {
    const rawFollowers = await listRecentFollowersWithTime(actor as never, { limit: 30 });

    // ★ THE READER'S OWN BLOCK LIST (2026-08-23). `listRecentFollowersWithTime` already
    // drops operator-banned accounts, but not the accounts THIS reader blocked — so
    // blocking someone silenced them everywhere except the one place that announces them
    // by name, with a working link to their profile.
    //
    // ★ THE KEY IS BUILT WITH `actorKey`, NOT A HAND-WRITTEN TEMPLATE. The block set is
    // keyed `u:<userId>` / `h:<hive>`; reimplementing that here would fail SILENTLY the
    // day either side changes, because a key that never matches filters nothing and throws
    // nothing. Importing the same function the writer uses makes drift impossible.
    //
    // Degrades OPEN, like every other effect-A site: a Lumen DB hiccup must not empty
    // somebody's notification bell.
    const blockedKeys = await viewerBlockedKeySet(sessionUser).catch(() => new Set<string>());
    const followers =
      blockedKeys.size === 0
        ? rawFollowers
        : rawFollowers.filter((f) => {
            const key = f.userId
              ? actorKey({ userId: f.userId })
              : f.hive
                ? actorKey({ hive: f.hive })
                : null;
            return !key || !blockedKeys.has(key);
          });

    // No early return on empty followers: DM notifications are merged in below, so the
    // bell can carry new-message rows even for a reader with no recent followers.

    // Resolve Lumen ids to the names those people use TODAY, so a renamed
    // account is not announced under a stale handle.
    const ids = followers.map((f) => f.userId).filter((id): id is string => !!id);
    const users = ids.length ? await findUsersByIds(ids).catch(() => []) : [];
    const nameById = new Map(users.map((u) => [u.userId, u.displayName]));

    const followRows = followers.map((f) => {
      const name = f.userId ? (nameById.get(f.userId) ?? f.userId) : (f.hive ?? 'someone');
      return {
        type: 'follow' as const,
        // Same field names the chain notification list uses, so the renderer
        // does not need a second shape to understand.
        msg: `${name} followed you`,
        url: `@${name}`,
        date: f.at,
        // ★ THE FOLLOWER'S HANDLE, SENT EXPLICITLY (2026-08-16, owner: "follow
        // notifications still don't show profile pics"). The bell's Lumen rows
        // rendered as bare text while the chain rows next to them carried a
        // 40px avatar, so in one list the same event looked like two different
        // kinds of thing. The panel needs a name to draw a face from, and
        // slicing it back out of `url` or `msg` would break the moment either
        // string is reworded or translated.
        actor: name,
        source: 'lumen' as const
      };
    });

    // ── DM rows: unread incoming messages, ONE per sender (bell "New message from @X") ──
    // Content is never touched — sender + time only. Blocked senders are dropped with the
    // same key set the follow rows use, and a DM-side failure degrades open (follows still
    // show), exactly like the outer catch.
    let dmRows: Array<{ type: 'dm'; msg: string; url: string; date: string; actor?: string; source: 'lumen' }> = [];
    try {
      const myKey = actor.userId ? actorKey({ userId: actor.userId }) : actorKey({ hive: actor.hive as string });
      const senders = await dmMessages.unreadSendersForActor(myKey, 10);
      const visible =
        blockedKeys.size === 0 ? senders : senders.filter((s) => !blockedKeys.has(s.senderKey));
      const dmIds = visible.filter((s) => s.senderKey.startsWith('u:')).map((s) => s.senderKey.slice(2));
      const dmUsers = dmIds.length ? await findUsersByIds(dmIds).catch(() => []) : [];
      const dmNameById = new Map(dmUsers.map((u) => [u.userId, u.displayName]));
      dmRows = visible.map((s) => {
        const isHive = s.senderKey.startsWith('h:');
        const name = isHive ? s.senderKey.slice(2) : (dmNameById.get(s.senderKey.slice(2)) ?? null);
        return {
          type: 'dm' as const,
          msg: name ? `New message from ${isHive ? '@' : ''}${name}` : 'New message from a Lumen member',
          // The recipient's own Studio inbox, deep-linked to the MESSAGES sub-tab so the
          // click lands where the message is read and the unread state clears (the tab
          // defaults to Requests otherwise). Not the sender's profile, unlike a follow row.
          url: 'creators/studio?section=inbox&tab=messages',
          date: s.at instanceof Date ? s.at.toISOString() : String(s.at),
          // Only a Hive sender has a handle the bell can draw an avatar from; a lite sender
          // falls back to the monogram, and is named generically in `msg`.
          actor: isHive && name ? name : undefined,
          source: 'lumen' as const
        };
      });
    } catch (e) {
      logger.error(e, 'DM notifications lookup failed');
    }

    // ── BUY rows: someone bought this creator's Meritum ──────────────────────
    // Degrades open exactly like the DM half: a creator-token read that fails
    // must not cost this reader their follows.
    let buyRows: Array<{ type: 'buy'; msg: string; url: string; date: string; actor?: string; source: 'lumen' }> = [];
    try {
      const creatorKeys = await creatorKeysFor(actor as { userId?: string; hive?: string });
      if (INDEXER_URL && CONTRACT_ID && creatorKeys.length > 0) {
        const res = await fetch(`${INDEXER_URL}/v1/graphql`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            query: `query Bought($creators: [String!], $contract: String!) {
              lumen_ct_bought_events(
                where: { creator: { _in: $creators }, indexer_contract_id: { _eq: $contract } }
                order_by: { indexer_ts: desc }
                limit: 15
              ) { creator actor minted total_due indexer_ts }
            }`,
            variables: { creators: creatorKeys, contract: CONTRACT_ID }
          }),
          signal: AbortSignal.timeout(6_000)
        });
        if (res.ok) {
          const body = (await res.json()) as { data?: { lumen_ct_bought_events?: BoughtRow[] } };
          buyRows = (body.data?.lumen_ct_bought_events ?? [])
            // A creator buying their own token (the launch first-buy, or topping
            // up) must not ping them about themselves.
            .filter((r) => !creatorKeys.includes(r.actor))
            .map((r) => {
              const buyer = r.actor.startsWith('hive:') ? r.actor.slice(5) : r.actor;
              const tokens = Number(r.minted || '0');
              return {
                type: 'buy' as const,
                // Reads like every other row: actor first, then what they did.
                msg: `${buyer} bought ${tokens === 1 ? 'a' : tokens} Meritum of yours for $${hbd(r.total_due).toFixed(2)}`,
                // Their own market page, which is where a creator goes to see what
                // just happened to their supply and price.
                url: `creators/${creatorKeys[0].startsWith('hive:') ? creatorKeys[0].slice(5) : creatorKeys[0]}`,
                // The indexer stores naive UTC, like the chain does. Say so, or the
                // bell sorts it by the reader's own timezone offset.
                date: r.indexer_ts.endsWith('Z') ? r.indexer_ts : `${r.indexer_ts}Z`,
                // Only a Hive buyer has a handle the bell can draw a face from.
                actor: r.actor.startsWith('hive:') ? buyer : undefined,
                source: 'lumen' as const
              };
            });
        }
      }
    } catch (e) {
      logger.error(e, 'buy notifications lookup failed');
    }

    const merged = [...followRows, ...dmRows, ...buyRows].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
    return NextResponse.json({ notifications: merged });
  } catch (error) {
    // The bell must not break because this half failed — the chain half (for a
    // Hive account) is still worth showing.
    logger.error(error, 'lite notifications lookup failed');
    return NextResponse.json({ notifications: [], degraded: true });
  }
}
