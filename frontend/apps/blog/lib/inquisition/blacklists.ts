import 'server-only';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import type { BlacklistMark } from './types';
import { nowIso } from './types';

/**
 * ════ PUBLISHED LISTS, READ AND ATTRIBUTED — NEVER MERGED ════
 *
 * ★★★ THE SPEC'S "READY TODAY" SOURCE IS DEAD. §5 points at
 * `blacklist.usehive.com/api/blacklisted/{account}` — @themarkymark's Global
 * Blacklist API — and says Hive.blog and PeakD already use it. Probed 2026-09-19 on
 * four paths: **HTTP 000 every time**, which is a connection failure, not a 404. It
 * is not wired here and must not become a dependency if it comes back.
 *
 * What works is our own Hive RPC: `bridge.get_follow_list`. It is better than the
 * aggregator anyway, because it returns each list SEPARATELY and therefore names the
 * publisher — which is the spec's own first hard rule ("Lumen never authors a
 * blacklist and never scores an account itself. It reads published lists and names
 * the publisher of each").
 *
 * ★★ THE PUBLISHERS DO NOT USE THE SAME LIST TYPE, AND THAT MATTERS. Measured
 * 2026-09-19:
 *
 *     spaminator    blacklisted 35   muted  1
 *     buildawhale   blacklisted  9   muted  2
 *     hivewatchers  blacklisted  0   muted 27   <- publishes under MUTED, not blacklisted
 *
 * Reading only `blacklisted` would have returned nothing for hivewatchers and quietly
 * dropped the best-known publisher on Hive off the board. Both types are read, and
 * `kind` is carried through to the row so a reader can see which list they are on.
 *
 * ★ A BLACKLIST DOES NOT MUTE ANYONE. It attaches information to a name and warns on
 * transfers. Most readers assume the opposite, and the board says so on its face.
 */

/**
 * ★ ONE PUBLISHER TABLE, AFTER THREE OF THEM DISAGREED. This list, the SQL board's copy
 * and the route's appeal map had drifted apart — steemcleaners existed in one of them
 * only, so even the fallback could not have recovered it. The SQL copy is deleted and
 * the appeal URLs live here, beside the accounts they belong to.
 */
const PUBLISHERS = [
  { account: 'hivewatchers', appealUrl: 'https://hivewatchers.com' },
  { account: 'spaminator', appealUrl: 'https://spaminator.me' },
  { account: 'steemcleaners', appealUrl: 'https://steemcleaners.org' },
  { account: 'buildawhale', appealUrl: null }
] as const;

const LIST_TYPES = ['blacklisted', 'muted'] as const;

interface FollowListEntry {
  name: string;
  blacklist_description?: string;
  muted_list_description?: string;
}

async function bridgeFollowList(observer: string, followType: string): Promise<FollowListEntry[]> {
  const endpoint = process.env.REACT_APP_API_ENDPOINT || 'https://api.hive.blog';
  const res = await fetch(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(4000),
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'bridge.get_follow_list',
      params: { observer, follow_type: followType },
      id: 1
    })
  });
  if (!res.ok) throw new Error(`bridge ${res.status}`);
  const json = (await res.json()) as { result?: FollowListEntry[] };
  return json.result ?? [];
}

export interface BlacklistIndex {
  /** account -> the marks against it, one per publisher+kind. */
  byAccount: Map<string, BlacklistMark[]>;
  /** Every listed account, for the board. */
  accounts: string[];
  asOf: string;
  /** A publisher whose read failed, so the board can say the picture is incomplete. */
  missing: string[];
}

/**
 * ★ ONE AGGREGATE, NOT N LOOKUPS. Six requests total (three publishers × two list
 * types) build the whole index, and every profile and every board row then reads it
 * out of a Map. The alternative — asking per account as rows render — is the fan-out
 * the server-safety rules exist to forbid.
 */
async function loadIndex(): Promise<BlacklistIndex> {
  const byAccount = new Map<string, BlacklistMark[]>();
  const missing: string[] = [];

  const jobs = PUBLISHERS.flatMap((p) =>
    LIST_TYPES.map(async (kind) => {
      try {
        const entries = await bridgeFollowList(p.account, kind);
        return { publisher: p.account, appealUrl: p.appealUrl, kind, entries };
      } catch {
        return { publisher: p.account, appealUrl: p.appealUrl, kind, entries: null };
      }
    })
  );

  for (const result of await Promise.all(jobs)) {
    if (result.entries === null) {
      if (!missing.includes(result.publisher)) missing.push(result.publisher);
      continue;
    }
    for (const entry of result.entries) {
      const marks = byAccount.get(entry.name) ?? [];
      marks.push({ publisher: result.publisher, kind: result.kind, appealUrl: result.appealUrl });
      byAccount.set(entry.name, marks);
    }
  }

  return { byAccount, accounts: [...byAccount.keys()].sort(), asOf: nowIso(), missing };
}

/**
 * Six hours: these lists move on a human timescale, and a reader looking at a board
 * twice in one session must not cost twelve upstream calls.
 */
export const blacklistIndex = withTtlCache(loadIndex, () => 'inq-blacklists', {
  ttlMs: 6 * 60 * 60 * 1000,
  max: 1,
  name: 'inq-blacklists',
  /*
   * ★★ ONLY A COMPLETE INDEX IS CACHED, AND "ALL FOUR FAILED" WAS TOO WEAK A BAR
   * (tightened after adversarial review, 2026-09-19).
   *
   * The old rule accepted an index where THREE of four publishers had failed and held
   * it for six hours. hivewatchers alone is 27 of ~87 marks, so one 429 from
   * api.hive.blog could pin a mostly-empty picture for a quarter of a day — and the
   * per-account lookup reads exactly this index, so every armed profile would have
   * printed a clean record for people who are in fact listed.
   *
   * A partial read still ANSWERS — the board renders it and names who is missing — it
   * just does not get to become the cached answer. Retrying eight cheap requests beats
   * six hours of a wrong negative about a named human being.
   */
  shouldCache: (index) => index.missing.length === 0
});

/**
 * ★★★ THE CALLER IS TOLD WHETHER THE PICTURE WAS COMPLETE. `marksFor` used to return
 * bare marks, so "no marks" and "we could not read the lists" were the same value — and
 * the profile strip turned that into the word **None** under a fresh timestamp. That is
 * the same class of lie `hivesql.ts` documents at length, on the surface where it does
 * the most damage: a specific, named account.
 */
export async function marksFor(account: string): Promise<{ marks: BlacklistMark[]; missing: string[] }> {
  const index = await blacklistIndex();
  return { marks: index.byAccount.get(account) ?? [], missing: index.missing };
}
