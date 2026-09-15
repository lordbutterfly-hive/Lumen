/**
 * UNIT TESTS for the pure half of the builders board: which posts count as
 * development (`lib/builders-board-shape.ts`) and the roster's rules
 * (`lib/builders-roster.ts`) replayed against the REAL posts they were
 * written from (pulled 2026-09-15).
 *
 * Run by `pnpm --filter @hive/blog test:unit` under ts-node; own harness.
 * ★ Imports the PURE modules only — `../builders-board` imports the chain
 * client, which ts-node cannot resolve, and one such import aborts the whole
 * runner at this file.
 */
import type { Entry } from '@hive/common-hiveio-packages/wax';
import { shapeBuilderRow, isDevelopmentPost, isCrossPost, tagsOf, postAgeMs, interleaveByRound, buildSlotQueues, POSTS_PER_BUILDER, MAX_POST_AGE_MS, DEV_TAGS, BOARD_SLOTS } from '../builders-board-shape';
import type { Builder, BuilderRow } from '../builders-board-shape';
import { BUILDERS, BUILDERS_CURATOR } from '../builders-roster';

let checks = 0;
let failures = 0;
function ok(label: string, pass: boolean, detail = '') {
  checks++;
  if (pass) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A root post as the Bridge returns it. Tags may arrive as an object or a JSON string. */
const post = (
  author: string,
  permlink: string,
  opts: { title?: string; category?: string; tags?: string[]; created?: string; metaAsString?: boolean } = {}
): Entry => {
  const meta = { tags: opts.tags ?? [] };
  return {
    author,
    permlink,
    title: opts.title ?? 'A title',
    category: opts.category ?? 'hive',
    created: opts.created ?? '2026-09-14T10:00:00',
    json_metadata: opts.metaAsString ? JSON.stringify(meta) : meta
  } as unknown as Entry;
};

const rule = (account: string): Builder => {
  const found = BUILDERS.find((b) => b.account === account);
  if (!found) throw new Error(`${account} is not on the roster`);
  return found;
};

console.log('\ntagsOf');
ok('object metadata', tagsOf(post('a', 'p', { tags: ['Lumen', 'hive'] })).join() === 'lumen,hive');
ok('string metadata', tagsOf(post('a', 'p', { tags: ['devlog'], metaAsString: true })).join() === 'devlog');
ok('corrupt string metadata -> no tags, no throw', tagsOf({ json_metadata: '{nope' } as unknown as Entry).length === 0);

// ★ Every fixture below is a REAL post: author, category, tags and title as
// measured on mainnet, 2026-09-15. Change a rule, replay it here.
console.log('\nthe owner: the rule lives in the TITLE, because Lumen tags every post it publishes `lumen`');
const OWNER = rule('lordbutterfly');
ok('mode is own, with no tags at all', OWNER.mode === 'own' && !OWNER.tags);
ok('"What Are Meritum Tokens?" -> development', isDevelopmentPost(OWNER, post('lordbutterfly', 'p', { title: 'What Are Meritum Tokens?', category: 'lumen', tags: ['lumen', 'hive', 'magi'] })));
ok('"Lumen: Bringing Meritum Tokens and a New Creator Economy to Hive" -> development', isDevelopmentPost(OWNER, post('lordbutterfly', 'p', { title: 'Lumen: Bringing Meritum Tokens and a New Creator Economy to Hive', category: 'lumen', tags: ['lumen', 'launch', 'hive'] })));
ok('"Testing." tagged lumen (published through Lumen) -> NOT', !isDevelopmentPost(OWNER, post('lordbutterfly', 'p', { title: 'Testing.', category: 'lumen', tags: ['lumen'] })));
ok('"From Prototype to Proof // Building the Hive Watch" -> development (owner: "add hive watch as well")', isDevelopmentPost(OWNER, post('lordbutterfly', 'p', { title: 'From Prototype to Proof // Building the Hive Watch', category: 'hive', tags: ['hive', 'hivewatch'] })));
ok('"Seedance 2.5 // Hive Watch ads //" -> development, by the same rule', isDevelopmentPost(OWNER, post('lordbutterfly', 'p', { title: 'Seedance 2.5 // Hive Watch ads // ', category: 'hive', tags: ['hive', 'lumen', 'frontend', 'do', 'it'] })));
ok('"FREECHAIN update." -> NOT (not in the owner\'s list)', !isDevelopmentPost(OWNER, post('lordbutterfly', 'p', { title: 'FREECHAIN update.', category: 'hive', tags: ['hive', 'news', 'freechain'] })));
ok('"Product photography attempt NO.1" -> NOT', !isDevelopmentPost(OWNER, post('lordbutterfly', 'p', { title: 'Product photography attempt NO.1', category: 'photography', tags: ['photography', 'images', 'diy'] })));
ok('"Killing Hive\'s Social Potential -> POB Based Content Discovery" -> NOT', !isDevelopmentPost(OWNER, post('lordbutterfly', 'p', { title: 'Killing Hive’s Social Potential -> POB Based Content Discovery ', category: 'hive', tags: ['hive', 'rant', 'frontend'] })));
ok('a future "How the Lumen algorithm ranks posts" -> development (algo)', isDevelopmentPost(OWNER, post('lordbutterfly', 'p', { title: 'How the Lumen algorithm ranks posts', category: 'hive', tags: ['hive'] })));
ok('the title match is case-insensitive', isDevelopmentPost(OWNER, post('lordbutterfly', 'p', { title: 'MERITUM week one', category: 'hive', tags: [] })));

console.log('\n@howo: no category match; the meetings say "Core dev" in the title, the project is tagged gopherd');
const HOWO = rule('howo');
ok('`core` is no longer in the shared vocabulary', !DEV_TAGS.has('core'));
ok('"Core dev meeting #84" -> development', isDevelopmentPost(HOWO, post('howo', 'p', { title: 'Core dev meeting #84', category: 'core', tags: ['core', 'dev', 'meeting'] })));
ok('"Core development proposal year 7" -> development', isDevelopmentPost(HOWO, post('howo', 'p', { title: 'Core development proposal year 7', category: 'core', tags: ['core', 'dev', 'proposal'] })));
ok('"Hive is now a multi client network, the forking incident I caused…" tagged gopherd -> development', isDevelopmentPost(HOWO, post('howo', 'p', { title: 'Hive is now a multi client network, the forking incident I caused, and reducing my proposal to 150 HBD a day', category: 'core', tags: ['core', 'dev', 'gopherd', 'proposal'] })));
ok('"I\'m bored and sad about my profession" (category core, tags core,dev) -> NOT', !isDevelopmentPost(HOWO, post('howo', 'p', { title: "I'm bored and sad about my profession", category: 'core', tags: ['core', 'dev'] })));
ok('"What changes would you like to see in communities ?" -> NOT', !isDevelopmentPost(HOWO, post('howo', 'p', { title: 'What changes would you like to see in communities ? ', category: 'hive', tags: ['hive', 'communities'] })));

console.log('\n@acidyo: the scrobble tag AND the holozing tag, both in use');
const ACIDYO = rule('acidyo');
ok('"Scrobble.life Updates" (category scrobble) -> development', isDevelopmentPost(ACIDYO, post('acidyo', 'p', { title: 'Scrobble.life Updates', category: 'scrobble', tags: ['scrobble', 'life', 'updates'] })));
ok('"Moar Gems" in the Scrobble community, tagged scrobble -> development', isDevelopmentPost(ACIDYO, post('acidyo', 'p', { title: 'Moar Gems', category: 'hive-110713', tags: ['scrobble', 'games', 'more', 'kinds', 'fun'] })));
ok('"A new little update on Holozing MMO" tagged holozing -> development', isDevelopmentPost(ACIDYO, post('acidyo', 'p', { title: 'A new little update on Holozing MMO', category: 'hive-131131', tags: ['holozing', 'mmo', 'update'] })));
ok('"Scrobble Delegation Rewards" tagged everyday,im,scrobbling (no scrobble tag) -> NOT', !isDevelopmentPost(ACIDYO, post('acidyo', 'p', { title: 'Scrobble Delegation Rewards', category: 'hive-110713', tags: ['everyday', 'im', 'scrobbling'] })));
ok('"WoW TBC lvl 10-X" -> NOT', !isDevelopmentPost(ACIDYO, post('acidyo', 'p', { title: 'WoW TBC lvl 10-X', category: 'hive-140217', tags: ['wow', 'tbc', 'hc'] })));
ok('"Is Hive oversold?" -> NOT', !isDevelopmentPost(ACIDYO, post('acidyo', 'p', { title: 'Is Hive oversold?', category: 'thoughts', tags: ['thoughts'] })));
ok('"Ai Subs" tagged ai,subs,proposal,dhf -> NOT (own mode ignores the shared vocabulary)', !isDevelopmentPost(ACIDYO, post('acidyo', 'p', { title: 'Ai Subs', category: 'ai', tags: ['ai', 'subs', 'proposal', 'dhf'] })));

console.log('\n@sagarkothari88: "Development Update" yes, "Daily Rewards" no, same tags on both');
const SAGAR = rule('sagarkothari88');
const sagarTags = ['hive-139531', 'dapps', 'india', 'daily', 'threespeak', 'hivedev', 'updates', 'ocd', 'neoxion', 'hivesuite'];
ok('"HiveSuite Development Update: Chat Experience, Drive & Editor" -> development', isDevelopmentPost(SAGAR, post('sagarkothari88', 'p', { title: 'HiveSuite Development Update: Chat Experience, Drive & Editor ', category: 'hive-139531', tags: sagarTags })));
ok('"HiveSuite & HiveReactKit Dev Update - Smarter Snaps Notifications" -> development', isDevelopmentPost(SAGAR, post('sagarkothari88', 'p', { title: 'HiveSuite & HiveReactKit Dev Update - Smarter Snaps Notifications', category: 'hive-139531', tags: sagarTags })));
ok('"🎉 HiveSuite Daily Rewards for 6-Sep-2026" -> NOT', !isDevelopmentPost(SAGAR, post('sagarkothari88', 'p', { title: '🎉 HiveSuite Daily Rewards for 6-Sep-2026', category: 'hive-185924', tags: ['hive-185924', 'hive', 'rewards', 'india', 'community', 'daily', 'bee', 'neoxian', 'waiv', 'hivesuite'] })));

console.log('\n@brianoflondon: `developers` marks the engineering posts, `v4vapp` alone does not');
const BRIAN = rule('brianoflondon');
ok('"Anatomy of a failed Lightning Payment" tagged v4vapp,vsc,developers -> development', isDevelopmentPost(BRIAN, post('brianoflondon', 'p', { title: 'Anatomy of a failed Lightning Payment', category: 'hive-110369', tags: ['v4vapp', 'vsc', 'developers', 'leofinance', 'proofofbrain', 'lightning', 'failure', 'btc'] })));
ok('"Coinkite Coldcard just proved the real Bitcoin risk…" tagged v4vapp,lightning,btc,btcmaxis -> NOT', !isDevelopmentPost(BRIAN, post('brianoflondon', 'p', { title: 'Coinkite Coldcard just proved the real Bitcoin risk: bad devices, not “not your keys”', category: 'v4vapp', tags: ['v4vapp', 'lightning', 'btc', 'btcmaxis', 'hardware', 'leofinance', 'hive', 'voltage'] })));
ok('"The Blogs: Arafat polonium — junk science" tagged archivedcontenthaf -> NOT (haf is not a substring match)', !isDevelopmentPost(BRIAN, post('brianoflondon', 'p', { title: 'The Blogs: Arafat polonium — junk science', category: 'archivedcontenthaf', tags: ['archivedcontenthaf', 'archiveother', 'archivelong'] })));
ok('a politics post -> NOT', !isDevelopmentPost(BRIAN, post('brianoflondon', 'p', { title: 'How do you search for ships at sea?', category: 'hive-181335', tags: ['israel', 'hormuz', 'usnavy'] })));

console.log('\n@gtg and @mahdiyari: the shared vocabulary, verified on their feeds');
const GTG = rule('gtg');
ok('"How to lose all your peers in one block (a witness update)" -> development', isDevelopmentPost(GTG, post('gtg', 'p', { title: 'How to lose all your peers in one block (a witness update)', category: 'hive-160391', tags: ['witness-category', 'witness-update', 'hive', 'dev', 'p2p'] })));
ok('"Hive HardFork 28 Jump Starter Kit" -> development', isDevelopmentPost(GTG, post('gtg', 'p', { title: 'Hive HardFork 28 Jump Starter Kit', category: 'hive-160391', tags: ['hivepressure', 'dev', 'witness-category', 'hive', 'doc', 'faq'] })));
ok('"Thank you for passing by" (anniversary) -> NOT', !isDevelopmentPost(GTG, post('gtg', 'p', { title: 'Thank you for passing by', category: 'hive-160391', tags: ['hive', 'witness-category', 'community', 'anniversary'] })));
ok('"HiveFest: say Hi(ve) in person" -> NOT', !isDevelopmentPost(GTG, post('gtg', 'p', { title: 'HiveFest: say Hi(ve) in person', category: 'hive-160391', tags: ['hive', 'hivefest', 'roadtohivefest'] })));
const MAHDI = rule('mahdiyari');
ok('"Witness update - 4/22" (nodes healthy; tags witness-category,witness only) -> development by title', isDevelopmentPost(MAHDI, post('mahdiyari', 'p', { title: 'Witness update - 4/22', category: 'hive-111111', tags: ['witness-category', 'witness'] })));
ok('"Rant 1.0" tagged hive,dhf,rant,random -> NOT', !isDevelopmentPost(MAHDI, post('mahdiyari', 'p', { title: 'Rant 1.0', category: 'hive', tags: ['hive', 'dhf', 'rant', 'random'] })));
ok('"Dark Souls 3" -> NOT', !isDevelopmentPost(MAHDI, post('mahdiyari', 'p', { title: 'Dark Souls 3', category: 'hive-140217', tags: ['game', 'dark', 'souls'] })));

console.log('\n@dalz and @techcoderlabz (owner\'s additions)');
const DALZ = rule('dalz');
ok('"Hive Witness Report | Ranking, Voting, Missed Blocks…" tagged witness,hive,report -> development', isDevelopmentPost(DALZ, post('dalz', 'p', { title: 'Hive Witness Report | Ranking, Voting, Missed Blocks, HBD Interest Changes and More | August 2026 ', category: 'witness', tags: ['witness', 'hive', 'report', 'aug26', 'data', 'ranking', 'moves'] })));
ok('"Ecency! | Data On Posts, Comments, Users" in Hive Statistics (no hive tag) -> development by community', isDevelopmentPost(DALZ, post('dalz', 'p', { title: 'Ecency! | Data On Posts, Comments, Users | Aug 2026', category: 'hive-133987', tags: ['ecency', 'data', 'activity', 'users', 'maus', 'stats'] })));
ok('"A Look at the Lido Protocol…" -> NOT', !isDevelopmentPost(DALZ, post('dalz', 'p', { title: 'A Look at the Lido Protocol | A Leading Protocol for Staking Ethereum | September 2026', category: 'lido', tags: ['lido', 'data', 'staked', 'eth', 'steth', 'defi'] })));
ok('"Robinhood Chain Is Growing Fast!" -> NOT', !isDevelopmentPost(DALZ, post('dalz', 'p', { title: 'Robinhood Chain Is Growing Fast! | Data on TVL, Stablecoins, Active Addresses, Transactions', category: 'robinhood', tags: ['robinhood', 'hood', 'chain', 'crypto', 'defi', 'activity', 'stats'] })));
const TECH = rule('techcoderlabz');
ok('"#Learn #Python #Together | 🔥 Day 11 | #basics" -> development', isDevelopmentPost(TECH, post('techcoderlabz', 'p', { title: '#Learn #Python #Together | 🔥 Day 11 | #basics | #python ', category: 'python', tags: ['python', 'learn', 'basics', 'pip'] })));
ok('"Learn Python Basics Together - Day 4 | Python Dictionaries…" (tags: hivesuite only) -> development', isDevelopmentPost(TECH, post('techcoderlabz', 'p', { title: 'Learn Python Basics Together - Day 4 | Python Dictionaries Explained for Beginners', category: 'hivesuite', tags: ['hivesuite'] })));
ok('"😱 AI Is Taking Programming Jobs? Here\'s the Truth" tagged programming,coding,developers -> NOT (own mode)', !isDevelopmentPost(TECH, post('techcoderlabz', 'p', { title: "😱 AI Is Taking Programming Jobs? Here's the Truth Every Dev Should Know", category: 'programming', tags: ['programming', 'ai', 'softwareengineer', 'coding', 'developers'] })));
ok('"Pune Hive Meetup Recap" -> NOT', !isDevelopmentPost(TECH, post('techcoderlabz', 'p', { title: ' Pune Hive Meetup Recap: Small Turnout, One Strong Onboarding 🐝', category: 'hive-127555', tags: ['hive', 'web3', 'meetup', 'pune'] })));

console.log('\n@magi.network: releases and development updates by title, contests and statements out');
const MAGI = rule('magi.network');
const magiTags = ['hive', 'magi', 'crosschain', 'maginetwork', 'news'];
for (const title of ['The Magi Market is live!', '⚖️ FEATURE RELEASE: The Incentive Pendulum is live on Magi mainnet ', 'Magi Just Shipped a Token Factory!  👷', 'Magi Progress Update 29.4.//  EVM integration, ZK Proofs, Incentive Pendulum', 'Magi SDK Embeddable Cross-chain Swap widget for HIVE, HBD, and BTC', ' 🎉Native Bitcoin Liquidity Pools Have Launched on Magi Network', 'Magi x DASH Integration', 'Introducing Magi Tokens & NFTs: Launching Our Full Token Ecosystem ✅', 'Magi Technical Development Update // 4.2.2026', 'Magi Security and Bug Hunt Report //  February - May']) {
  ok(`"${title.trim().slice(0, 60)}" -> development`, isDevelopmentPost(MAGI, post('magi.network', 'p', { title, category: 'hive', tags: magiTags })));
}
for (const title of ['Magi Writing Contest // Winners', 'Magi Writing Contest! $500 USD in BTC and 90k HP in delegations up for grabs!', 'On the Hive Engine Breach - A Statement from Magi', 'HBD = Hive\'s Secret Weapon for Global Cross-Chain DeFi ', 'Magi Network DHF Proposal 2026', 'Magi Protocol: The Unified Financial Network', 'On Repeated Development Work, Misaligned Incentives, and the Need for Strategic Coordination on Hive']) {
  ok(`"${title.trim().slice(0, 60)}" -> NOT`, !isDevelopmentPost(MAGI, post('magi.network', 'p', { title, category: 'hive', tags: magiTags })));
}

console.log('\nproducts');
ok('@blocktrades: any post counts', rule('blocktrades').mode === 'all' && isDevelopmentPost(rule('blocktrades'), post('blocktrades', 'p', { title: 'Release of new HAF API stack 1.28.6 next week', category: 'hive-139531', tags: ['hive', 'blockchain', 'software'] })));
ok('@snapie: any post counts, whatever the tags', isDevelopmentPost(rule('snapie'), post('snapie', 'p', { category: 'hive-178315', tags: ['pob'] })));
ok('@thebeedevs: "Meet us at European Blockchain Convention 2026" -> NOT', !isDevelopmentPost(rule('thebeedevs'), post('thebeedevs', 'p', { title: 'Meet us at European Blockchain Convention 2026', category: 'hive-106258', tags: ['hivefest', 'hive', 'conference', 'barcelona', 'ebc2026', 'thebeedevs'] })));
ok('@thebeedevs: "Clive — A Modern Replacement for CLI Wallet" -> development', isDevelopmentPost(rule('thebeedevs'), post('thebeedevs', 'p', { title: 'Clive — A Modern Replacement for CLI Wallet', category: 'hive-139531', tags: ['hive', 'dev', 'clive', 'wallet', 'cli'] })));
ok('@hive.pizza: "MOON Dev Log — May 2026" -> development', isDevelopmentPost(rule('hive.pizza'), post('hive.pizza', 'p', { title: 'MOON Dev Log — May 2026: Mobile, PWA, and Attack Alerts', category: 'hive-140217', tags: ['moon', 'gaming', 'gamedev', 'archon'] })));
ok('@hive.pizza: "MOON Season 1 Rewards Payout" -> NOT', !isDevelopmentPost(rule('hive.pizza'), post('hive.pizza', 'p', { title: 'MOON Season 1 Rewards Payout', category: 'hive-185582', tags: ['moon', 'gaming', 'oneup', 'archon', 'tribes', 'pizza'] })));
ok('threespeak is off the roster (an automated weekly report is not building)', !BUILDERS.some((b) => b.account === 'threespeak'));
ok('hive-engine is off the roster (owner: a fake account)', !BUILDERS.some((b) => b.account === 'hive-engine'));
ok('asgarth, good-karma, ecency, peakd are not on the roster', !BUILDERS.some((b) => ['asgarth', 'good-karma', 'ecency', 'peakd'].includes(b.account)));
ok('every own-mode builder has at least one tag or title (otherwise its row can never exist)', BUILDERS.every((b) => b.mode !== 'own' || (b.tags?.length ?? 0) + (b.titles?.length ?? 0) > 0));
ok('no account appears twice', new Set(BUILDERS.map((b) => b.account)).size === BUILDERS.length);

console.log('\nthe loose matches the first draft got wrong stay gone');
const TRIBE: Builder = { account: 'neoxian', mode: 'dev' };
ok('"witness" alone (an earnings report) -> NOT', !isDevelopmentPost(TRIBE, post('neoxian', 'p', { tags: ['witness', 'report'] })));
ok('"update" alone -> NOT', !isDevelopmentPost(TRIBE, post('neoxian', 'p', { tags: ['update', 'news'] })));
ok('the account\'s own name as a tag -> NOT', !isDevelopmentPost(TRIBE, post('neoxian', 'p', { tags: ['neoxian', 'pob'] })));
ok('an own-mode builder with nothing declared matches nothing', !isDevelopmentPost({ account: 'x', mode: 'own' }, post('x', 'p', { title: 'dev', category: 'hive-139531', tags: ['dev'] })));
ok('an empty title keyword never matches', !isDevelopmentPost({ account: 'x', mode: 'own', titles: [''] }, post('x', 'p', { title: 'anything' })));

console.log('\ncross-posts');
ok('a post tagged exactly cross-post is a cross-post', isCrossPost(post('liketu', 'p', { tags: ['cross-post'] })));
ok('a normal post is not', !isCrossPost(post('liketu', 'p', { tags: ['liketu', 'feature'] })));

console.log('\nshapeBuilderRow: refuses to invent a row');
ok('null page -> no row', shapeBuilderRow(OWNER, null) === null);
ok('empty page -> no row', shapeBuilderRow(OWNER, []) === null);
ok('a page of only reblogs -> no row', shapeBuilderRow(rule('snapie'), [post('someone-else', 'x'), post('another', 'y')]) === null);
ok('a person whose last 20 are all photography -> no row', shapeBuilderRow(OWNER, [post('lordbutterfly', 'a', { title: 'Product photography attempt NO.1', category: 'photography', tags: ['photography'] })]) === null);

console.log('\nshapeBuilderRow: the owner\'s real page, newest first, nothing else');
const ownerPage = [
  post('lordbutterfly', 'meritum', { title: 'What Are Meritum Tokens?', category: 'lumen', tags: ['lumen', 'hive', 'magi'], created: '2026-09-11T00:00:00' }),
  post('lordbutterfly', 'launch', { title: 'Lumen: Bringing Meritum Tokens and a New Creator Economy to Hive', category: 'lumen', tags: ['lumen', 'launch', 'hive'], created: '2026-09-09T00:00:00' }),
  post('lordbutterfly', 'photo', { title: 'Product photography attempt NO.1', category: 'photography', tags: ['photography'], created: '2026-08-25T00:00:00' }),
  post('reblogged-author', 'their-post', { title: 'Lumen is great', tags: ['lumen'] }),
  post('LORDBUTTERFLY', 'seedance', { title: 'Seedance 2.5 // Hive Watch ads // ', category: 'hive', tags: ['hive', 'lumen', 'frontend'], created: '2026-08-25T00:00:00' }),
  post('lordbutterfly', 'testing', { title: 'Testing.', category: 'lumen', tags: ['lumen'], created: '2026-08-08T00:00:00' }),
  post('lordbutterfly', 'rant', { title: 'Killing Hive’s Social Potential -> POB Based Content Discovery ', category: 'hive', tags: ['hive', 'rant', 'frontend'], created: '2026-07-08T00:00:00' }),
  post('lordbutterfly', 'algo', { title: 'The Lumen algo, explained', category: 'lumen', tags: ['lumen'], created: '2026-06-01T00:00:00' }),
  post('lordbutterfly', 'old-algo', { title: 'Algo notes', category: 'lumen', tags: ['lumen'], created: '2026-05-01T00:00:00' }),
  post('lordbutterfly', 'untitled', { title: '   ', category: 'lumen', tags: ['lumen'] })
];
const NOW = Date.parse('2026-09-15T12:00:00Z');
const row = shapeBuilderRow(OWNER, ownerPage, NOW);
ok('a row is produced', row !== null);
ok(`exactly ${POSTS_PER_BUILDER} posts`, row?.posts.length === POSTS_PER_BUILDER);
ok('Meritum, Lumen launch, then the Hive Watch ads post; Testing. and the rant are skipped', row?.posts.map((p) => p.permlink).join() === 'meritum,launch,seedance');
ok('the reblog is dropped even though its title says Lumen', !row?.posts.some((p) => p.permlink === 'their-post'));
ok('created passes through untouched', row?.posts[0]?.created === '2026-09-11T00:00:00');

console.log('\nshapeBuilderRow: a cross-post stub does not take a slot (the @liketu page)');
const liketuPage = [
  post('liketu', 'front', { title: 'front — one link that\'s actually yours', category: 'hive-147010', tags: ['liketu', 'hive', 'front', 'feature'], created: '2026-07-12T00:00:00' }),
  post('liketu', 'network-value', { title: 'Network value: the number that knows who grows liketu', category: 'hive-147010', tags: ['liketu', 'centrality'], created: '2026-07-07T00:00:00' }),
  post('liketu', 'wild-xpost', { title: 'Introducing liketu Wild', category: 'hive-147010', tags: ['cross-post'], created: '2026-06-13T10:00:00' }),
  post('liketu', 'wild', { title: 'Introducing liketu Wild', category: 'liketu', tags: ['liketu', 'feature', 'wild'], created: '2026-06-13T09:00:00' })
];
const liketuRow = shapeBuilderRow(rule('liketu'), liketuPage, NOW);
ok('the original takes the third slot, not the stub', liketuRow?.posts.map((p) => p.permlink).join() === 'front,network-value,wild');

console.log('\nshapeBuilderRow: nothing older than a year (the @imwatsi replay)');
const IMWATSI = rule('imwatsi');
const replay = [
  post('imwatsi', 'dao-live', { title: 'Back on Hive — and FreeBeings DAO is live', category: 'hive-139531', tags: ['freebeings-dao'], created: '2026-06-30T00:00:00' }),
  post('imwatsi', 'proposal-2023', { title: 'Proposal: FreeBeings.io LLC - HAF Development', category: 'hive-139531', tags: ['development'], created: '2023-04-15T00:00:00' }),
  post('imwatsi', 'report-2022', { title: '3rd HAF Projects Development Report for 2022', category: 'hive-139531', tags: ['haf'], created: '2022-07-21T00:00:00' })
];
const aged = shapeBuilderRow(IMWATSI, replay, NOW);
ok('the 2026 post is kept', aged?.posts.some((p) => p.permlink === 'dao-live') === true);
ok('the 2023 and 2022 posts are dropped', aged?.posts.length === 1);
ok('a row with one post is still a row (it just never flips)', aged !== null);
ok('a builder whose only development posts are older than a year -> no row', shapeBuilderRow(IMWATSI, replay.slice(1), NOW) === null);
ok('exactly a year old is kept, a day past it is not',
  postAgeMs('2025-09-15T12:00:00', NOW) <= MAX_POST_AGE_MS && postAgeMs('2025-09-14T11:59:59', NOW) > MAX_POST_AGE_MS);
ok('an unparseable created is treated as infinitely old', postAgeMs('not a date', NOW) === Number.POSITIVE_INFINITY);

console.log('\nslots: the board flips writers as well as posts');
const rowOf = (account: string, n: number): BuilderRow => ({
  account,
  posts: Array.from({ length: n }, (_, i) => ({ permlink: `${account}-${i + 1}`, category: 'hive', title: `${account} post ${i + 1}`, created: `2026-09-${String(14 - i).padStart(2, '0')}T00:00:00` }))
});
const board = [rowOf('a', 3), rowOf('b', 3), rowOf('c', 1), rowOf('d', 2), rowOf('e', 3), rowOf('f', 3), rowOf('g', 3), rowOf('h', 3), rowOf('i', 3), rowOf('j', 2)];
const dealt = interleaveByRound(board);
ok('every post of every builder is dealt exactly once', dealt.length === board.reduce((n, r) => n + r.posts.length, 0));
ok('round one is every builder\'s newest post, in board order', dealt.slice(0, 10).map((e) => `${e.account}${e.post.permlink.slice(-1)}`).join() === 'a1,b1,c1,d1,e1,f1,g1,h1,i1,j1');
ok('round two skips the builder with one post', dealt.slice(10, 19).map((e) => e.account).join('') === 'abdefghij');
ok('round three skips the builders with two', dealt.slice(19).map((e) => e.account).join('') === 'abefghi');
const queues = buildSlotQueues(board);
ok(`${BOARD_SLOTS} slots for a full board`, queues.length === BOARD_SLOTS);
ok('no queue is empty', queues.every((q) => q.length > 0));
ok('the opening screen shows eight DIFFERENT builders', new Set(queues.map((q) => q[0].account)).size === BOARD_SLOTS);
ok('and so does every later step', [1, 2].every((step) => new Set(queues.map((q) => q[step % q.length]?.account)).size === BOARD_SLOTS));
ok('a slot\'s first flip brings a different writer, not the same writer\'s next post', queues.every((q) => q.length < 2 || q[0].account !== q[1].account));
ok('slot one is dealt a1, i1, h2, h3 (round-robin over the rounds)', queues[0].map((e) => e.post.permlink).join() === 'a-1,i-1,h-2,h-3');
ok('fewer entries than slots -> fewer slots, never an empty one', buildSlotQueues([rowOf('a', 2), rowOf('b', 1)]).length === 3);
ok('no rows -> no slots', buildSlotQueues([]).length === 0);
ok('the request line has a curator on the roster to point at', BUILDERS.some((b) => b.account === BUILDERS_CURATOR));

if (failures === 0) {
  console.log(`\nbuilders-board: ALL ${checks} CHECKS PASSED`);
  process.exit(0);
} else {
  console.error(`\nbuilders-board: ${failures}/${checks} CHECK(S) FAILED`);
  process.exit(1);
}
