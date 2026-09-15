import type { Builder } from '@/blog/lib/builders-board-shape';

/**
 * ★★★ THE HIVE BUILDERS ROSTER — who is on the card, and which of their
 * posts count. Chain-free on purpose: the loader (`builders-board.ts`) reads
 * it, and the unit test replays real posts through it.
 *
 * ★ HOW IT WAS BUILT (2026-09-15). The top 100 witnesses by vote plus every
 * dapp/product account I could name were pulled — 126 accounts, their last 20
 * root posts each, with tags — and scored against the development vocabulary.
 * The score was a SCREEN, not the answer: the first pass read "100%
 * development" for tribe and curation accounts because `witness`, `update`
 * and an account's own name as a tag all matched. So the vocabulary was
 * tightened to words that name the act of building, and every account below
 * was then read post by post (owner, 2026-09-15: "you need to assess for each
 * of those builders. you need to check their content"). The rule next to each
 * entry is what that reading found; keep the reason next to any entry you add
 * or change. Modes are explained on `Builder`.
 *
 * Owner's exclusions: asgarth, good-karma, ecency, peakd. Owner's additions:
 * lordbutterfly, acidyo, holozing, techcoderlabz, magi.network, and Scrobble — which
 * lives on @acidyo's posts tagged `scrobble` (`@scrobble` is a curation
 * compilation account and `@scrobble.life` has no root posts).
 *
 * Left off, with the reason: deathwing (last dev post 2026-02-07),
 * disregardfiat (02-27), v4vapp (02-09), vsc.network (2025-11), techcoderx
 * (2025-11), stoodkev (2024-10, Keychain is carried by @keychain); quochuy
 * (witness EARNINGS reports), splinterlands (sticker shop, a memorial card),
 * risingstargame (a birthday post), skatehive (compilations); threespeak
 * (dropped 2026-09-15: its last 20 posts are the same automated "Encoder
 * Network Weekly Activity Report", so the row would flip between three
 * identical titles and none of them is something being built); hive-engine
 * (owner, 2026-09-15: "Hive engine is a fake account. Get rid of it" — its
 * posts are auto-published contract sources, not a person or team writing);
 * dalz (owner, 2026-09-15: "remove dalz, hes not a builder" — data reports
 * about Hive, not building on it).
 */
/** Who curates the roster (the footer used to link here; the request now goes to Discord). */
export const BUILDERS_CURATOR = 'lordbutterfly';

/** Where a builder who is not listed asks to be (owner, 2026-09-15: "add the Magi discord invite link... just a button"). The same invite `flagged-account-notice.tsx` points appeals at. */
export const MAGI_DISCORD_INVITE = 'https://discord.gg/NAdHac8m77';

export const BUILDERS: readonly Builder[] = [
  // ── people ──────────────────────────────────────────────────────────────
  // The owner. Lumen tags every post published through it `lumen` ("Testing."
  // and a Seedance ads post carry it), so tags say nothing; the Meritum and
  // Lumen posts say so in the title. Owner: "if lumen in title or meritum or
  // algo", then "add hive watch as well" (the watch posts are titled with it).
  { account: 'lordbutterfly', mode: 'own', titles: ['lumen', 'meritum', 'algo', 'hive watch', 'hivewatch'] },
  // Every post is category `core` with tags `core,dev` — the 84 core dev
  // meetings, the Gopherd posts, AND "I'm bored and sad about my profession".
  // The meetings and the proposal say "Core dev"/"Core development" in the
  // title; the Gopherd project and the multi-client post carry `gopherd`.
  { account: 'howo', mode: 'own', titles: ['core dev'], tags: ['gopherd'] },
  // Two daily series: "HiveSuite Development Update: …" / "HiveSuite Dev
  // Update: …" (the building) and "HiveSuite Daily Rewards for …" (curation
  // payouts). Same tags on both (`hivesuite`, `hivedev`), so the title decides.
  { account: 'sagarkothari88', mode: 'own', titles: ['development update', 'dev update'] },
  // Owner: "add when he adds a holozing tag or the scrobble tag". He uses
  // BOTH: `scrobble` on the Scrobble.life posts (features, delegations, "Moar
  // Gems"), `holozing` on the Holozing MMO updates. Everything else — WoW
  // levelling, AI essays, drama — carries neither.
  { account: 'acidyo', mode: 'own', tags: ['scrobble', 'holozing'] },
  // hivescan.io and Hive Wrapped in HiveDevs; the half-marathons, travel and
  // the Crownrend contest are not. `python` catches the automation posts.
  { account: 'emrebeyler', mode: 'dev', tags: ['hivescan', 'lighthive', 'beem', 'python'] },
  // Owner: "gtg often as well". The peer-loss witness update, the HF28 kit and
  // "Brace yourself" carry `dev`/`witness-update`; the anniversary post
  // ("Thank you for passing by") and the HiveFest posts carry neither.
  { account: 'gtg', mode: 'dev' },
  // hiveprojects.io updates, Ledger authority guides, witness updates — all
  // tagged `hiveprojects`/`hivedev`/`witness-update`. Nothing else in 20.
  { account: 'engrave', mode: 'dev' },
  // `v4vapp` goes on his Bitcoin opinion pieces too (the Coldcard post);
  // `developers` goes only on the V4V.app engineering posts (cutover, fees,
  // Magi integration, TailJLogs, v2 backend). Politics posts carry neither.
  { account: 'brianoflondon', mode: 'own', tags: ['developers', 'podping'] },
  // One post this year (FreeBeings DAO, HiveDevs); the HAF reports are 2022.
  { account: 'imwatsi', mode: 'dev', tags: ['freebeings-dao', 'freebeings'] },
  // Hive Bridge, hive-tx, HafSQL proposals in HiveDevs. "Witness update -
  // 4/22" (public seed/API/HafSQL nodes all healthy) is ops, so the title
  // counts; "Rant 1.0" and Dark Souls do not.
  { account: 'mahdiyari', mode: 'dev', titles: ['witness update'] },
  // Owner: "every post of his is about development". Twenty of twenty are
  // HAF/API-stack release notes.
  { account: 'blocktrades', mode: 'all' },
  // Owner's addition. The "#Learn #Python #Together" tutorial series, every
  // one titled with Python; the AI opinion pieces and the Pune meetups are not.
  { account: 'techcoderlabz', mode: 'own', titles: ['python'] },
  // ── products (every post is the product shipping) ───────────────────────
  { account: 'snapie', mode: 'all' }, // devlogs and releases, 2026-08-31
  // Clive, Wax, Denser, Healthchecker — all in HiveDevs or tagged `dev`. Not
  // `all`: the newest post is a conference invitation (EBC 2026).
  { account: 'thebeedevs', mode: 'dev' },
  { account: 'keychain', mode: 'all' }, // multichain betas, EVM, proposals, 2026-08-26
  { account: 'actifit', mode: 'all' }, // web/android/iOS releases, 2026-08-21
  { account: 'terracore', mode: 'all' }, // devlogs, 2026-08-08
  { account: 'liketu', mode: 'all' }, // feature launches, 2026-07-12
  { account: 'holozing', mode: 'all' }, // marketplace, Wilds alpha, creature releases, 2026-08-14
  // Owner's addition ("@magi.network goes up there as well"). Every post carries
  // the same tags (hive,magi,crosschain,maginetwork), so the title decides: the
  // releases ("The Magi Market is live!", "FEATURE RELEASE", "Just Shipped a
  // Token Factory", "Liquidity Pools Have Launched", "x DASH Integration",
  // "SDK", "Introducing Magi Tokens", the "Development Update"s and the
  // security report) are in; the writing-contest posts, the Hive Engine breach
  // statement, the DHF proposal and the strategy essays are not.
  { account: 'magi.network', mode: 'own', titles: ['update', 'release', 'is live', 'shipped', 'launched', 'integration', 'sdk', 'introducing', 'report'] },
  // "MOON Dev Log — May 2026" is the building; the Season 1 payout and winner
  // posts carry `moon` too and are not.
  { account: 'hive.pizza', mode: 'own', titles: ['dev log', 'devlog'], tags: ['gamedev'] }
];
