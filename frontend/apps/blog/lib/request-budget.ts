/**
 * ★★★ A REQUEST BUDGET PER CLIENT, CHECKED BEFORE ANY PAGE IS RENDERED
 * (2026-09-02, snappiness phase 1). Runs in the middleware, so it must stay
 * edge-runtime safe: no Node imports, only Map, Date and headers.
 *
 * WHY THIS EXISTS, WITH THE NUMBERS THAT MADE IT NECESSARY. On 2026-09-02 the
 * production request log held 184,969 requests since midnight; 183,023 of them
 * (99%) were profile pages, and 138,901 came from one training crawler
 * (ClaudeBot, 216.73.216.0/22) walking the follower graph: 54,612
 * `/@name/followers`, 50,280 `/@name/following`, 34,565 `/@name`, across
 * 113,878 distinct accounts in one day, and 421,620 hits the day it started.
 * A profile page costs ~1,020 ms of CPU on the single Node thread (measured
 * from /proc/<pid>/stat over ten sequential requests, bot baseline subtracted),
 * so the thread ran one core flat out with nobody on the site, and every human
 * request queued behind it: `/api/health`, an 8 ms endpoint, measured p50
 * 82-107 ms, p90 0.4-1.0 s, max 2.3 s from localhost. That queue IS the "Lumen
 * is not snappy" the owner reported; the front-end waterfall is a separate
 * problem with its own fix.
 *
 * WHAT THIS IS NOT. robots.ts says "AI is welcome" (owner ruling 2026-08-28)
 * and this keeps that promise: nothing is blocked. A crawler that reads at a
 * civil pace never sees a 429. What ends is paying one CPU-second per page,
 * unbounded, to anyone who asks fast enough.
 *
 * HOW IT DECIDES. Four classes, all token buckets (burst up to the budget,
 * refill at budget-per-minute):
 *
 *   search   : Googlebot, Bingbot, Applebot, DuckDuckBot, Yandex, Baidu,
 *              OAI-SearchBot. One bucket PER IP, and nothing shared: a shared
 *              ceiling was tried and rejected in review, because a user agent
 *              is a claim, not a credential, and five addresses sending
 *              "Googlebot" could empty it and get the real Googlebot refused.
 *              Per IP, a spoofer gains nothing over the client class.
 *   unfurler : Twitterbot, Slackbot, Discordbot, facebookexternalhit,
 *              WhatsApp, Telegram, LinkedIn. Per IP. They fetch ONE page when
 *              someone shares a link, and a share card that dies whenever a
 *              training crawler is active would be a product bug.
 *   crawler  : the AI training agents by name, known crawler address ranges
 *              (Anthropic's 216.73.216.0/22, env-extendable), and anything
 *              calling itself a bot/crawler/spider. One bucket PER VENDOR
 *              (ClaudeBot, GPTBot, ...; unnamed ones per address) because a
 *              crawler is one operator behind many addresses (ClaudeBot used
 *              two for 139,456 hits today), AND a ceiling for the whole class,
 *              so ten vendors cannot add up to the load one of them caused.
 *              Defaults: 12 per minute per vendor (= the `Crawl-delay: 5`
 *              robots.txt asks for), 36 per minute for all of them together,
 *              until phase 2 makes these pages free to serve.
 *   client   : everything else: browsers, HTTP libraries and scripts, and the
 *              user-initiated assistant agents (`Claude-User`, `ChatGPT-User`:
 *              a person asked for that page, whatever range it comes from).
 *              One bucket per IP (IPv6 per /56).
 *
 * WHAT IS BUDGETED. Page renders, and `/api/og`. Exempt by KNOWN PATH ONLY:
 * `/_next/*`, `/api/*`, robots, the OIDC login paths, and the directories and
 * files that exist in `public/`. Never by file extension: `/@name.png` is a
 * valid Hive account name and runs the profile layout's Hive lookup (~600 ms),
 * so a suffix rule was an unlimited free pass (found in review). Not `/public/`
 * either: next.config.js rewrites it onto the page routes (found in review).
 *
 * Router prefetches count as a page. They cannot be told apart here: Next's
 * middleware adapter strips every flight header (`RSC`, `Next-Router-Prefetch`,
 * `Next-Router-State-Tree`, `Next-Url`) before the middleware runs and puts
 * them back afterwards (next/dist/server/web/adapter.js, FLIGHT_PARAMETERS),
 * so a "cheap prefetch" discount decided here was dead code, proven on a
 * staged server on 2026-09-02 after two reviews had argued about its weight.
 * Browser hints (`purpose: prefetch`) are visible but change nothing about
 * the render, so they earn nothing either. When phase 4 turns hover prefetch
 * on, the per-IP client budget is the knob to raise.
 *
 * EXEMPT, ALWAYS: loopback (the box's own curl and the deploy checks), the
 * addresses in `LUMEN_BUDGET_ALLOW_IPS`, and any request carrying the QA
 * bypass header `x-lumen-qa: <LUMEN_QA_BYPASS_TOKEN>`. Our own QA harnesses
 * burst tens of requests per second from one home address and MUST keep
 * working; the header, not the address, is the durable key, because a home
 * address changes.
 *
 * OFF SWITCH: `LUMEN_BUDGET=off` disables the check entirely (a runtime env
 * var; no rebuild).
 *
 * MEMORY. One small object per active key; a sweep every 60 s drops buckets
 * that are full again (a client that stopped asking) and anything idle for
 * ten minutes; a hard cap clears the table rather than grow past it. With a
 * crawl spread over many addresses that is a few thousand entries, not more.
 *
 * WHAT A 429 LOOKS LIKE. `Retry-After: 30`, `Cache-Control: no-store`, a
 * one-line text body, and NO render: it costs the thread microseconds. One
 * log line per key per minute (not per request, or this would recreate the
 * log flood it is meant to end).
 */

export type BudgetClass = 'search' | 'unfurler' | 'crawler' | 'client';

export interface BudgetInput {
  ip: string;
  userAgent: string;
  pathname: string;
  /** Value of the `x-lumen-qa` header, if any. */
  qaHeader: string | null;
  /** Injected for tests; defaults to Date.now(). */
  now?: number;
}

export type BudgetDecision =
  | { ok: true; reason: 'off' | 'exempt' | 'not-a-page' | 'allowed'; klass?: BudgetClass }
  | { ok: false; klass: BudgetClass; key: string; retryAfterSeconds: number; shouldLog: boolean };

interface Bucket {
  tokens: number;
  updatedAt: number;
  warnedAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 200_000;
const IDLE_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 60_000;
const WARN_EVERY_MS = 60_000;
const RETRY_AFTER_SECONDS = 30;
let lastSweep = 0;
let unknownWarnedAt = 0;
let tableFullWarnedAt = 0;

/**
 * Search engines. `applebot(?!-extended)`: Applebot indexes for Siri and
 * Spotlight; Applebot-Extended is the training opt-in and is a crawler.
 */
const SEARCH_UA = /googlebot|bingbot|duckduckbot|applebot(?!-extended)|yandex(?:bot)?|baiduspider|slurp|oai-searchbot/i;

/** Link preview fetchers: one page per share. */
const UNFURLER_UA =
  /twitterbot|slackbot|discordbot|facebookexternalhit|facebot|whatsapp|telegrambot|linkedinbot|pinterestbot|redditbot|skypeuripreview|applebot.*imessage|mastodon|bluesky|embedly|iframely/i;

/** A human asked an assistant for this page: a client, not a crawl. */
const USER_AGENT_UA = /claude-user|chatgpt-user|perplexity-user/i;

/**
 * Named AI training and SEO crawlers first (the vendor token is the bucket
 * key), then the generic self-declarations. HTTP libraries (`curl`, `wget`,
 * `python-requests`, `axios`, ...) are deliberately NOT here: a script from
 * one address is a client with a per-IP budget; putting it in a shared
 * crawler bucket would have refused the deploy script's own check the moment
 * a crawler was active (found in review).
 */
const VENDOR_UA =
  /(claudebot|anthropic-ai|gptbot|bytespider|ccbot|amazonbot|meta-externalagent|diffbot|omgili|cohere-ai|google-extended|applebot-extended|petalbot|dataforseo|semrushbot|ahrefsbot|mj12bot|dotbot|shapbot|perplexitybot|youbot|timpibot|imagesiftbot)/i;
/**
 * Case-SENSITIVE on purpose: "FooBot/1.0" and "foobot" are crawlers, "CUBOT MAX 3"
 * (an Android phone, upper-case BOT in the device token) is a person (found in
 * review: that phone was sharing a 12/min bucket with every unnamed crawler).
 */
const GENERIC_CRAWLER_UA = /(?:Bot|bot)\b|[Cc]rawl|[Ss]pider|[Ss]crap/;
const BROWSER_UA = /Mozilla\/5\.0 \(.*(?:Android|iPhone|iPad|Windows NT|Macintosh|X11; Linux|CrOS).*\).*(?:Chrome|Firefox|Safari|Edg)\//;

/**
 * Exemptions by KNOWN path only (see the header). Directories and root files
 * are the contents of apps/blog/public plus the legacy prefixes the visit
 * logger already skips. Anything not listed is a page and is counted.
 */
const PUBLIC_DIRS = ['/_next/', '/api/', '/auth/', '/fonts/', '/images/', '/locales/', '/logos/', '/lumen/', '/smart-signer/', '/oidc/', '/.well-known/'];
/**
 * Not in that list, on purpose: `/public/` (next.config.js rewrites
 * `/public/:path*` to `/:path*`, so `/public/@name` IS the profile page: found
 * in review), `/static/` and `/assets/` (nothing is served there; a request lands
 * in the dynamic route), `/sitemap*` (there is no sitemap route). `/api/og` is
 * the one API route that is budgeted: it rasterises a 1200x630 share image on
 * the same thread this whole module protects.
 */
const BUDGETED_API = ['/api/og'];
const PUBLIC_FILES = new Set([
  '/favicon.ico', '/favicon.svg', '/robots.txt', '/site.webmanifest', '/__ENV.js', '/apple-touch-icon.png',
  '/icon-192.png', '/icon-512.png', '/mark-on-ink.svg', '/defaultavatar.png', '/dolphin.png', '/external-icon.svg',
  '/guppy.png', '/hiveauth.png', '/hivesigner.svg', '/minnow.png', '/next.svg', '/orca.png', '/plankton.png',
  '/vercel.svg', '/whale.png'
]);

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function budgetFor(kind: 'search' | 'unfurler' | 'crawler' | 'crawler-all' | 'client'): number {
  switch (kind) {
    case 'search':
      return positiveNumber(process.env.LUMEN_BUDGET_SEARCH_PER_MIN, 60);
    case 'unfurler':
      return positiveNumber(process.env.LUMEN_BUDGET_UNFURLER_PER_MIN, 30);
    case 'crawler':
      return positiveNumber(process.env.LUMEN_BUDGET_CRAWLER_PER_MIN, 12);
    case 'crawler-all':
      return positiveNumber(process.env.LUMEN_BUDGET_CRAWLER_ALL_PER_MIN, 36);
    default:
      return positiveNumber(process.env.LUMEN_BUDGET_PAGE_PER_MIN, 60);
  }
}

export function classify(userAgent: string): { klass: BudgetClass; vendor?: string } {
  const ua = userAgent || '';
  if (SEARCH_UA.test(ua)) return { klass: 'search' };
  if (UNFURLER_UA.test(ua)) return { klass: 'unfurler' };
  if (USER_AGENT_UA.test(ua)) return { klass: 'client' };
  const vendor = VENDOR_UA.exec(ua);
  if (vendor) return { klass: 'crawler', vendor: vendor[1].toLowerCase() };
  // A real browser signature outranks a stray "bot" word; unnamed crawlers are
  // keyed per address (they are many operators, not one) but still count
  // against the class ceiling.
  if (GENERIC_CRAWLER_UA.test(ua) && !BROWSER_UA.test(ua)) return { klass: 'crawler', vendor: 'generic' };
  return { klass: 'client' };
}

/**
 * Known crawler address ranges outrank the user agent: a crawler that drops
 * "bot" from its name is still the same crawler (found in review). Anthropic's
 * range is the one measured in our own logs (RDAP: AWS-ANTHROPIC,
 * 216.73.216.0/22). `LUMEN_BUDGET_CRAWLER_CIDRS="a.b.c.d/nn=vendor,..."` adds more
 * at runtime.
 */
const BUILT_IN_CRAWLER_CIDRS: Array<[string, string]> = [['216.73.216.0/22', 'claudebot']];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null || !Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

export function crawlerVendorByIp(ip: string): string | null {
  if (ip.includes(':')) return null;
  for (const [cidr, vendor] of BUILT_IN_CRAWLER_CIDRS) if (inCidr(ip, cidr)) return vendor;
  const raw = process.env.LUMEN_BUDGET_CRAWLER_CIDRS;
  if (raw) {
    for (const entry of raw.split(',')) {
      const [cidr, vendor] = entry.trim().split('=');
      if (cidr && vendor && inCidr(ip, cidr)) return vendor.toLowerCase();
    }
  }
  return null;
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function allowListed(ip: string): boolean {
  const raw = process.env.LUMEN_BUDGET_ALLOW_IPS;
  if (!raw) return false;
  for (const entry of raw.split(',')) {
    if (entry.trim() === ip) return true;
  }
  return false;
}

function qaBypass(header: string | null): boolean {
  const token = process.env.LUMEN_QA_BYPASS_TOKEN;
  if (!token || !header) return false;
  if (header.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= header.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

/**
 * IPv6 keyed by /56: an ISP hands a home a /56 or a /64 and a cloud tenant a
 * /48, so per-address buckets would be a fresh budget per request and per-/64
 * still gives a /48 owner 65,536 of them. Case-insensitive, v4-mapped
 * addresses fall back to their v4 key, and anything malformed is keyed as the
 * raw string rather than collapsed into a shared prefix (found in review).
 */
export function ipBucketKey(ipRaw: string): string {
  const ip = ipRaw.trim().toLowerCase();
  if (!ip.includes(':')) return ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return mapped[1];
  const noZone = ip.split('%')[0];
  const halves = noZone.split('::');
  if (halves.length > 2) return ip;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return ip;
  if (left.length + right.length > 8) return ip;
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  // An empty group can only come from the one `::` already split off; any other
  // empty group (`:::`, `1:::2`) is malformed and keyed raw.
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return ip;
  const norm = groups.map((g) => g.padStart(4, '0'));
  const fourth = norm[3].slice(0, 2) + '00';
  return `${norm[0]}:${norm[1]}:${norm[2]}:${fourth}::/56`;
}

/** Page renders only, decided by known public paths, never by suffix. */
export function isBudgetedPage(pathname: string): boolean {
  if (!pathname) return false;
  for (const api of BUDGETED_API) if (pathname === api || pathname.startsWith(api + '?') || pathname.startsWith(api + '/')) return true;
  if (PUBLIC_FILES.has(pathname)) return false;
  for (const dir of PUBLIC_DIRS) if (pathname.startsWith(dir)) return false;
  return true;
}

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > IDLE_MS) buckets.delete(key);
  }
}

/**
 * A bucket idle for a minute or more has refilled completely (refill is one
 * capacity per minute), so dropping it loses nothing. That is the ONLY
 * eviction: dropping a live bucket would hand its owner a fresh budget (found
 * in review). If the table is still full after that, the caller fails CLOSED
 * for new keys: a table that fills faster than a minute of idle buckets frees
 * is an attack on this table, and refusing its new arrivals protects the
 * thread; existing buckets keep working.
 */
function evictIdle(now: number): void {
  for (const [key, bucket] of buckets) {
    if (key.startsWith('crawler:')) continue;
    if (now - bucket.updatedAt >= 60_000) buckets.delete(key);
  }
}

/** Visible for tests. */
export function resetBudgets(): void {
  buckets.clear();
  lastSweep = 0;
}

function refresh(key: string, capacity: number, now: number): Bucket | null {
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_KEYS) evictIdle(now);
    if (buckets.size >= MAX_KEYS && !key.startsWith('crawler:')) return null;
    bucket = { tokens: capacity, updatedAt: now, warnedAt: 0 };
    buckets.set(key, bucket);
  } else {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * (capacity / 60_000));
    // A clock that steps backwards must not turn into a refill (found in review).
    bucket.updatedAt = Math.max(bucket.updatedAt, now);
  }
  return bucket;
}

export function checkRequestBudget(input: BudgetInput): BudgetDecision {
  if ((process.env.LUMEN_BUDGET || '').toLowerCase() === 'off') return { ok: true, reason: 'off' };
  if (!isBudgetedPage(input.pathname)) return { ok: true, reason: 'not-a-page' };
  if (isLoopback(input.ip) || allowListed(input.ip) || qaBypass(input.qaHeader)) {
    return { ok: true, reason: 'exempt' };
  }

  const now = input.now ?? Date.now();
  sweep(now);

  /*
   * ★ NO ADDRESS MEANS NO BUDGET, NOT ONE BUDGET FOR EVERYONE (found in review).
   * getClientIp answers 'unknown' when the X-Forwarded-For chain is shorter
   * than LITE_TRUSTED_PROXY_COUNT, which is exactly what happens for a while
   * when a CDN is switched on or off in front of Caddy. Budgeting 'unknown'
   * would put the whole site in one 60/min bucket. Fail open, say so once a
   * minute, and let the operator fix the proxy count.
   */
  if (input.ip === 'unknown' || !input.ip) {
    if (now - unknownWarnedAt >= WARN_EVERY_MS) {
      unknownWarnedAt = now;
      console.warn('budget: client address unknown (check LITE_TRUSTED_PROXY_COUNT against the proxy chain); not budgeting');
    }
    return { ok: true, reason: 'exempt' };
  }

  /*
   * ★ A PERSON ASKING AN ASSISTANT OUTRANKS THE ASSISTANT'S ADDRESS RANGE
   * (found in staging, 2026-09-02). `Claude-User` requests from claude.ai come
   * from the same Anthropic range as ClaudeBot, so the address rule alone put
   * a reader's question about a Lumen page in the training crawler's 12/min
   * bucket, which that crawler keeps empty. "AI is welcome" means the person
   * asking is welcome first of all: the user-initiated agents keep their
   * per-IP client budget wherever they come from; everything else from a known
   * crawler range is that crawler.
   */
  const declared = classify(input.userAgent);
  const byIp = USER_AGENT_UA.test(input.userAgent) ? null : crawlerVendorByIp(input.ip);
  const { klass, vendor } = byIp ? { klass: 'crawler' as const, vendor: byIp } : declared;
  const ipKey = ipBucketKey(input.ip);
  const checks: Array<{ key: string; capacity: number }> =
    klass === 'crawler'
      ? [
          { key: vendor === 'generic' ? `crawler:generic:${ipKey}` : `crawler:${vendor}`, capacity: budgetFor('crawler') },
          { key: 'crawler:*', capacity: budgetFor('crawler-all') }
        ]
      : [{ key: `${klass}:${ipKey}`, capacity: budgetFor(klass) }];

  const cost = 1;
  const refreshed: Array<{ key: string; bucket: Bucket }> = [];
  for (const { key, capacity } of checks) {
    const bucket = refresh(key, capacity, now);
    if (!bucket) {
      const shouldLog = now - tableFullWarnedAt >= WARN_EVERY_MS;
      if (shouldLog) tableFullWarnedAt = now;
      return { ok: false, klass, key: 'table-full', retryAfterSeconds: RETRY_AFTER_SECONDS, shouldLog };
    }
    refreshed.push({ key, bucket });
  }
  const exhausted = refreshed.find(({ bucket }) => bucket.tokens < cost);
  if (!exhausted) {
    for (const { bucket } of refreshed) bucket.tokens -= cost;
    return { ok: true, reason: 'allowed', klass };
  }

  const shouldLog = now - exhausted.bucket.warnedAt >= WARN_EVERY_MS;
  if (shouldLog) exhausted.bucket.warnedAt = now;
  return { ok: false, klass, key: exhausted.key, retryAfterSeconds: RETRY_AFTER_SECONDS, shouldLog };
}
