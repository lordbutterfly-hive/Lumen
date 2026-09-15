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
 * ★ NOTHING OLDER THAN A YEAR. Replaying the real pulls through the filter,
 * @imwatsi's row would have flipped to a 2023 proposal and a 2022 HAF report,
 * @emrebeyler's to a 2024 Lighthive release — true development, honestly
 * dated, and still wrong on a card that claims to track what is being built
 * NOW. A row with fewer than three posts simply flips less; a row with none
 * is not shown.
 */
export const MAX_POST_AGE_MS = 365 * 24 * 60 * 60 * 1000;

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
 * whose last 20 posts are all photography or all older than a year — all return null and the account
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
