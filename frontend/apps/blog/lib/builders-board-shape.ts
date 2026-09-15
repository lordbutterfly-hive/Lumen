import type { Entry } from '@hive/common-hiveio-packages/wax';

/**
 * The PURE half of the builders board: the roster shape, the "is this post
 * development" rule, and the row shaping — with no chain client behind them.
 *
 * ★ WHY THIS IS A SEPARATE FILE (2026-09-15, found by the first `test:unit`
 * run). `lib/builders-board.ts` imports `getAccountPostsPage` from
 * `@transaction/lib/bridge-api`, which imports `@hiveio/wax`. Under ts-node
 * that resolves to wax's ESM `exports` map and throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` at import time — so a test that imported the
 * loader module aborted the WHOLE `test:unit` run at the first failing file,
 * and every suite alphabetically after it (including the two source-scanning
 * guards) silently never ran. The rules that decide what a row is have no
 * business depending on the chain; they live here, the loader imports them,
 * and the test imports only this.
 */

/** How many of a builder's development posts a row cycles through (owner: "only flip last 3 posted"). */
export const POSTS_PER_BUILDER = 3;

/**
 * ★ NOTHING OLDER THAN 30 DAYS (owner, 2026-09-15: "any post older than 1
 * month should not show up. if older than 1 month and user doesnt have newer
 * stuff, he isnt showed"). The first cut was a year: replaying the real pulls,
 * @imwatsi's row would have flipped to a 2023 proposal and a 2022 HAF report
 * — true development, honestly dated, and still wrong on a card that claims
 * to track what is being built NOW. A month is the owner's bar for "now". A
 * row with fewer than three posts simply flips less; a builder with no post
 * inside the month is not shown at all, and comes back with the next post.
 */
export const MAX_POST_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Chain timestamps carry no zone and are UTC; parsed the way the feed parses them. */
export function postAgeMs(created: string, now: number): number {
  const at = Date.parse(`${created}Z`);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : now - at;
}

/**
 * One builder on the roster. Three modes, each decided by READING that
 * builder's real posts (the pulls of 2026-09-15, twenty root posts per
 * account), never by guessing from the account name:
 *
 * `all` — a PRODUCT account (or a person) whose every post is the product
 * shipping: Snapie, Keychain, Actifit, Terracore, Hive Engine, Holozing,
 * liketu, and @blocktrades, whose last twenty are all HAF/API release notes
 * (owner: "for blocktrades for example every post of his is about
 * development").
 *
 * `dev` — a person whose development posts carry the shared vocabulary below
 * (`dev`, `hivedev`, `witness-update`, the HiveDevs community…) and whose
 * other posts do not. Verified per account, e.g. @gtg: the peer-loss and
 * hard-fork posts carry `dev`/`witness-update`, the anniversary and HiveFest
 * posts carry neither. `tags`/`titles` add that builder's own rules on top.
 *
 * `own` — ONLY this builder's own `tags` and `titles` count; the shared
 * vocabulary and the dev communities are ignored. For people whose feed
 * defeats the vocabulary: @howo tags EVERYTHING `core,dev` including "I'm
 * bored and sad about my profession" (owner: "remove howo's category
 * match"); Lumen adds a `lumen` tag to whatever the owner publishes through
 * it, so the owner's rule has to live in the TITLE (owner: "if lumen in title
 * or meritum or algo"); @brianoflondon puts `v4vapp` on Bitcoin opinion
 * pieces too, but `developers` only on the V4V.app engineering posts.
 *
 * `tags` match a post's category or any of its tags, exactly, lower-cased.
 * `titles` match as a case-insensitive SUBSTRING of the title ("algo" is
 * meant to catch "algorithm"; "core dev" catches "Core dev meeting #84" and
 * "Core development proposal year 7").
 */
export type BuilderMode = 'all' | 'dev' | 'own';

export interface Builder {
  account: string;
  mode: BuilderMode;
  /** This builder's own tags (a category counts as a tag). Any post carrying one counts. */
  tags?: readonly string[];
  /** Title keywords, matched case-insensitively as substrings. Any post whose title contains one counts. */
  titles?: readonly string[];
}

/**
 * ★ THE SHARED DEVELOPMENT VOCABULARY, KEPT TIGHT ON PURPOSE. The first draft
 * of this scored every candidate's last 20 posts and read "100% development"
 * for tribe and curation accounts: `witness` alone matched weekly earnings
 * reports, `update`/`app`/`wallet` matched everything, and "the account's own
 * name as a tag" promoted @neoxian and @discovery-it to builders. Each word
 * here names the ACT of building or the artefact of it; nothing here names a
 * topic someone might merely write about. `frontend`/`backend` were here and
 * are not: a rant about frontends carried `frontend` too (measured on the
 * owner's own feed), and a product tag says the same thing more precisely.
 * `core` was here and is not (owner, 2026-09-15: "remove howo's category
 * match"): @howo files every post under `core`, the bored-and-sad one
 * included, so the word names his BLOG, not the act of building. Communities:
 * HiveDevs and Programming & Dev, the two whose whole remit is development.
 */
export const DEV_TAGS: ReadonlySet<string> = new Set([
  'dev', 'devlog', 'devlogs', 'development', 'developer', 'developers', 'programming', 'coding', 'software',
  'opensource', 'open-source', 'github', 'release', 'changelog', 'witness-update', 'witnessupdate',
  'api', 'sdk', 'dapp', 'hiveproject', 'hiveprojects', 'hivedev', 'hive-dev', 'hivedevs',
  'haf', 'hafah', 'hafsql', 'hivemind', 'infrastructure', 'node', 'multisig', 'smart-contract', 'smartcontract',
  'smartcontracts', 'contracts', 'l2', 'layer2', 'core-dev', 'coredev', 'hardfork', 'explorer', 'indexer'
]);

export const DEV_COMMUNITIES: ReadonlySet<string> = new Set([
  'hive-139531', // HiveDevs
  'hive-169321' // Programming & Dev
]);

/** One row of the board: a builder and the posts their row flips between. */
export interface BuilderRow {
  account: string;
  posts: BuilderPost[];
}

export interface BuilderPost {
  permlink: string;
  category: string;
  title: string;
  /** ISO-ish chain timestamp, exactly as the Bridge gives it (no `Z`). */
  created: string;
}

/** Tags off an entry, lower-cased. `json_metadata` arrives as an object from the Bridge and as a string from some cached paths. */
export function tagsOf(entry: Pick<Entry, 'json_metadata'>): string[] {
  const meta = entry.json_metadata as unknown;
  let parsed: unknown = meta;
  if (typeof meta === 'string') {
    try {
      parsed = JSON.parse(meta);
    } catch {
      parsed = null;
    }
  }
  const raw = parsed && typeof parsed === 'object' ? (parsed as { tags?: unknown }).tags : undefined;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return list.map((t) => String(t).toLowerCase());
}

/** Is this post the builder building? See `Builder` and `DEV_TAGS`. */
export function isDevelopmentPost(builder: Builder, entry: Pick<Entry, 'json_metadata' | 'category' | 'title'>): boolean {
  if (builder.mode === 'all') return true;
  const category = (entry.category ?? '').toLowerCase();
  const tags = tagsOf(entry);
  if (builder.mode === 'dev') {
    if (DEV_COMMUNITIES.has(category) || DEV_TAGS.has(category)) return true;
    if (tags.some((tag) => DEV_TAGS.has(tag))) return true;
  }
  const own = new Set((builder.tags ?? []).map((t) => t.toLowerCase()));
  if (own.size > 0 && (own.has(category) || tags.some((tag) => own.has(tag)))) return true;
  const title = (entry.title ?? '').toLowerCase();
  for (const keyword of builder.titles ?? []) {
    const needle = keyword.toLowerCase();
    if (needle && title.includes(needle)) return true;
  }
  return false;
}

/**
 * A cross-post is a stub whose body is a link to the original, posted into a
 * second community (tagged exactly `cross-post`, as @liketu, @snapie,
 * @brianoflondon and @hive.pizza all do). The original is in the same page,
 * so the stub would only put the same title on the row twice — and link to
 * the worse copy.
 */
export function isCrossPost(entry: Pick<Entry, 'json_metadata'>): boolean {
  return tagsOf(entry).includes('cross-post');
}

/**
 * The Bridge page for one builder -> the row the card renders, or null when
 * there is nothing honest to show.
 *
 * ★ ROOT POSTS ONLY. `sort: 'posts'` already asks for that, but a reblog
 * arrives with `author` set to the ORIGINAL author, and a row headed "@howo"
 * that flips to somebody else's title is a wrong row. Anything not authored
 * by the account itself is dropped here, whatever the Bridge returned.
 *
 * ★ DEVELOPMENT POSTS ONLY, NO CROSS-POST STUBS, NEWEST FIRST, AT MOST
 * `POSTS_PER_BUILDER`. The Bridge returns newest first, so the first matches
 * are the latest ones.
 *
 * ★ A ROW WITH NO POSTS IS NO ROW. An empty page, a failed read, a builder
 * whose last 20 posts are all photography or all older than a month — all return null and the account
 * simply does not appear, the way the Meritum board drops a creator with an
 * empty shop. A rail card explains nothing about a missing row; it would
 * have to explain an empty one.
 */
export function shapeBuilderRow(
  builder: Builder,
  entries: readonly Entry[] | null | undefined,
  now: number = Date.now()
): BuilderRow | null {
  if (!entries || entries.length === 0) return null;
  const own = builder.account.toLowerCase();
  const posts: BuilderPost[] = [];
  for (const e of entries) {
    if ((e.author ?? '').toLowerCase() !== own) continue;
    const title = (e.title ?? '').trim();
    if (!e.permlink || !e.category || !title) continue;
    if (isCrossPost(e)) continue;
    if (!isDevelopmentPost(builder, e)) continue;
    if (postAgeMs(e.created, now) > MAX_POST_AGE_MS) continue;
    posts.push({ permlink: e.permlink, category: e.category, title, created: e.created });
    if (posts.length >= POSTS_PER_BUILDER) break;
  }
  return posts.length > 0 ? { account: builder.account, posts } : null;
}

/**
 * ★★★ THE BOARD FLIPS WRITERS, NOT JUST POSTS (owner, 2026-09-15: "make sure
 * the card flips the writers as well as their posts"). The card has a fixed
 * number of SLOTS, and each slot cycles through a queue of (builder, post)
 * entries, so every flip can bring a different builder into view, the way a
 * departures board shows a different flight in the same row. Over one full
 * cycle every builder's every post passes through the card; nothing is lost
 * to a row nobody scrolled to.
 *
 * ★ QUEUES ARE DEALT SO NO TWO SLOTS SHOW THE SAME BUILDER AT ONCE. The
 * entries are laid out by ROUND — every builder's newest post first (in the
 * board's newest-first order), then every builder's second post, then the
 * third — and dealt round-robin into the slots. The slots step in near
 * lockstep (same dwell, a small stagger), so at any moment they show a run of
 * consecutive entries, and consecutive entries within a round are distinct
 * builders. Dealing the flat newest-first list instead would have opened the
 * card with @sagarkothari88 in three slots at once.
 */
export const BOARD_SLOTS = 8;

export interface SlotEntry {
  account: string;
  post: BuilderPost;
}

/** Every builder's newest post, then every builder's second, then third… */
export function interleaveByRound(rows: readonly BuilderRow[]): SlotEntry[] {
  const out: SlotEntry[] = [];
  const deepest = rows.reduce((max, r) => Math.max(max, r.posts.length), 0);
  for (let round = 0; round < deepest; round++) {
    for (const row of rows) {
      const post = row.posts[round];
      if (post) out.push({ account: row.account, post });
    }
  }
  return out;
}

/** Deal the round-interleaved entries into at most `slots` queues; a queue is never empty. */
export function buildSlotQueues(rows: readonly BuilderRow[], slots: number = BOARD_SLOTS): SlotEntry[][] {
  const entries = interleaveByRound(rows);
  const count = Math.max(0, Math.min(slots, entries.length));
  const queues: SlotEntry[][] = Array.from({ length: count }, () => []);
  entries.forEach((entry, i) => queues[i % count].push(entry));
  return queues;
}

/**
 * ★ THE BOARD READ IS BOUNDED, NOT A BURST (2026-09-15, found while chasing a
 * slow topics page). The loader used to fire one Bridge call per builder at
 * once — 20+ POSTs to the Hive node in the same tick. Every outbound Hive call
 * on a worker shares ONE undici pool (`lib/http-keepalive.ts`, 64 sockets),
 * so a cold refresh took a third of the pool for a second or two and every
 * page render that needed the chain in that window queued behind a rail
 * widget. The refresh runs behind a stale-while-revalidate cache, so its own
 * latency is invisible; a small concurrency keeps it invisible to everyone
 * else too. Generic and pure so the test can prove the bound.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}
