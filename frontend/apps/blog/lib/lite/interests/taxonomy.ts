/**
 * The signup interest taxonomy: what a reader picks, and the Hive tags each pick
 * actually resolves to.
 *
 * ★★★ WHY EVERY TAG HERE IS REAL, AND MEASURED (2026-08-06, EXPANDED 2026-08-09).
 *
 * These are not invented. Every tag below was taken from a live count of ROOT
 * POSTS on the HAFSQL mainnet mirror. The expansion re-used the measured table
 * the ranker already ships — `recsys/core/scoring.py::_TAG_DF_RAW`: 38,478 root
 * posts over 30 days, 3,759 distinct tags, the top 500 retained with their
 * frequencies — rather than re-deriving it or guessing. Counts in the comments
 * below are root posts / 30 days from that table, kept so a future reader can
 * tell a tag that was always thin from one that DIED. A tag with no count shown
 * was BELOW the top-500 cut (df < 59) and is carried only as a sourcing hint.
 *
 * ★ WHAT WAS DELIBERATELY EXCLUDED, and this is the whole craft of the file.
 * The highest-volume tags on Hive are NOT topics — they are REWARD-TOKEN TRIBE
 * tags. The top of the raw list reads `neoxian` (12,073), `pob` (6,665),
 * `waivio` (5,887), `proofofbrain` (5,306), `cent` (4,678), `pimp`, `archon`,
 * `palnet`, `creativecoin`, `waiv`, `oneup`, `vyb`, `ctp`, `alive`. Authors add
 * them to route rewards, not to say what a post is ABOUT — a post tagged `pob`
 * can be about anything at all. A taxonomy built naively from "the top tags"
 * would therefore be mostly noise wearing the costume of signal, and every
 * interest would return the same undifferentiated feed. The ranker keeps the
 * same list, with its reasoning, at `recsys/viewer.py::_NON_TOPICAL_TAGS`; this
 * file honours it rather than keeping a second copy that could drift.
 *
 * LANGUAGE AND COUNTRY tags (`spanish` 4,907, `kr`, `cn`, `deutsch`, `polish`,
 * `indiaunited` 1,025, `hiveph`, `venezuela`, `hivecuba`) are excluded for a
 * different reason: they are real and meaningful, but they answer "what language
 * / where do you read", which is a separate axis from "what are you interested
 * in". Mixing them here would make a Spanish speaker's picks compete with their
 * topic picks for the same 20 slots.
 *
 * A few tribe tags DO survive, where the tribe is genuinely topical rather than
 * a reward wrapper — `splinterlands` and `spt` really are about one game,
 * `leofinance` really is about finance, `actifit` really is about activity,
 * `arcadecolony` really is about gaming. They are never the FIRST tag of an
 * interest (see the publishing note below).
 *
 * ★★★ TWO JOBS, AND `tags[0]` IS THE ONE THAT LEAVES THE BUILDING (2026-08-09).
 *
 * This list is now read for two different purposes, and they do NOT want the
 * same vocabulary:
 *
 *  1. SOURCING + RANKING. `tagsForInterests` hands the ranker the WHOLE list,
 *     which decides what the interest lane fetches and what the declared-interest
 *     term matches. Breadth is good here: community ids (`hive-13323`), challenge
 *     tags (`monomad`, `wednesdaywalk`) and app tags (`liketu`) are all excellent
 *     evidence of subject even though no human would type them.
 *  2. PUBLISHING. A normal-tier lite post is now tagged with its author's
 *     declared interests (`lib/lite/content/post-service.ts`) and that goes to a
 *     public blockchain, permanently. Here breadth is a LIE: tagging a post
 *     `monomad` enters it into somebody else's photo challenge, `liketu` claims
 *     it was posted from an app it was not, and `hive-13323` files it under a
 *     community the author never joined.
 *
 * So `tags[0]` of every interest is a plain, honest, human-typeable topic word,
 * and `publishTagsForInterests` emits ONLY those. Everything after index 0 is
 * sourcing-only and never reaches the chain. Keep it that way: if you add a
 * challenge tag, a community id or an app tag, it goes at the END, never first.
 */

export interface Interest {
  /** Stable id — persisted in `lumen_user.interests`. Never renamed. */
  id: string;
  label: string;
  /** Emoji, purely presentational. */
  icon: string;
  /**
   * Presentation only: which section of the picker this sits under. A flat wall
   * of 48 pills is worse to choose from than 23 was; sections are how coverage
   * grows without the picker becoming an eye test. Not persisted, not sent to
   * the ranker.
   *
   * SECTION ORDER IS THIS ARRAY'S ORDER — the picker groups by first appearance
   * rather than reading a second list that could fall out of sync with it. Keep
   * each group's entries contiguous below.
   */
  group: string;
  /**
   * The Hive tags this interest resolves to, highest-volume first.
   * ★ `tags[0]` IS PUBLISHED ON CHAIN — see the file header. It must be a real
   * topic word, never a community id, challenge tag or app name.
   */
  tags: string[];
}

export const INTERESTS: Interest[] = [
  // ---------------------------------------------------------------- Photos & art
  // photography 4180 · photofeed 687 · photographylovers 426 · photo 418 ·
  // photos 123 · liketu 830 (app, sourcing-only) · hive-194913 Photography
  // Lovers 210 · hive-153349 PhotoFeed 125
  { id: 'photography', label: 'Photography', icon: '📷', group: 'Photos & art',
    tags: ['photography', 'photofeed', 'photographylovers', 'photo', 'photos', 'liketu',
      'hive-194913', 'hive-153349'] },
  // blackandwhite 370 · monomad 389 (daily challenge, sourcing-only) ·
  // colourblackandwhite 77 · shadows 75 · monochrome 60 · hive-142159 Black And
  // White 165 · hive-179017 Shadow Hunters 179
  { id: 'blackandwhite', label: 'Black & White', icon: '⚫', group: 'Photos & art',
    tags: ['blackandwhite', 'monochrome', 'monomad', 'colourblackandwhite', 'shadows',
      'hive-142159', 'hive-179017'] },
  // street 200 · streetphotography 110 · architecture 114 · landscape 113 ·
  // streetart 60
  { id: 'cityscape', label: 'Street & Architecture', icon: '🏙️', group: 'Photos & art',
    tags: ['streetphotography', 'architecture', 'street', 'streetart', 'landscape'] },
  // art 1459 · drawing 309 · painting 146 · digitalart 122 · illustration 94 ·
  // hiveartgallery 170 · onchainart 96 · alienarthive 67 · hive-158694 Alien Art
  // Hive 103. `creativecoin` (2946) is REMOVED: it is a reward tribe
  // (`_NON_TOPICAL_TAGS`), and it was being published on real posts.
  { id: 'art', label: 'Art & Illustration', icon: '🎨', group: 'Photos & art',
    tags: ['art', 'painting', 'digitalart', 'illustration', 'fineart', 'hiveartgallery',
      'onchainart', 'hive-158694'] },
  // sketchbook 138 · sketch 141 · drawing 309 · hive-174301 Sketchbook 370
  { id: 'drawing', label: 'Drawing & Sketching', icon: '✏️', group: 'Photos & art',
    tags: ['drawing', 'sketch', 'sketchbook', 'hive-174301'] },
  // handmade 126 · needlework 111 · crochet 65 · crafts 73
  { id: 'crafts', label: 'Crafts & Needlework', icon: '🧶', group: 'Photos & art',
    tags: ['handmade', 'needlework', 'crochet', 'crafts'] },
  // diy 459 · diyhub 134 · hivediy 102 · hive-189641 DIYHub 66
  { id: 'diy', label: 'DIY & Making', icon: '🔧', group: 'Photos & art',
    tags: ['diy', 'diyhub', 'hivediy', 'hive-189641'] },

  // -------------------------------------------------------------- Words & ideas
  // writing 906 · story 425 · fiction 314 · stories 67 · creativewriting 67 ·
  // writingcommunity 65 · theinkwell 88 · hive-170798 The Ink Well 94
  { id: 'writing', label: 'Writing & Fiction', icon: '✍️', group: 'Words & ideas',
    tags: ['writing', 'story', 'fiction', 'stories', 'creativewriting', 'writingcommunity',
      'theinkwell', 'hive-170798'] },
  // poetry 182 · poem 87
  { id: 'poetry', label: 'Poetry', icon: '🕊️', group: 'Words & ideas',
    tags: ['poetry', 'poem'] },
  // freewrite 354 · freewriters 188 · freewritehouse 124 · dailyprompt 251 ·
  // inkwellprompt 64 · hive-161155 Freewriters 343. Prompt tags are
  // sourcing-only: they enter somebody's exercise, they do not describe a post.
  { id: 'freewrite', label: 'Freewriting & Prompts', icon: '⏱️', group: 'Words & ideas',
    tags: ['freewrite', 'freewriters', 'hive-161155', 'freewritehouse', 'dailyprompt',
      'inkwellprompt'] },
  // book 93 · literature 105 · bookreview 59
  { id: 'books', label: 'Books & Reading', icon: '📖', group: 'Words & ideas',
    tags: ['book', 'bookreview', 'literature'] },
  // philosophy 318 · hive-thoughts 303 · thoughts 228 · opinion 148 ·
  // reflection 144 · reflections 107 · hive-126152 Reflections 105 · wisdom 79
  { id: 'philosophy', label: 'Philosophy & Reflection', icon: '🧠', group: 'Words & ideas',
    tags: ['philosophy', 'thoughts', 'reflection', 'reflections', 'wisdom', 'opinion',
      'hive-thoughts', 'hive-126152'] },
  // bible 359 · church 278 · scripture 232 · faith 101 · religion 72 ·
  // spirituality 65 · hive-142376 The Kingdom 75. `mcgi` (362), `mcgicares`
  // (318), `obedience` (231), `theoldpath` (62) and hive-182074 are ONE
  // organisation's campaign tags — real volume, but picking "Faith" should not
  // hand a reader a single church's posting schedule.
  { id: 'faith', label: 'Faith & Spirituality', icon: '🙏', group: 'Words & ideas',
    tags: ['faith', 'bible', 'church', 'scripture', 'religion', 'spirituality',
      'hive-142376'] },
  // history 261 · culture 119 · memories 90
  { id: 'history', label: 'History & Culture', icon: '🏛️', group: 'Words & ideas',
    tags: ['history', 'culture', 'memories'] },

  // -------------------------------------------------------------- Screen & play
  // music 685 · hive-193816 Music 88 · blocktunes 73
  { id: 'music', label: 'Music', icon: '🎵', group: 'Screen & play',
    tags: ['music', 'blocktunes', 'hive-193816'] },
  // movies 524 · cinetv 180 · movie 152 · film 130 · tvshow 92 ·
  // hive-166847 Movies & TV Shows 86 · television 68
  { id: 'film', label: 'Film & TV', icon: '🎬', group: 'Screen & play',
    tags: ['movies', 'movie', 'film', 'tvshow', 'television', 'cinetv', 'hive-166847'] },
  // anime 87 · scifimultiverse 78 · hive-111030 SciFi Multiverse 135
  { id: 'scifi', label: 'Anime & Sci-Fi', icon: '👽', group: 'Screen & play',
    tags: ['anime', 'scifimultiverse', 'hive-111030'] },
  // gaming 1220 · arcadecolony 1381 (topical tribe) · hivegaming 375 ·
  // hive-140217 Hive Gaming 370 · hive-185676 Gaming Photography 219 ·
  // games 200 · game 185 · hivegames 180 · gameplay 118 · videogames 113.
  // `oneup` (2347) is REMOVED: reward tribe, and it was being published.
  { id: 'gaming', label: 'Gaming', icon: '🎮', group: 'Screen & play',
    tags: ['gaming', 'games', 'videogames', 'gameplay', 'hivegaming', 'arcadecolony',
      'hive-140217', 'hive-185676'] },
  // splinterlands 1761 · hive-13323 Splinterlands 858 · spt 813 ·
  // steemmonsters 226
  { id: 'splinterlands', label: 'Splinterlands', icon: '🃏', group: 'Screen & play',
    tags: ['splinterlands', 'spt', 'steemmonsters', 'hive-13323'] },
  // play2earn 848 · risingstar 225 · terracore 123 · holozing 108
  { id: 'playtoearn', label: 'Play-to-Earn Games', icon: '🕹️', group: 'Screen & play',
    tags: ['play2earn', 'risingstar', 'holozing', 'terracore'] },
  // meme 1484 · lolz 794 · fun 479 · humor 131 · comedy 66. `pepe` (1641) is a
  // reward tribe despite the meme association — excluded.
  { id: 'humour', label: 'Memes & Humour', icon: '😂', group: 'Screen & play',
    tags: ['meme', 'lolz', 'fun', 'humor', 'comedy'] },

  // ------------------------------------------------------------------------ Life
  // life 4273 · blog 2154 · lifestyle 1423 · dailyblog 220 · diary 112 ·
  // hive-187189 Lifestyle 118 · hive-178265 Daily Blog 96
  { id: 'life', label: 'Life & Personal', icon: '📔', group: 'Life',
    tags: ['life', 'blog', 'lifestyle', 'diary', 'dailyblog', 'hive-187189', 'hive-178265'] },
  // family 486 · parenting 69 · children 68
  { id: 'family', label: 'Family & Parenting', icon: '👨‍👩‍👧', group: 'Life',
    tags: ['family', 'parenting', 'children'] },
  // ladiesofhive 672 · hive-124452 Ladies of Hive 240 · women 120 · loh 112
  { id: 'ladies', label: 'Ladies of Hive', icon: '💐', group: 'Life',
    tags: ['ladiesofhive', 'women', 'loh', 'hive-124452'] },
  // health 788 · wellness 119 · wellbeing 79 · mentalhealth 74 · psychology 180
  { id: 'health', label: 'Health & Wellbeing', icon: '🧘', group: 'Life',
    tags: ['health', 'wellness', 'wellbeing', 'mentalhealth', 'psychology'] },
  // mindset 150 · motivation 143 · inspiration 79 · gratitude 86 ·
  // hive-190931 Feel Good 86
  { id: 'mindset', label: 'Mindset & Motivation', icon: '✨', group: 'Life',
    tags: ['motivation', 'mindset', 'inspiration', 'gratitude', 'hive-190931'] },
  // paranormal 295 — one tag, and it out-posts `gardening` (160). Kept single
  // rather than padded with `conspiracy` (81), which is a different subject.
  { id: 'paranormal', label: 'Paranormal & Unexplained', icon: '👻', group: 'Life',
    tags: ['paranormal'] },
  // food 832 · recipe 412 · foodie 225 · foodies 184 · hive-100067 Hive Food 174
  // · eat 150 · hivefood 124 · cooking 89 · breakfast 83 · hive-120586 Foodies
  // Bee Hive 70. `pizza`/`hivepizza` are the PIZZA token — excluded.
  { id: 'food', label: 'Food & Cooking', icon: '🍳', group: 'Life',
    tags: ['food', 'recipe', 'foodie', 'foodies', 'cooking', 'eat', 'breakfast',
      'hivefood', 'hive-100067', 'hive-120586'] },
  // community 578 · contest 642 · introduceyourself 81 · hive-125125 Town
  // Square 480. `hive`, `ocd` and `qurator` are REMOVED: the first is the
  // namespace, the other two are curation-routing tags, and all three were
  // being published on real posts by the interest-tagging path.
  { id: 'community', label: 'Hive Community', icon: '🐝', group: 'Life',
    tags: ['community', 'contest', 'introduceyourself', 'hive-125125'] },

  // ------------------------------------------------------------------- Outdoors
  // nature 2254 · amazingnature 188 · natureobserver 126 · hive-130906 Nature
  // Observer 155 · sunset 79 · landscape 113
  { id: 'nature', label: 'Nature & Outdoors', icon: '🌿', group: 'Outdoors',
    tags: ['nature', 'amazingnature', 'natureobserver', 'landscape', 'sunset',
      'hive-130906'] },
  // insect 171 · birds 74 · wildlife 63 · macro 63 · hive-106444 Feathered
  // Friends 75
  { id: 'wildlife', label: 'Birds & Wildlife', icon: '🦜', group: 'Outdoors',
    tags: ['wildlife', 'birds', 'insect', 'macro', 'hive-106444'] },
  // gardening 160 · garden 156 · flowers 139 · flower 116 · homesteading 110 ·
  // hivegarden 99 · agriculture 88 · plants 71 · hive-140635 HiveGarden 68
  { id: 'gardening', label: 'Gardening & Homestead', icon: '🌱', group: 'Outdoors',
    tags: ['gardening', 'garden', 'flowers', 'plants', 'homesteading', 'agriculture',
      'hivegarden', 'hive-140635'] },
  // cat 171 · dog 159 · pets 98 · animals 89 · cats 88 · hivepets 65 · animal 61
  { id: 'animals', label: 'Pets & Animals', icon: '🐾', group: 'Outdoors',
    tags: ['pets', 'animals', 'cat', 'cats', 'dog', 'hivepets'] },
  // travel 1291 · trip 683 · worldmappin 323 · hive-163772 Worldmappin 296 ·
  // tourism 158 · travelfeed 123 · aroundtheworld 99 · adventure 81
  { id: 'travel', label: 'Travel', icon: '✈️', group: 'Outdoors',
    tags: ['travel', 'trip', 'tourism', 'adventure', 'travelfeed', 'worldmappin',
      'aroundtheworld', 'hive-163772'] },
  // walking 281 · walk 215 · wednesdaywalk 120 · hive-155530 Wednesday Walk 66
  { id: 'walking', label: 'Walking & Hiking', icon: '🚶', group: 'Outdoors',
    tags: ['walking', 'walk', 'wednesdaywalk', 'hive-155530'] },

  // ---------------------------------------------------------------------- Sport
  // fitness 718 · actifit 3799 (topical tribe) · hive-193552 Actifit 3196 ·
  // runningproject 416 · strava2hive 410 · running 212 · cycling 124 ·
  // hiverun 102
  { id: 'fitness', label: 'Fitness & Running', icon: '🏃', group: 'Sport',
    tags: ['fitness', 'running', 'cycling', 'actifit', 'runningproject', 'strava2hive',
      'hiverun', 'hive-193552'] },
  // sportstalk 4626 · sports 1086 · hive-101690 Sports Talk Social 338 ·
  // hive-115814 Sportsblock 184 · hivesport 132 · sport 113 · sportsblock 93
  { id: 'sports', label: 'Sports', icon: '🏅', group: 'Sport',
    tags: ['sports', 'sport', 'sportstalk', 'hivesport', 'sportsblock', 'hive-101690',
      'hive-115814'] },
  // football 280 · soccer 157 · worldcup 79
  { id: 'football', label: 'Football & Soccer', icon: '⚽', group: 'Sport',
    tags: ['football', 'soccer', 'worldcup'] },
  // chessbrothers 436 · chess 116
  { id: 'chess', label: 'Chess', icon: '♟️', group: 'Sport',
    tags: ['chess', 'chessbrothers'] },
  // skateboarding 370 · skatehype 359 · skate 353
  { id: 'skate', label: 'Skateboarding', icon: '🛹', group: 'Sport',
    tags: ['skateboarding', 'skate', 'skatehype'] },

  // -------------------------------------------------------------- Tech & science
  // technology 341 · programming 152 · tech 101 · internet 78 · linux 62
  { id: 'tech', label: 'Tech & Programming', icon: '💻', group: 'Tech & science',
    tags: ['technology', 'programming', 'tech', 'linux', 'internet'] },
  // ai 489 · robotics 60
  { id: 'ai', label: 'AI & Robotics', icon: '🤖', group: 'Tech & science',
    tags: ['ai', 'robotics'] },
  // stem 532 · stemsocial 386 · science 194 · steemstem 125 · hive-196387
  // StemSocial 75 · math 64
  { id: 'science', label: 'Science', icon: '🔬', group: 'Tech & science',
    tags: ['science', 'stem', 'stemsocial', 'math', 'steemstem', 'hive-196387'] },
  // hive-153850 Hive Learners 560 · education 228 · tutorial 196 · learning 120 ·
  // students 70 · hive-109584 Hive Student Connect 60
  { id: 'education', label: 'Learning & Education', icon: '📚', group: 'Tech & science',
    tags: ['education', 'learning', 'tutorial', 'students', 'hive-153850', 'hive-109584'] },
  // news 1043 · politics 258 · journalism 143 · analysis 76
  { id: 'news', label: 'News & Politics', icon: '📰', group: 'Tech & science',
    tags: ['news', 'politics', 'journalism', 'analysis'] },

  // ---------------------------------------------------------------------- Money
  // hive-engine 2519 · crypto 689 · bitcoin 289 · web3 272 · blockchain 221 ·
  // nft 188 · dao 100 · cryptocurrency 74 · btc 72
  { id: 'crypto', label: 'Crypto & Web3', icon: '₿', group: 'Money',
    tags: ['crypto', 'cryptocurrency', 'bitcoin', 'btc', 'blockchain', 'web3', 'nft',
      'dao', 'hive-engine'] },
  // leofinance 982 · hive-167922 LeoFinance 603 · finance 236 · investing 143 ·
  // money 132 · trading 107
  { id: 'finance', label: 'Finance & Investing', icon: '📈', group: 'Money',
    tags: ['finance', 'investing', 'trading', 'money', 'leofinance', 'hive-167922'] },
  // silvergoldstackers 133 · silver 98 · gold 74
  { id: 'metals', label: 'Gold & Silver', icon: '🥈', group: 'Money',
    tags: ['silver', 'gold', 'silvergoldstackers'] }
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
 * (`drawing` is both Art and Drawing, `landscape` is both Nature and Street),
 * and sending a tag twice would let one pick weigh more than another purely by
 * accident of the taxonomy rather than by the reader's choice.
 *
 * Unknown ids are dropped rather than passed through — the picks are
 * client-supplied, and a tag the taxonomy does not define has no business
 * reaching the ranker.
 *
 * ★ THIS IS THE SOURCING VOCABULARY, NOT THE PUBLISHING ONE. It is deliberately
 * wide (community ids, challenge tags, app tags) because breadth is what the
 * interest lane sources on. Do NOT use it to tag a post — see
 * `publishTagsForInterests`.
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

/**
 * Interest ids -> ONE honest topic tag each, in pick order, for writing onto a
 * public blockchain.
 *
 * ★★★ WHY THIS EXISTS AND WHY IT IS NOT `tagsForInterests().slice(0, n)`
 * (2026-08-09). The publisher caps interest tags at 4. Taking the first 4 of the
 * FLATTENED list takes them all from the reader's FIRST pick, because every
 * interest carries at least four tags: a reader who chose Photography, Chess and
 * Food published `[photography, photofeed, photographylovers, photo]` — four
 * spellings of one interest, with chess and food nowhere, and two of those four
 * are tags a human would never type. One tag per interest describes the author
 * across as many of their picks as the cap allows, and every tag emitted here is
 * a word a person could plausibly have typed themselves.
 *
 * Order follows the reader's own pick order, so the cap keeps what they chose
 * first — and `tags[0]` on Hive is the post's CATEGORY, so the first pick is
 * also what the post gets filed under.
 */
export function publishTagsForInterests(ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const interest = BY_ID.get(id);
    if (!interest) continue;
    const primary = interest.tags[0];
    if (!primary || seen.has(primary)) continue;
    seen.add(primary);
    out.push(primary);
  }
  return out;
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
