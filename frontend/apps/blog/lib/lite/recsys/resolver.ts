import * as posts from '../repositories/post-repository';
import * as users from '../repositories/user-repository';
import * as follows from '../repositories/follow-repository';

/**
 * Recsys reconciliation surface (spec §E.4). The ranking pipeline is author-keyed
 * (post_index / graph_cred / second_degree_engager). Un-reconciled, every lite
 * post's engagement collapses onto the frontend account and every real lite user
 * gets zero graph-cred. These resolvers let recsys substitute `user_id` for
 * `author` at ingestion:
 *  - proxy posts: (frontend_account, permlink) -> user_id
 *  - upgraded users' direct posts: hive_account_name -> user_id
 *  - the off-chain follow graph over user_id
 */

export interface AuthorMapping {
  author: string;
  permlink: string;
  userId: string;
  displayName: string;
}

export interface AccountMapping {
  hiveAccountName: string;
  userId: string;
  displayName: string;
}

const MAX_EDGE_PAGE = 1000;

export async function resolveAuthors(
  pairs: Array<{ author: string; permlink: string }>
): Promise<AuthorMapping[]> {
  const authors = pairs.map((p) => p.author);
  const permlinks = pairs.map((p) => p.permlink);
  const rows = await posts.resolveByHiveBatch(authors, permlinks);
  return rows.map((r) => ({
    author: r.hiveAuthor,
    permlink: r.hivePermlink,
    userId: r.userId,
    displayName: r.displayName
  }));
}

export async function resolveHiveAccounts(names: string[]): Promise<AccountMapping[]> {
  const found = await users.findUsersByHiveAccountNames(names);
  const out: AccountMapping[] = [];
  for (const u of found) {
    if (u.hiveAccountName) {
      out.push({ hiveAccountName: u.hiveAccountName, userId: u.userId, displayName: u.displayName });
    }
  }
  return out;
}

export async function listFollowEdges(afterSeq: number, limit: number): Promise<follows.FollowEdge[]> {
  return follows.listEdges(afterSeq, Math.min(limit, MAX_EDGE_PAGE));
}
