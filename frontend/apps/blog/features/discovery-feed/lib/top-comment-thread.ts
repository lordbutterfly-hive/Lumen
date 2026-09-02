import type { Entry } from '@hive/common-hiveio-packages/wax';
import { discussionKey } from './top-comment';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FULL REPLY THREAD FOR THE POST CARD'S TOP COMMENT — DERIVED, NEVER FETCHED.
 * Built to `LUMEN-DOCS/TOP-COMMENT-THREAD-EXPAND-SPEC-2026-09-02.md` §2.2, §2.4.
 *
 * ★★★ ZERO NEW REQUEST. `bridge.get_discussion` (through `/api/discussion`)
 * returns the ENTIRE discussion for a post — every comment at every depth — as a
 * `Record<'author/permlink', Entry>` map. `useVisibleDiscussion` block-filters it
 * once. So the moment the drawer's single fetch resolves, the whole reply thread
 * beneath the top comment is ALREADY in `visible`. This is a pure walk over that
 * map: no fetch, no chain read (see `discussion-fetch.ts` for why never a chain
 * read), and the block filtering is already applied upstream so nothing extra to
 * filter here.
 *
 * ★★ DEPTH IS COMPUTED BY THE WALK, NOT READ OFF `entry.depth`. A traversal level
 * (1 = a direct reply to the top comment) cannot be wrong the way a blank or
 * absent Hivemind `depth` field can. It equals `comment-list.tsx`'s `localDepth`
 * (`comment.depth - parent_depth`) for a well-formed tree, and is robust when the
 * field is missing.
 *
 * ★ THE SORT IS DETERMINISTIC, so a server render and a client render resolve to
 * the identical order (spec §4 SSR/hydration: no `Math.random`, no `Date.now`).
 * It MIRRORS the post page's default "trending" comment sort
 * (`lib/sorter.ts:19-28`, the site default per `comment-select-filter.tsx:18`) so
 * the drawer and the post page agree on order — gray-demoted last, then higher
 * total payout, then higher net_rshares — and appends a final lexicographic
 * tiebreak on the immutable `author/permlink` key. That last step is NOT in
 * `sorter.ts`: it exists so two replies with equal payout AND equal rshares do
 * not fall through to Map/engine iteration order, which the spec forbids by name.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Mirror of `comment-list.tsx:65` (`MAX_VISUAL_DEPTH = 4`). Kept in sync by
 * CITATION rather than imported, so this feature carries no dependency on a
 * post-rendering module-local constant (the spec permits import OR mirror-with-
 * citation, §2.3/§2.4). Beyond this many levels the indent stops growing and the
 * reply is labelled "replying to X" — see `comment-list.tsx:58-65` for the
 * runaway-indent bug this cap fixed (item 10, 2026-08-11).
 */
export const MAX_VISUAL_DEPTH = 4;

/**
 * Virtualization thresholds (spec §3.5). Most threads are small and render whole.
 * A very long one renders a head slice plus a "view all" link to the post page —
 * the right home for a 200-reply thread; the feed stays light. The drawer's
 * measured height stays exact for whatever is actually rendered, so the rendered
 * portion is never clipped.
 */
export const THREAD_INLINE_CAP = 20; // nodes rendered inline when truncating
export const THREAD_VIRTUALIZE_THRESHOLD = 30; // total descendants above which we truncate

export interface ThreadNode {
  key: string;
  entry: Entry;
  /** Traversal level below the top comment. 1 = a direct reply. Computed by the
   *  walk (see header), equal to `comment-list.tsx`'s `localDepth`. */
  depth: number;
  /** Last among its own sibling group — drives the ThreadLine down-connector. */
  isLast: boolean;
  /** Set ONLY when `depth > MAX_VISUAL_DEPTH`: the indent is capped, so this
   *  names who the flattened reply answers, mirroring `comment-list.tsx:193` and
   *  `comment-list-item.tsx:772-777`. The chain author of the parent (the deep-
   *  flatten label is a rare path, depth > 4, so it does not resolve a lite
   *  overlay — the common case never reaches it). */
  replyingToAuthor?: string;
}

export interface DerivedThread {
  /** Pre-order flat list, sorted and depth-tagged, ready to render. */
  nodes: ThreadNode[];
  /** Total descendant count BEFORE any virtualization slice. */
  total: number;
  /** True when `nodes` is a head slice and a "view all" link is required. */
  truncated: boolean;
}

/** Stable empty result — a shared identity so callers can memo against it. */
export const EMPTY_THREAD: DerivedThread = { nodes: [], total: 0, truncated: false };

/**
 * Payout amount for the trending sort. Mirrors the STRING branch of
 * `parseAsset` (`packages/ui/lib/utils.ts:23`) — bridge payout fields are strings
 * like `"1.234 HBD"` — WITHOUT importing it, so this module (and its unit test run
 * under `ts-node -T`) stays free of the asset-constant runtime init `parseAsset`
 * needs. Also tolerates a NaiAsset object and a bare number.
 */
function amount(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  const o = v as { amount?: unknown; precision?: unknown };
  const a = Number(o?.amount);
  const p = Number(o?.precision);
  if (Number.isFinite(a) && Number.isFinite(p)) return a / Math.pow(10, p);
  return 0;
}

function grayOf(e: Entry): boolean {
  return Boolean((e as { stats?: { gray?: boolean } })?.stats?.gray);
}
function payoutOf(e: Entry): number {
  return amount(e?.pending_payout_value) + amount(e?.author_payout_value) + amount(e?.curator_payout_value);
}
function rsharesOf(e: Entry): number {
  const r = Number((e as { net_rshares?: unknown })?.net_rshares ?? 0);
  return Number.isFinite(r) ? r : 0;
}

interface Seed {
  key: string;
  entry: Entry;
}

/** Trending comparator (mirrors `lib/sorter.ts:19-28`) + a deterministic key tiebreak. */
function compareTrending(a: Seed, b: Seed): number {
  const ga = grayOf(a.entry);
  const gb = grayOf(b.entry);
  if (ga !== gb) return ga ? 1 : -1; // demoted last (sorter.ts:22)
  const pa = payoutOf(a.entry);
  const pb = payoutOf(b.entry);
  if (pa !== pb) return pb - pa; // higher payout first (sorter.ts:24-26)
  const ra = rsharesOf(a.entry);
  const rb = rsharesOf(b.entry);
  if (ra !== rb) return rb - ra; // higher net_rshares first (sorter.ts:27)
  // Final tiebreak (NOT in sorter.ts) — SSR/CSR agreement, spec §4.
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * @param visible       the block-filtered discussion map (`useVisibleDiscussion`).
 * @param topCommentKey `${author}/${permlink}` of the chosen top comment.
 * @param opts          override the virtualization thresholds (tests / tuning).
 * @returns the ordered descendant list, its true total, and whether it was cut.
 */
export function deriveThread(
  visible: Record<string, Entry> | undefined,
  topCommentKey: string,
  opts?: { inlineCap?: number; virtualizeThreshold?: number }
): DerivedThread {
  if (!visible) return EMPTY_THREAD;
  const top = visible[topCommentKey];
  if (!top) return EMPTY_THREAD;

  // Direct children by parent key, in one pass over the map.
  const childrenOf = new Map<string, string[]>();
  for (const [key, entry] of Object.entries(visible)) {
    if (key === topCommentKey) continue;
    if (!entry?.parent_author || !entry?.parent_permlink) continue;
    const pk = discussionKey(entry.parent_author, entry.parent_permlink);
    const arr = childrenOf.get(pk);
    if (arr) arr.push(key);
    else childrenOf.set(pk, [key]);
  }

  const nodes: ThreadNode[] = [];
  const visited = new Set<string>(); // pointer-cycle guard (defensive)

  const walk = (parentKey: string, parentAuthor: string, depth: number): void => {
    const kids = childrenOf.get(parentKey);
    if (!kids || kids.length === 0) return;
    const sorted = kids
      .map((k): Seed => ({ key: k, entry: visible[k] }))
      .sort(compareTrending);
    const beyondCap = depth > MAX_VISUAL_DEPTH;
    sorted.forEach((seed, i) => {
      if (visited.has(seed.key)) return;
      visited.add(seed.key);
      nodes.push({
        key: seed.key,
        entry: seed.entry,
        depth,
        isLast: i === sorted.length - 1,
        replyingToAuthor: beyondCap ? parentAuthor : undefined
      });
      walk(seed.key, seed.entry.author, depth + 1);
    });
  };

  walk(topCommentKey, top.author, 1);

  const total = nodes.length;
  const inlineCap = opts?.inlineCap ?? THREAD_INLINE_CAP;
  const threshold = opts?.virtualizeThreshold ?? THREAD_VIRTUALIZE_THRESHOLD;
  if (total > threshold) {
    return { nodes: nodes.slice(0, inlineCap), total, truncated: true };
  }
  return { nodes, total, truncated: false };
}
