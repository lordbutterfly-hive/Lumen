/**
 * Which trending tag names are TOPICS a reader can browse, as opposed to
 * community ids and reward-tribe tags that dominate the head of
 * `get_trending_tags`.
 *
 * ★ COPIED FROM `features/layouts/right-rail/topics.tsx` (2026-09-05), where the
 * same three rules were written for the Topics card, because that file is a
 * `'use client'` component and this rule now also has to run on the server
 * (the suggest route). Keep the two lists in step; the card's own comment
 * explains each exclusion.
 */
const COMMUNITY_ID = /^hive-\d+$/i;

/** The blank root tag and a couple of moderation/system tags. */
const EXCLUDED_TAGS = new Set(['', 'nsfw', 'test']);

const REWARD_TRIBE_TAGS = new Set([
  'pob', 'proofofbrain', 'neoxian', 'cent', 'waivio', 'waiv', 'pimp', 'archon',
  'palnet', 'creativecoin', 'vyb', 'ctp', 'alive', 'oneup', 'lassecash', 'bbh',
  'burnpost', 'hbd', 'hive', 'ecency', 'peakd', 'listnerds', 'dbuzz',
  'posh', 'curation', 'blog'
]);

export function isBrowsableTopic(name: string): boolean {
  const tag = (name ?? '').toLowerCase();
  return !EXCLUDED_TAGS.has(tag) && !COMMUNITY_ID.test(tag) && !REWARD_TRIBE_TAGS.has(tag);
}
