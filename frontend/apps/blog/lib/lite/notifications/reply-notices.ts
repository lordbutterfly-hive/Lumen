import { siteConfig } from '@ui/config/site';
import { liteConfig } from '../config';
import * as posts from '../repositories/post-repository';
import { findUsersByIds } from '../repositories/user-repository';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';

/**
 * Reply notifications for a Lumen (lite) account (quote reblog decision D10). Until now
 * a lite user was never told about a reply: the bell never asks Hive about a lite
 * handle, and Lumen kept no reply rows. Two sources:
 *   - Lumen replies, from Lumen's own table (one query);
 *   - Hive users' replies on chain to their most recent published posts (including
 *     reblog comments), one `get_content_replies` per post, cached a minute per person.
 */
export interface ReplyNotice {
  id: string;
  /** Who replied: a Hive name, or a Lumen handle. */
  actor: string;
  /** The key the reader's block list uses for them. */
  actorKey: string;
  toQuote: boolean;
  /** Site-relative, no leading slash: the parent's page at the reply. */
  url: string;
  date: string;
}

const RECENT_POSTS = 8;
const HIVE_READ_TIMEOUT_MS = 6000;

interface ChainReply {
  author: string;
  permlink: string;
  created: string;
}

async function hiveRepliesTo(permlink: string): Promise<ChainReply[]> {
  const res = await fetch(siteConfig.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'condenser_api.get_content_replies', params: [liteConfig.frontendAccount, permlink], id: 1 }),
    signal: AbortSignal.timeout(HIVE_READ_TIMEOUT_MS)
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { result?: ChainReply[] };
  return data.result ?? [];
}

async function loadReplyNotices(userId: string): Promise<ReplyNotice[]> {
  const publisher = liteConfig.frontendAccount;
  if (!publisher) return [];
  const [lumenReplies, mine] = await Promise.all([
    posts.listLumenRepliesTo(userId, publisher, 20),
    posts.getUserPosts(userId, { limit: RECENT_POSTS, kind: 'all', visibleOnly: true })
  ]);
  const names = new Map((await findUsersByIds([...new Set(lumenReplies.map((r) => r.reply.userId))])).map((u) => [u.userId, u.displayName]));
  const notices: ReplyNotice[] = [];
  for (const r of lumenReplies) {
    const name = names.get(r.reply.userId);
    const parent = r.parentPermlink ?? `lite-${r.parentPostId.toLowerCase()}`;
    const reply = r.reply.hivePermlink ?? `lite-${r.reply.postId.toLowerCase()}`;
    if (!name) continue;
    notices.push({
      id: `reply:${r.reply.postId}`,
      actor: name,
      actorKey: `u:${r.reply.userId}`,
      toQuote: r.parentIsQuote,
      url: `lumen/@${publisher}/${parent}#@${publisher}/${reply}`,
      date: r.reply.createdAt.toISOString()
    });
  }
  // Hive users' replies: the publishing account's own replies are Lumen ones, above.
  const published = mine.flatMap((p) => (p.hivePermlink ? [{ ...p, hivePermlink: p.hivePermlink }] : []));
  const chain = await Promise.all(published.map((p) => hiveRepliesTo(p.hivePermlink).catch(() => [] as ChainReply[])));
  published.forEach((p, i) => {
    for (const c of chain[i]) {
      if (c.author === publisher) continue;
      notices.push({
        id: `reply:${c.author}/${c.permlink}`,
        actor: c.author,
        actorKey: `h:${c.author.toLowerCase()}`,
        toQuote: p.parentRef?.type === 'quote',
        url: `lumen/@${publisher}/${p.hivePermlink}#@${c.author}/${c.permlink}`,
        date: c.created.endsWith('Z') ? c.created : `${c.created}Z`
      });
    }
  });
  return notices.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 30);
}

/** Cached a minute per person: the bell polls, and the Hive half is a read per post. */
export const replyNoticesFor = withTtlCache(loadReplyNotices, (userId: string) => userId, { ttlMs: 60_000, max: 2000, name: 'lite-reply-notices' });
