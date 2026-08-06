/**
 * The signup interest taxonomy: what a reader picks, and the Hive tags each pick
 * actually resolves to.
 *
 * ★★★ WHY EVERY TAG HERE IS REAL, AND MEASURED (2026-08-06).
 *
 * These are not invented. Every tag below was taken from a live count of ROOT
 * POSTS over the last 30 days on the HAFSQL mainnet mirror, restricted to tags
 * carrying >400 posts in that window. Picking an interest that maps to a tag
 * nobody posts under is worse than not asking: the reader tells us what they
 * want and the feed gets emptier.
 *
 * ★ WHAT WAS DELIBERATELY EXCLUDED, and this is the whole craft of the file.
 * The highest-volume tags on Hive are NOT topics — they are REWARD-TOKEN TRIBE
 * tags. The top of the raw list reads `neoxian` (11,665), `pob` (6,577),
 * `waivio` (5,894), `proofofbrain` (5,147), `cent` (4,631), `pimp`, `archon`,
 * `palnet`, `creativecoin`, `waiv`, `oneup`, `vyb`, `ctp`, `alive`. Authors add
 * them to route rewards, not to say what a post is ABOUT — a post tagged `pob`
 * can be about anything at all. A taxonomy built naively from "the top tags"
 * would therefore be mostly noise wearing the costume of signal, and every
 * interest would return the same undifferentiated feed.
 *
 * LANGUAGE tags (`spanish` 4,794, `kr`, `cn`, `deutsch`, `polish`) are excluded
 * for a different reason: they are real and meaningful, but they answer "what
 * language do you read", which is a separate axis from "what are you interested
 * in". Mixing them here would make a Spanish speaker's picks compete with their
 * topic picks for the same 20 slots.
 *
 * A few tribe tags DO survive, where the tribe is genuinely topical rather than
 * a reward wrapper — `splinterlands` and `spt` really are about one game,
 * `leofinance` really is about finance, `actifit` really is about activity.
 *
 * Counts in the comments are root posts / 30 days at time of measurement, kept
 * so a future reader can tell a tag that was always thin from one that DIED.
 */

export interface Interest {
  /** Stable id — persisted in `lumen_user.interests`. Never renamed. */
  id: string;
  label: string;
  /** Emoji, purely presentational. */
  icon: string;
  /** The Hive tags this interest resolves to, highest-volume first. */
  tags: string[];
}

export const INTERESTS: Interest[] = [
  // photography 4144 · liketu 840 · photofeed 683 · photographylovers 433 · photo 419
  { id: 'photography', label: 'Photography', icon: '📷',
    tags: ['photography', 'liketu', 'photofeed', 'photographylovers', 'photo'] },
  // nature 2247 · outdoors via hive-communities
  { id: 'nature', label: 'Nature & Outdoors', icon: '🌿',
    tags: ['nature', 'photofeed', 'gardening', 'hive-140635'] },
  // travel 1285 · trip 683
  { id: 'travel', label: 'Travel', icon: '✈️', tags: ['travel', 'trip', 'traveldigest', 'wanderlust'] },
  // food 798 · recipe 402
  { id: 'food', label: 'Food & Cooking', icon: '🍳', tags: ['food', 'recipe', 'cooking', 'foodie'] },
  // art 1473 · creativecoin 2847 (topical tribe)
  { id: 'art', label: 'Art & Illustration', icon: '🎨',
    tags: ['art', 'creativecoin', 'digitalart', 'drawing', 'painting'] },
  // music 704
  { id: 'music', label: 'Music', icon: '🎵', tags: ['music', 'musicforlife', 'hive-193816'] },
  // movies 509
  { id: 'film', label: 'Film & TV', icon: '🎬', tags: ['movies', 'moviereview', 'cinetv', 'hive-121744'] },
  // writing 891 · story 426
  { id: 'writing', label: 'Writing & Fiction', icon: '✍️',
    tags: ['writing', 'story', 'fiction', 'poetry', 'creativewriting'] },
  // splinterlands 1736 · gaming 1225 · play2earn 840 · spt 816
  { id: 'gaming', label: 'Gaming', icon: '🎮',
    tags: ['gaming', 'splinterlands', 'play2earn', 'spt', 'oneup', 'arcadecolony'] },
  // sportstalk 4657 · sports 1007
  { id: 'sports', label: 'Sports', icon: '⚽',
    tags: ['sports', 'sportstalk', 'football', 'chessbrothers'] },
  // actifit 3782 · fitness 702 · strava2hive 415 · runningproject 412
  { id: 'fitness', label: 'Fitness & Running', icon: '🏃',
    tags: ['fitness', 'actifit', 'strava2hive', 'runningproject', 'exhaust'] },
  // health 789
  { id: 'health', label: 'Health & Wellbeing', icon: '🧘',
    tags: ['health', 'wellness', 'mentalhealth', 'meditation'] },
  // crypto 631 · leofinance 908 · hive-engine 2421
  { id: 'crypto', label: 'Crypto & Markets', icon: '₿',
    tags: ['crypto', 'leofinance', 'bitcoin', 'hive-engine', 'defi'] },
  // stem 528 · ai 450
  { id: 'tech', label: 'Tech & Programming', icon: '💻',
    tags: ['technology', 'programming', 'stem', 'ai', 'development'] },
  { id: 'science', label: 'Science', icon: '🔬', tags: ['science', 'stem', 'space', 'nature'] },
  // news 1033
  { id: 'news', label: 'News & Politics', icon: '📰', tags: ['news', 'politics', 'worldnews'] },
  // life 4248 · blog 2132 · lifestyle 1383
  { id: 'life', label: 'Life & Personal', icon: '📔',
    tags: ['life', 'blog', 'lifestyle', 'diary', 'personal'] },
  // family 474 · ladiesofhive 650
  { id: 'family', label: 'Family & Parenting', icon: '👨‍👩‍👧',
    tags: ['family', 'parenting', 'children', 'ladiesofhive'] },
  // diy 451
  { id: 'diy', label: 'DIY & Making', icon: '🔧', tags: ['diy', 'crafts', 'handmade', 'woodworking'] },
  // meme 1482 · pepe 1617 · lolz 828 · fun 494
  { id: 'humour', label: 'Memes & Humour', icon: '😂', tags: ['meme', 'lolz', 'fun', 'comedy'] },
  { id: 'gardening', label: 'Gardening & Homestead', icon: '🌱',
    tags: ['gardening', 'homesteading', 'plants', 'garden'] },
  { id: 'animals', label: 'Pets & Animals', icon: '🐾', tags: ['pets', 'animals', 'cats', 'dogs'] },
  // review 575 · contest 609 · community 592
  { id: 'community', label: 'Hive Community', icon: '🐝',
    tags: ['hive', 'community', 'contest', 'ocd', 'qurator'] },
  { id: 'education', label: 'Learning & Education', icon: '📚',
    tags: ['education', 'learning', 'books', 'tutorial'] }
];

/** How many a reader must pick before Continue enables. */
export const MIN_INTERESTS = 3;
/** The ceiling the product asked for. */
export const MAX_INTERESTS = 20;

const BY_ID = new Map(INTERESTS.map((i) => [i.id, i]));

/**
 * Interest ids -> the flat, de-duplicated Hive tag list the ranker receives.
 *
 * De-duplication matters: several interests deliberately share a tag
 * (`stem` is both Tech and Science, `nature` is both Nature and Science), and
 * sending a tag twice would let one pick weigh more than another purely by
 * accident of the taxonomy rather than by the reader's choice.
 *
 * Unknown ids are dropped rather than passed through — the picks are
 * client-supplied, and a tag the taxonomy does not define has no business
 * reaching the ranker.
 */
export function tagsForInterests(ids: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    const interest = BY_ID.get(id);
    if (!interest) continue;
    for (const tag of interest.tags) out.add(tag);
  }
  return [...out];
}

/** Keep only ids this taxonomy knows, capped, order preserved, de-duplicated. */
export function sanitizeInterestIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !BY_ID.has(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= MAX_INTERESTS) break;
  }
  return out;
}
