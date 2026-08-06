import 'server-only';
import { getLogger } from '@ui/lib/logging';

const logger = getLogger('app');

/**
 * ★★★ THE CONSUMER THE RANKING ENGINE NEVER HAD (2026-08-06).
 *
 * recsys has served `/feed?viewer=…` since it was built — bearer auth, rate
 * limiting, a FAIL_CLOSED staleness gate, 870 tests, 16 measurement panels and
 * five design councils behind its scoring. Nothing ever called it. "For You"
 * was `sort: 'trending'` against Hive's own bridge API, i.e. the same global
 * payout-ranked list every other Hive frontend shows, identical for every
 * viewer. The entire personalisation effort was connected to nothing.
 *
 * This module is the missing half.
 *
 * ★ SERVER-ONLY, and `import 'server-only'` enforces it at build time rather
 * than by convention. `RECSYS_API_TOKEN` is a shared bearer secret: shipping it
 * in a client bundle would hand every visitor the ability to request ANY
 * account's ranked feed plus its full score decomposition, which is exactly the
 * exposure recsys's own auth was added to close. The browser talks to
 * `/api/feed/for-you`; only this file talks to recsys.
 */

export interface RecsysScore {
  vote_norm: number;
  rep_norm: number;
  organic: number;
  final: number;
}

export interface RecsysPost {
  key: string;
  /** RANKED identity — a `lumen_user_id` (ULID) for a Lumen Lite post. */
  author: string;
  permlink: string;
  /**
   * The account the post actually lives under on chain, or null when it is the
   * same as `author`. A lite post is published under the shared publisher
   * account, so `author` alone cannot be fetched from Hive — hydrate from
   * `chain_author ?? author`.
   */
  chain_author: string | null;
  category: string;
  created: string;
  source: string;
  score: RecsysScore;
}

export interface RecsysFeed {
  viewer: string;
  generated_at: string;
  count: number;
  posts: RecsysPost[];
}

export interface RecsysConfig {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

/**
 * Absent config means the feature is OFF, not broken — the caller falls back to
 * the chronological/trending feed and says so. Same posture as the creator-token
 * and prediction-market data sources: unconfigured is honest-unavailable, never
 * a silent half-feature.
 */
export function getRecsysConfig(): RecsysConfig | null {
  const baseUrl = (process.env.RECSYS_FEED_URL || '').replace(/\/+$/, '');
  const token = process.env.RECSYS_API_TOKEN || '';
  if (!baseUrl) return null;
  const raw = Number(process.env.RECSYS_FEED_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(raw) && raw > 0 ? raw : 4000;
  return { baseUrl, token, timeoutMs };
}

export type RecsysOutcome =
  | { ok: true; feed: RecsysFeed }
  | { ok: false; reason: 'unconfigured' | 'unavailable' | 'refused'; detail: string };

/**
 * Ask recsys for a viewer's ranked feed.
 *
 * `follows` and `mutes` are passed explicitly because a **lite** viewer's social
 * graph exists only in Lumen's own Postgres — recsys cannot look up a ULID on
 * chain, and without these a lite viewer would be ranked as though they follow
 * and mute nobody. For a full Hive account both may be omitted: recsys resolves
 * the graph from the chain itself.
 *
 * ★ A TIMEOUT IS MANDATORY HERE, not defensive dressing. recsys's own warm
 * NormContext build was measured at ~232s against the live mirror, and its
 * `/feed` refuses (503) rather than degrading whenever the weekly trust
 * snapshot is stale. A feed page must never inherit either of those as a hang —
 * it falls back and stays fast.
 */
export async function fetchRankedFeed(opts: {
  viewer: string;
  limit?: number;
  follows?: string[];
  mutes?: string[];
  tags?: string[];
}): Promise<RecsysOutcome> {
  const config = getRecsysConfig();
  if (!config) {
    return { ok: false, reason: 'unconfigured', detail: 'RECSYS_FEED_URL is not set' };
  }

  const params = new URLSearchParams({ viewer: opts.viewer });
  if (opts.limit) params.set('limit', String(opts.limit));
  // Only send the explicit-state params when we actually have them. Sending an
  // EMPTY `follows=` is not the same as omitting it: recsys reads a present-but-
  // empty list as "this viewer follows nobody" and an absent one as "derive it".
  // For a lite viewer the empty set is the truthful answer and must be sent; for
  // a Hive viewer sending it would erase their real graph.
  if (opts.follows) params.set('follows', opts.follows.join(','));
  if (opts.mutes) params.set('mutes', opts.mutes.join(','));
  if (opts.tags?.length) params.set('tags', opts.tags.join(','));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(`${config.baseUrl}/feed?${params.toString()}`, {
      method: 'GET',
      headers: config.token ? { authorization: `Bearer ${config.token}` } : {},
      signal: controller.signal,
      cache: 'no-store'
    });

    if (res.status === 503) {
      // The documented FAIL_CLOSED path: the trust snapshot is absent or stale,
      // so every Sybil defence would silently revert to fail-open and recsys
      // refuses to rank rather than serve an unprotected feed. Correct
      // behaviour, and a fallback condition — not an error to show a reader.
      const body = await res.text().catch(() => '');
      logger.warn('recsys /feed refused (503) — falling back. %s', body.slice(0, 200));
      return { ok: false, reason: 'refused', detail: body.slice(0, 200) || 'trust unavailable' };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn('recsys /feed returned %d — falling back. %s', res.status, body.slice(0, 200));
      return { ok: false, reason: 'unavailable', detail: `HTTP ${res.status}` };
    }

    const feed = (await res.json()) as RecsysFeed;
    if (!Array.isArray(feed?.posts)) {
      return { ok: false, reason: 'unavailable', detail: 'malformed response (no posts array)' };
    }
    return { ok: true, feed };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    // An aborted request is the timeout above, which is a normal operational
    // state (cold recsys, slow mirror), not an exception worth a stack trace.
    logger.warn('recsys /feed unreachable — falling back. %s', detail);
    return { ok: false, reason: 'unavailable', detail };
  } finally {
    clearTimeout(timer);
  }
}
