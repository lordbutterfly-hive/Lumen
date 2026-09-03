/**
 * PURE topic-warm SELECTION - no `server-only`, no chain imports, so it is unit
 * testable in isolation (topic-warmer.ts pulls `server-only` + the chain, which
 * cannot load in a plain ts-node test). topic-warmer.ts imports `selectWarmTopics`
 * from here; this file is where the "what do we warm" rule lives and is tested.
 *
 * THE RULE (and why): warm EVERY browsable tag (never capped away) PLUS the top
 * `COMMUNITY_WARM_MAX` community ids, the whole thing capped at `max`.
 *
 * The naive earlier version warmed "the top `max` of everything". Community ids
 * (hive-N) sit near the TOP of the trending stream, so they filled the cap and
 * SILENTLY evicted lower-ranked browsable tags (photography at rank ~68) out of
 * the warm set - those tag pages stopped server-rendering with no error - and the
 * cycle ballooned to 60 reads / 128s (4x node load). Browsable-first keeps every
 * tag page warm; the community cap keeps the per-cycle read budget bounded.
 */

export const EXCLUDED_TAGS = new Set(['', 'nsfw', 'test']);
export const COMMUNITY_ID = /^hive-\d+$/i;
export const REWARD_TRIBE_TAGS = new Set([
  'pob', 'proofofbrain', 'neoxian', 'cent', 'waivio', 'waiv', 'pimp', 'archon',
  'palnet', 'creativecoin', 'vyb', 'ctp', 'alive', 'oneup', 'lassecash', 'bbh',
  'burnpost', 'hbd', 'hive', 'ecency', 'peakd', 'listnerds', 'dbuzz',
  'posh', 'curation', 'blog'
]);

/** How many community topic pages to warm on top of the browsable tags. Bounded
 *  so widening to communities cannot balloon the cycle's node reads. */
export const COMMUNITY_WARM_MAX = 20;

/** The topic route only accepts this shape; a tag it would reject can never be
 *  read back, so it is not worth warming. */
const VALID_TOPIC = /^[a-z0-9-]{1,64}$/;

/** The rail's browsable-topic predicate, copied not imported (topic-warmer.ts
 *  header explains why): excludes reserved tags, reward-tribe tags, and
 *  community ids. */
export function isBrowsableTag(name: string): boolean {
  const tag = name.toLowerCase();
  return !EXCLUDED_TAGS.has(tag) && !COMMUNITY_ID.test(tag) && !REWARD_TRIBE_TAGS.has(tag);
}

/**
 * Given the trending tag names (newest first), the tags to warm: every browsable
 * tag, then the top `COMMUNITY_WARM_MAX` community ids, capped at `max`. Browsable
 * come first so the cap can never drop one that used to warm.
 */
export function selectWarmTopics(names: string[], max: number): string[] {
  const valid = names.map((n) => (n ?? '').toLowerCase()).filter((name) => VALID_TOPIC.test(name));
  const browsable = valid.filter(isBrowsableTag);
  const communities = valid
    .filter((name) => COMMUNITY_ID.test(name) && !EXCLUDED_TAGS.has(name))
    .slice(0, COMMUNITY_WARM_MAX);
  return [...browsable, ...communities].slice(0, max);
}
