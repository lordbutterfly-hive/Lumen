// Lumen retention — shared types.
//
// ONE VISIBLE SYSTEM: the LADDER. Nine numbered rungs, every one of them a real
// light source (Spark … Lumen — see lib/tiers.ts), keystone-gated on three
// independent measured arms: received engagement (distinct credited givers),
// account tenure, and rolling active-weeks. The rungs are combined with MIN(), so
// you can never rise past your weakest arm — that MIN is the anti-farm heart of
// the whole feature.
//
// ★ WHY THERE IS NO DARK BAND ANY MORE (2026-08-09, owner).
//
// The previous ladder opened Void → Abyss → Smoke → Ash. Every one of those four
// names is an ABSENCE, so applied to a person they read as an insult: "you're
// Smoke" is not a rank, it is a verdict. And the thing they were naming is OUR
// failure, not the reader's — a new account has no audience because the algorithm
// has not distributed it yet. Naming that "Void" is the frontend blaming the user
// for the frontend's job. Every rung is now something that is actually alight, and
// rung 1 says the true thing instead: nobody has found you yet, and that is on the
// algorithm.
//
// ★ WHY REPUTATION IS GONE (2026-08-09, owner).
//
// The 2026-07-20 build map defined the engagement keystone as received
// stake-weighted engagement, "weight by the GIVER's stake". The implementation
// threw the measurement away and substituted the account's OWN Hive reputation as
// a proxy, which is a different quantity — one measures who values you, the other
// measures how old and big your Hive account is. It also capped the ladder: three
// of nine rungs were arithmetically unawardable, and no account under reputation
// 61 could earn the byline mark at ANY level of real engagement. The arm now
// counts credited distinct givers, which is both the specified quantity and a
// COUNTABLE — so the UI can say "12 more people" instead of a paragraph of prose.
//
// WHAT IS NOT HERE ANY MORE:
//   - Divisions ("Beacon IV"). The division number was `standing % 25`, i.e. a
//     different quantity from the one that chose the tier — 29.2% of pairs
//     inverted, so a *lower* standing could print a *better* numeral. Cut, not
//     repaired: the rung number (1..9) is now the only granularity.
//   - The reputation proxy and every constant that existed to apologise for its
//     ceiling (PROXY_BAND_CEILING, MAX_AWARDABLE_*, UNAWARDABLE_TIERS,
//     isCeilingLimited, bylineTierFromReputation).
//
// The streak SURVIVES (lib/compute-streak.ts): it is chain-derived, and its
// active-weeks output is one of the three ladder arms. Streak LENGTH is never an
// input to the ladder on its own (anti-farm invariant AF-1).

/** The nine rungs, floor → apex. Numbering lives in lib/tiers.ts (`order`). */
export enum LeagueTier {
  /**
   * ★★ RANK 0 — WHERE EVERY ACCOUNT STARTS (owner, 2026-08-09: "no one gets rank 7 off the
   * bat. everyone is rank 0, its based off of activity").
   *
   * Before this, the ladder was seeded from LIFETIME HIVE STANDING: the tenure arm was days
   * since Hive account creation, so @gtg imported 2016 and saturated it, and the engagement arm
   * counted votes on Hive posts, which an established account has by the thousand. The result
   * was that a Hive veteran walked into Lumen at rank 8 of 9 without doing anything here, and a
   * newcomer could not catch up by any amount of effort. A ladder that is handed to you is not a
   * ladder.
   *
   * Unranked is NOT one of the four absence-names this ladder deleted (Void/Abyss/Smoke/Ash).
   * Those were verdicts on people who had published for years — "you're Smoke". This is the
   * honest state of an account nothing has been measured on yet, it is true of EVERYONE on their
   * first day, and it is temporary by construction: one post or comment leaves it.
   */
  Unranked = 'unranked',
  Spark = 'spark',
  Ember = 'ember',
  Candle = 'candle',
  Lantern = 'lantern',
  Torch = 'torch',
  Beacon = 'beacon',
  Halo = 'halo',
  Aurora = 'aurora',
  Lumen = 'lumen'
}

/**
 * Three visual bands. The emblem frame is chosen from this (one frame per band),
 * so there are exactly three and they are contiguous blocks of the ladder.
 *
 * The band boundary and the byline-mark boundary are THE SAME LINE on purpose: a
 * ring around your light is exactly the claim "other people navigate by this",
 * and that is the claim the mark makes. No rung is ever drawn as an absence —
 * every one of them has a real filled flame, because every one of them is a real
 * light. What changes up the ladder is how far it carries.
 */
export enum LeagueBand {
  /** Ranks 0-4 (Unranked … Lantern) — a light you are holding. No byline mark. */
  Kindling = 'kindling',
  /** Rungs 5-7 (Torch, Beacon, Halo) — ringed. Other people steer by it. Mark appears. */
  Signal = 'signal',
  /** Rungs 8-9 (Aurora, Lumen) — sky scale. Ringed, rayed, and alive at profile size. */
  Celestial = 'celestial'
}

/**
 * Which arm a rank was decided by.
 *
 * ★★ THERE IS ONLY ONE NOW (owner, 2026-08-09). It was
 * `'engagement' | 'tenure' | 'activeWeeks'`, combined with MIN — and the MIN was documented
 * here as "the anti-farm heart of the whole feature". It is gone, and the replacement is
 * stronger rather than weaker: the single arm counts DISTINCT DAYS on which you did something,
 * observed by Lumen, and a day is not purchasable. The old engagement arm counted votes, which
 * are botted and buyable; the old tenure arm counted Hive account age, which is neither earned
 * nor loseable. A calendar cannot be farmed faster than a calendar.
 */
export type LeagueArm = 'activity';

/**
 * What the arm is counted IN. One unit now: active days observed by Lumen. 'people' and
 * 'weeks' went with the arms that used them.
 */
export type LeagueArmUnit = 'days';

export interface LeagueRank {
  tier: LeagueTier;
  /** 1..9. Always shown, so a user never has to infer where they stand. */
  rankNumber: number;
  /** 9. Carried on the wire so a client never has to hardcode the ladder length. */
  totalRanks: number;
  // ★ `standing` IS GONE (2026-08-09). It was a 0..100 weighted AVERAGE of the three
  // arms, shipped on the wire, asserted in tests, and rendered by NOTHING — its only
  // documentation was a warning telling engineers not to display it, after doing so
  // overstated progress by 40 points on a real account. That is precisely the
  // "computed and thrown away" pattern this rework deleted `totalVotesOnSample` for,
  // reintroduced one file over. A council seat caught it. `progressToNext` +
  // `remainingToNext` are the honest pair and the only ones anything reads.
  /** True from Torch (rung 5) up. */
  showBylineEmblem: boolean;
  /** The arm that decided this rank: the weakest one, ties broken by least progress. */
  bindingArm: LeagueArm;
  /**
   * 0..1 through the binding arm's current band — how close that arm is to
   * stopping holding you here. It is the only honest progress number available,
   * because the binding arm is precisely the one that has to move for the rung to
   * change. Safe to render as a bar that is expected to fill: every arm now
   * measures something reachable, so nothing is pinned below 1 forever.
   */
  progressToNext: number;
  /**
   * ★ THE COUNTABLE. How many more of `armUnit` the binding arm needs before the
   * rung changes. `null` only at the top of the ladder.
   *
   * This field is the entire reason reputation had to go. Reputation is a
   * lifetime log-scale accumulator, so "how much more do I need" had no honest
   * answer and the UI substituted a paragraph of advice for it — nine static
   * strings telling people to "get read by people who don't already know you".
   * A count needs no prose: "12 more people".
   */
  remainingToNext: number | null;
  /** The unit `remainingToNext` is in. */
  armUnit: LeagueArmUnit;
  /**
   * True when filling `remainingToNext` really does reach `nextTier`.
   *
   * It is false when TWO arms sit on the same lowest index: raising one leaves the
   * other one binding at the old index, so the rung does not move and a UI that
   * printed "12 more people → Beacon" would be promising something the MIN cannot
   * deliver. The count itself is always honest; only the destination is
   * conditional. This is "you cannot out-post a missing one", expressed as a flag.
   */
  nextTierGuaranteed: boolean;
  /** The rung above, or undefined at the top of the ladder. */
  nextTier?: LeagueTier;
}

/**
 * The interesting numbers. Every one of these is measured, and most were already
 * being computed and thrown away before 2026-08-09 (`totalVotesOnSample` was
 * summed in the route, declared on `ChainFacts`, and read by nothing).
 *
 * Anything that cannot be stated honestly is ABSENT rather than zero — a missing
 * field renders no line, while a `0` renders a false one.
 */
export interface RetentionStats {
  /**
   * Distinct people who UPVOTED this account's sampled posts, self excluded. A
   * headcount, not the trust-weighted figure.
   *
   * ★ IT IS VOTERS, AND THE COPY HAS TO SAY VOTERS (2026-08-09, found by re-deriving
   * the number a UX tester liked most). The route builds it as
   * `givers.established + givers.unknown` out of `getActiveVotes` — so it is a count
   * of accounts that pressed upvote, never a count of people who READ anything. The
   * string rendering it said "1237 people read you", which named a quantity this
   * product does measure (`feedsReached`, distinct viewers served in a feed) and put
   * a different, larger-sounding one behind it. Two honest numbers, one of them
   * wearing the other's label. Both now say what they are.
   */
  people: number;
  /** How many of those engaged for the first time inside the window. */
  newPeople?: number;
  /**
   * The most recent first-time giver. Absent unless `newPeople` is also present —
   * both wait on the same "have we been watching long enough" gate.
   */
  newestGiverName?: string;
  /**
   * How many posts the headcount above was read from.
   *
   * ★ ON THE STATS OBJECT, NOT ONLY IN PROVENANCE, because the sentence that states the
   * headcount is where its scope has to live. A standalone footnote is how "1731 people" +
   * "At least 115800 votes" + "Counted across the last 8 posts" ended up on one card with
   * one caveat and three different denominators.
   */
  peopleOverPosts?: number;
  // ════ THE VOTE-AMOUNT FIELDS ARE DELETED (owner ruling, 2026-08-09) ════
  //
  // `votesReceived`, `postsRead`, `postsWithEngagement`, `bestPostVotes`, `bestPostTitle`
  // and `bestPostUrl` were all here. "vote amounts dont matter, theyre all botted", and a
  // windowed count of votes or comments may not be printed at all: "you cant list votes and
  // comments and not have it for all time. if thats the case then drop it."
  //
  // Removed from the TYPE and from the response, not just from the UI, so no future surface
  // can rediscover a botted number and print it. See act-stats.ts for the full reasoning
  // and for the specific reason `postsWithEngagement` could not be repaired: its sample is
  // the 8 most recent posts, which on a chain with curation trails is 100% for anyone with
  // an audience (5 of 5 accounts measured: 2/2, 6/6, 8/8, 4/4, 8/8).
  /** Longest run of consecutive active days anywhere in the stored history. */
  longestStreakDays?: number;
  /** 0 = Sunday … 6 = Saturday: the weekday this account acts on most. */
  busiestWeekday?: number;
  /** Acts recorded on that weekday, so the claim can be checked. */
  busiestWeekdayActs?: number;
  /**
   * Longest run of consecutive days with NO act, in days.
   *
   * ★ ABSENT UNLESS `coverage.historyComplete`. A missing day inside a clock-truncated walk
   * is a hole in what was read, not a silence — publishing it anyway would report somebody's
   * unwalked months as a break they never took. Same flag, same reason, as
   * `longestStreakDays` rendering "9+".
   */
  longestGapDays?: number;
  /**
   * Total days this account has ever shown up, as far as the store knows. A floor until
   * `coverage.historyComplete` — accumulating, because `lumen_hive_act_day` is additive.
   */
  activeDaysTotal?: number;
  /**
   * Words this account has been observed to write, across posts and comments, over five
   * windows: today, 7 days, 30 days, 365 days, and everything stored.
   *
   * ★ WORDS, NOT LINES. A markdown "line" counts how the author's editor wraps; words
   * survive the round trip and are the only unit a page count can honestly come from.
   *
   * ★ FIVE WINDOWS, NOT ONE, AND THE CLIENT ROTATES BETWEEN THEM (owner, 2026-08-18).
   * Stored per (account, day) — migration 0038 — so every window is a `SUM` over a
   * contiguous prefix of one primary-key scan and the whole set costs what the single
   * lifetime figure cost. The rotation happens at RENDER time (`pickWordWindow`) rather
   * than in the route, because the response is cached for five minutes and a
   * server-chosen window would freeze until it expired.
   *
   * FLOORNESS IS PER WINDOW and runs the opposite way to intuition: the feed walk reads
   * newest-first under a clock, so the recent end is always covered and the far end is
   * what truncates. `all` is a floor until `coverage.historyComplete`; the rest are floors
   * only when `coverage.completeFrom` is later than where they start. ABSENT, never a
   * zeroed object, when it could not be measured.
   */
  wordsWritten?: AuthoredWordWindows;
  /**
   * Percentile of this account's lifetime word count against everyone we hold a count for.
   * Absent when the population is too small to place anybody honestly.
   */
  wordsPercentile?: number;
  /**
   * Posts and replies in the window.
   *
   * ★ FOR THE RATIO ONLY. These are 26-week counts, and a windowed count of comments may not
   * be printed ("you cant list votes and comments and not have it for all time"). The ratio
   * derived from them is a different animal: a shape rather than a total, stable whatever the
   * window, and the most identity-defining fact available about a Hive account — most people
   * are certain whether they are a poster or a replier and most are wrong. Render
   * "you reply 4 times for every post"; never render either figure.
   *
   * ★★ NEVER RENDER THE RATIO WITHOUT CHECKING WALK DEPTH FIRST (found live, 2026-08-11).
   * These two counts come from INDEPENDENT feed walks (route.ts:735-736) that each truncate
   * on their own clock/page budget, and under load they read to very different depths —
   * measured live at ~185 days for posts against ~21-32 days for replies. A ratio built from
   * two spans of different length is not a ratio of the same thing: it printed "Posts and
   * replies about equally" for a user whose real rate was ~10.2 replies per post.
   * `retention-stats.tsx`'s `walksAreComparablyDeep` is the gate — it reads THIS REQUEST's own
   * two walk boundaries (`provenance.coverage.postsOldestSeen` / `commentsOldestSeen`), never
   * the STORED-UNION completeness flags (`coverage.activeWeeksIsLowerBound`,
   * `coverage.historyComplete`), which go true forever the first time either walk ever
   * finishes and would silently reintroduce this exact bug behind a gate that looks like a fix.
   */
  postsInWindow?: number;
  repliesInWindow?: number;
  /** Distinct viewer feeds this account's posts landed in, inside the window. */
  feedsReached?: number;
  /**
   * The same count over the PRECEDING window, so reach can be stated as a direction
   * rather than a frozen figure ("no trend anywhere" was the single most repeated UX
   * complaint: every number on the card is a still photograph).
   *
   * ABSENT, NEVER ZERO — and the client must not render a trend when it is absent or
   * zero. `lumen_feed_served` only has rows from the day the table started filling,
   * so on a young install the previous window is empty and "340 more than last week"
   * would be an artefact of our own history rather than a fact about the account.
   * Same guard, and the same reason, as `newPeople`.
   */
  feedsReachedPrev?: number;
}

/**
 * Today. ONE number, since 2026-08-18.
 *
 * ★ IT USED TO CARRY A GOAL AND A FREEZE BUDGET, AND BOTH ARE DELETED (owner: "strip
 * that out compeletely. no setting of anyhting... no freezes"). `goal` was the reader's
 * chosen acts-per-day target and it GATED the streak; `freezesAvailable` /
 * `freezesUsedRecently` reported a banked mercy that bridged missed days. Neither has
 * anything to do any more: the streak decays rather than resetting, so there is no cliff
 * to soften and no target to fail.
 *
 * `acts` counts AUTHORED acts today — posts and comments, never votes. That is not a
 * simplification, it is the one currency both ladders can measure symmetrically: a
 * Hive user's vote broadcasts from their browser and never touches this server, and
 * reading it needs an API that is not registered. A streak fed by votes would be
 * tickable by lite users and untickable by Hive users doing the same thing, which is
 * an inequity rather than a measurement. Their posts and comments are on chain and
 * this route already reads them.
 */
/** Words authored inside each window. See `RetentionStats.wordsWritten`. */
export interface AuthoredWordWindows {
  /** Today, UTC. */
  day: number;
  /** The trailing 7 days, today included. */
  week: number;
  /** The trailing 30 days. */
  month: number;
  /** The 30 days before that, so the month can carry a direction. */
  monthPrior: number;
  /** The trailing 365 days. */
  year: number;
  /** Everything the store holds. */
  all: number;
}

export interface RetentionToday {
  /** Authored acts today, UTC. Chain-derived and exact. */
  acts: number;
}

export interface RetentionSummary {
  username: string;
  rank: LeagueRank;
  /**
   * Chain-derived. +1 for each day with a genuine authored act, -2 for each day
   * without one, floored at zero and accumulated forward from the day Lumen started
   * counting the account. NOT a count of consecutive days — see compute-streak.ts.
   */
  streakDays: number;
  /** Chain-derived: distinct active weeks in the trailing 26. Also a ladder arm. */
  activeWeeks: number;
  tenureYear: number; // "Member since <year>"
  /** Honest "what's gating your next promotion" meters, each 0..1. */
  /** ONE meter now: the activity arm as a 0..1 fraction. The other two arms are deleted. */
  gate: { activity: number };
  /** The interesting numbers. Absent on a path that cannot measure them. */
  stats?: RetentionStats;
  /** The daily loop. Absent on a path that does not serve it. */
  today?: RetentionToday;
}
