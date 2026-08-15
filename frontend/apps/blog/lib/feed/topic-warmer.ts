import 'server-only';
import { getLogger } from '@ui/lib/logging';
import { getTrendingTags } from '@transaction/lib/hive';
import { acquireHiveWarm, hiveWarmHolder, releaseHiveWarm } from './hive-warm-gate';

const logger = getLogger('app');

/**
 * ★★★ WARM THE TAGS A READER CAN ACTUALLY CLICK, BEFORE THEY CLICK ONE
 * (2026-08-14).
 *
 * Opening a tag nobody had opened before cost 2,290-3,285ms signed in, and
 * revisiting it cost 15ms. The cache was never the problem — the problem was
 * that a HUMAN was always the one who paid to fill it. Traced per stage through
 * `/api/feed/for-you` (see `RECSYS_FAST_FAIL_MS` in that route for the table),
 * the part of that cost this module removes is `fb_upstream`: 770-1,594ms of
 * `bridge.get_ranked_posts` against a public Hive node, three sequential round
 * trips because Hive caps a page at 20 and the fallback fetches `MAX_LIMIT`.
 *
 * That work is completely reader-independent — one tag, one chronological list,
 * the same bytes for everybody (proven: the same query run with and without an
 * `observer` returns byte-identical results, see the shared-copy note in the
 * route). There is no reason for it to happen on a request at all.
 *
 * ★ WHY NOT PREFETCH ON HOVER, which is the obvious other answer: the fetch is
 * 2-3s and a hover is 200-800ms, so it cannot finish in time; it would fire live
 * node calls for tags nobody opens; and the fallback cache is capped at 200
 * entries, so a reader sweeping the rail with their cursor would evict the
 * entries other readers need. Ruled out by the owner on those grounds before
 * this was written, and recorded here so it is not re-proposed.
 *
 * ★ WHICH TAGS. `features/layouts/right-rail/topics.tsx` deals NINE chips out of
 * the top FORTY browsable trending tags, reshuffled once per UTC day. Warming
 * the nine would mean re-deriving its date-seeded shuffle here and being wrong
 * the moment either side changes; warming the pool of forty covers every hand it
 * can possibly deal, today and tomorrow, and forty entries sit comfortably under
 * the route's 200-entry bound.
 *
 * `isBrowsableTag` below is deliberately a COPY of that file's predicate rather
 * than an import: it lives in a `'use client'` module, and pulling a client
 * component's module graph into server startup to reuse one string test is a
 * worse trade than duplicating the test. The duplication is safe in the way that
 * matters — if the two drift, the warmer warms a tag the rail no longer shows,
 * or misses one it does. Both cost a slow first click. Neither can serve a
 * reader anything wrong.
 *
 * ★ IT MUST NOT STAMPEDE THE NODE. Tags are warmed ONE AT A TIME with a gap
 * between them, so a cycle is a slow trickle (~1 upstream call/second) rather
 * than forty simultaneous requests at boot — this app does not own the public
 * node it is asking, and a burst is how you get rate-limited into the empty
 * feeds this route's history is full of. A cycle that is still running when the
 * next one is due is left alone rather than doubled up.
 */

/** The rail's own `TOPIC_POOL` — the set it deals today's nine chips from. */
const DEFAULT_MAX_TAGS = 40;
/**
 * The owner's ruling on this exact list: "that should just rotate every 10-20
 * mins... even if it rotated once a day it would be fine" (see
 * `/api/trending-tags`, which caches it for an hour on the same reasoning). Ten
 * minutes keeps a warmed topic page no more than ten minutes behind the chain,
 * on a surface where posts arrive at a rate of minutes to hours.
 */
const DEFAULT_INTERVAL_MS = 10 * 60_000;
/** Between two tags, so a cycle trickles instead of bursting. */
const GAP_MS = 1_500;
/**
 * Before the FIRST cycle. Non-zero so warming does not race the request that
 * happened to load this module for its own upstream call; small enough that the
 * site is warm within seconds of coming up.
 */
const BOOT_DELAY_MS = 2_000;
/** How many tags to ask the chain for. Most of the head of this list is
 *  community ids and reward-tribe tags, so the browsable forty sit well down it
 *  — the same over-fetch, for the same reason, as `/api/trending-tags`. */
const TAG_FETCH_LIMIT = 120;

const EXCLUDED_TAGS = new Set(['', 'nsfw', 'test']);
const COMMUNITY_ID = /^hive-\d+$/i;
const REWARD_TRIBE_TAGS = new Set([
  'pob', 'proofofbrain', 'neoxian', 'cent', 'waivio', 'waiv', 'pimp', 'archon',
  'palnet', 'creativecoin', 'vyb', 'ctp', 'alive', 'oneup', 'lassecash', 'bbh',
  'burnpost', 'hbd', 'hive', 'ecency', 'peakd', 'listnerds', 'dbuzz',
  'posh', 'curation', 'blog'
]);

/** Mirrors `right-rail/topics.tsx`'s `isBrowsableTopic` — see the header. */
function isBrowsableTag(name: string): boolean {
  const tag = name.toLowerCase();
  return !EXCLUDED_TAGS.has(tag) && !COMMUNITY_ID.test(tag) && !REWARD_TRIBE_TAGS.has(tag);
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    // `unref` so a pending gap can never be the reason this process stays alive.
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });

/** The tags to warm, newest trending first, already filtered and capped. */
export async function topicsToWarm(max = DEFAULT_MAX_TAGS): Promise<string[]> {
  const tags = await getTrendingTags(TAG_FETCH_LIMIT);
  return (tags ?? [])
    .map((tag) => (tag?.name ?? '').toLowerCase())
    // The route only accepts `[a-z0-9-]{1,64}` as a topic; a tag it would reject
    // is a tag no warmed entry could ever be read back for.
    .filter((name) => /^[a-z0-9-]{1,64}$/.test(name) && isBrowsableTag(name))
    .slice(0, max);
}

let running = false;
let started = false;

async function runCycle(warm: (tag: string) => Promise<void>, max: number): Promise<void> {
  // A cycle still going when the next is due is LEFT ALONE. Overlapping cycles
  // would multiply the load on the public node by however far behind we are,
  // which is precisely the wrong response to the node being slow.
  if (running) {
    logger.info('topic-warmer: previous cycle still running, skipping this one');
    return;
  }
  // ★ AND SKIP IF THE OTHER WARMER HOLDS THE NODE (2026-08-15). Same rule this
  // function already applies to itself, extended to the viewer warmer that now
  // shares `api.hive.blog` with it — see `hive-warm-gate.ts` for the measured
  // failure (a viewer build failing at 17.3s while this warmer was mid-cycle).
  if (!acquireHiveWarm('topic-warmer')) {
    logger.info('topic-warmer: %s holds the outbound warm budget, skipping this cycle', hiveWarmHolder());
    return;
  }
  running = true;
  const startedAt = Date.now();
  let ok = 0;
  let failed = 0;
  try {
    const tags = await topicsToWarm(max);
    if (tags.length === 0) {
      logger.warn('topic-warmer: no browsable trending tags came back; nothing to warm');
      return;
    }
    for (const tag of tags) {
      try {
        await warm(tag);
        ok += 1;
      } catch (error) {
        // One bad tag must never end the cycle — the other thirty-nine are still
        // worth warming, and a tag that fails now is simply cold for a reader,
        // exactly as it was before this module existed.
        failed += 1;
        logger.warn('topic-warmer: could not warm #%s: %o', tag, error);
      }
      await sleep(GAP_MS);
    }
    logger.info(
      'topic-warmer: warmed %d/%d tags in %dms (%d failed)',
      ok, tags.length, Date.now() - startedAt, failed
    );
  } catch (error) {
    // Losing the tag list (a down node) is not an error worth a stack trace: the
    // next cycle asks again, and every reader still gets the pre-warmer
    // behaviour in the meantime.
    logger.warn('topic-warmer: cycle failed: %o', error);
  } finally {
    running = false;
    releaseHiveWarm('topic-warmer');
  }
}

/**
 * Start the warmer. Idempotent — a second call is ignored, so importing this
 * from more than one place cannot double the load on the node.
 *
 * ★ OPT-IN: on ONLY with `FEED_TOPIC_WARM=yes`. `FEED_TOPIC_WARM_MAX` and
 * `FEED_TOPIC_WARM_INTERVAL_MS` tune it without a deploy.
 *
 * This was `=off` to disable, i.e. ON BY DEFAULT, and it was the odd one out.
 * Every other flag in this wave is `=== 'yes'` and defaults off, and the whole
 * wave was described as shipping "behind six flags, all default off" — so
 * merging it would have started a background Hive warmer on every deployment
 * that never asked for one, firing a cycle of up to `FEED_TOPIC_WARM_MAX` calls
 * on an interval. `viewer-warmer.ts` guards exactly this cost behind
 * `FEED_WARM_ENABLED === 'yes'`, and its comment calls itself "the only piece of
 * the never-wait work that adds outbound load, to a public Hive node and to a
 * rate-limited ranker sharing one client-address budget with real readers".
 * That was not true while this sibling defaulted on. Now the two match.
 */
export function startTopicWarmer(warm: (tag: string) => Promise<void>): void {
  if (started) return;
  // Edge/browser bundles have no business running a timer loop against a Hive
  // node.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // ★ AND NEITHER DOES `next build`. Its static-generation pass EVALUATES route
  // modules — that is why the build log is full of `DYNAMIC_SERVER_USAGE` from
  // this app's own routes — in several parallel workers, each with
  // `NEXT_RUNTIME=nodejs`. Without this the build would start a warm cycle per
  // worker and fire forty Hive calls each, warming caches that are thrown away
  // when the build process exits. Checked before `started` is set so a real
  // server start is not blocked by a build having "already started" it.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if ((process.env.FEED_TOPIC_WARM || '').toLowerCase() !== 'yes') {
    logger.info('topic-warmer: disabled — set FEED_TOPIC_WARM=yes to enable');
    return;
  }
  started = true;

  const max = numberFromEnv('FEED_TOPIC_WARM_MAX', DEFAULT_MAX_TAGS);
  const interval = numberFromEnv('FEED_TOPIC_WARM_INTERVAL_MS', DEFAULT_INTERVAL_MS);
  logger.info('topic-warmer: starting — %d tags every %dms', max, interval);

  const boot = setTimeout(() => {
    void runCycle(warm, max);
    const repeat = setInterval(() => void runCycle(warm, max), interval);
    if (typeof repeat.unref === 'function') repeat.unref();
  }, BOOT_DELAY_MS);
  if (typeof boot.unref === 'function') boot.unref();
}
