import { siteConfig } from '@ui/config/site';
import { accountReputationPrecise } from '@ui/lib/reputation';

/**
 * ★★★ THE NOTIFICATION "REP" WAS NEVER A REPUTATION (2026-09-11, owner: "REP in
 * notifications is not working properly").
 *
 * `bridge.account_notifications` returns a `score` per row and the bell rendered
 * it under the label "Rep". It is not one. Hivemind's notification score is an
 * IMPORTANCE score whose meaning changes with the notification type:
 *
 *   - a VOTE row is scored from the vote's payout, so every ordinary vote reads
 *     25 no matter who cast it (measured 2026-09-11 on @lordbutterfly's live
 *     feed: @ace108 reputation 79.84 -> score 25, @wiseagent 81.5 -> 25);
 *   - a REPLY/MENTION row is scored from the actor's reputation but on a
 *     DIFFERENT curve than the displayed one — hivemind uses a 7.5 multiplier
 *     where the reputation formula uses 9, so it under-reads every actor by
 *     (rep - 25) / 6 (@daveks 82.7 -> 73, @godfish 77.52 -> 69, @artofkylin
 *     66.4 -> 59, @zydhwt25 36.13 -> 34 — all four fit 25 + (rep - 25) * 5/6).
 *
 * So the badge was wrong for every row and catastrophically wrong for votes,
 * which are most of them. The number the label promises has to be FETCHED.
 *
 * ONE HTTP request for the whole list: JSON-RPC batching, which api.hive.blog
 * supports and which turns ~30 distinct actors into a single round trip. Per-row
 * errors come back per-row (a deleted/renamed actor is just skipped) instead of
 * failing the batch.
 *
 * DEGRADES OPEN, ALWAYS: a node hiccup returns an empty map and the caller drops
 * the badge for that row. A missing badge is honest; a wrong one is the bug.
 */
// A reputation moves over days; 6 hours keeps repeat notification actors off the network.
const TTL_MS = 6 * 60 * 60_000;
const MAX_ENTRIES = 2_000;
/** Hive's own list cap is 100 rows, so this bounds the batch at well over the worst case. */
const MAX_BATCH = 100;
const TIMEOUT_MS = 6_000;

const cache = new Map<string, { rep: number; expires: number }>();

/**
 * Human-readable reputations (hivemind's already-converted value, e.g. 79.84)
 * for the given account names, keyed lower-case. Names it could not resolve are
 * simply absent — never defaulted, because 25 is a real reputation and guessing
 * it would reproduce the exact lie this module exists to remove.
 */
export async function reputationsFor(names: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const now = Date.now();
  const misses: string[] = [];

  for (const name of new Set(names.map((n) => (n ?? '').trim().toLowerCase()).filter(Boolean))) {
    const hit = cache.get(name);
    if (hit && hit.expires > now) out.set(name, hit.rep);
    else misses.push(name);
  }
  if (misses.length === 0) return out;

  try {
    const batch = misses.slice(0, MAX_BATCH);
    /*
     * ★ `condenser_api.get_account_reputations`, NOT `bridge.get_profile` (2026-09-23,
     * owner: "loading notifications it's super slow"). get_profile makes hivemind build a
     * whole profile per name to hand back one number: 46 names took 1.29-1.55s on
     * api.hive.blog, the same 46 through get_account_reputations 0.53s. (Not
     * `condenser_api.get_accounts`: on Hive its `reputation` is 0 for every account, which
     * would have drawn 25 on every badge; checked before this was written.) The call takes
     * a LOWER BOUND, so a name that does not exist returns the next account alphabetically:
     * only an exact name match is used. The raw value is converted with the formula every
     * badge in the app uses (`accountReputationPrecise`, 2 decimals, get_profile's precision).
     */
    const res = await fetch(siteConfig.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        batch.map((account, id) => ({
          jsonrpc: '2.0',
          method: 'condenser_api.get_account_reputations',
          params: [account, 1],
          id
        }))
      ),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) return out;
    const rows: unknown = await res.json();
    if (!Array.isArray(rows)) return out;

    const expires = Date.now() + TTL_MS;
    for (const row of rows) {
      const id = (row as { id?: unknown })?.id;
      const asked = typeof id === 'number' ? batch[id] : undefined;
      const first = ((row as { result?: unknown })?.result as { account?: unknown; reputation?: unknown }[] | undefined)?.[0];
      if (!asked || typeof first?.account !== 'string' || first.account.toLowerCase() !== asked) continue;
      const raw = first.reputation;
      if (typeof raw !== 'number' && typeof raw !== 'string') continue;
      const rep = Number(accountReputationPrecise(raw, 2));
      if (!Number.isFinite(rep)) continue;
      cache.set(asked, { rep, expires });
      out.set(asked, rep);
    }

    // Bounded, insertion-ordered — the key space is account names an anonymous
    // visitor can drive, so this must not grow without a ceiling.
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  } catch {
    // Degrade open: no reputations, no badges, no wrong numbers.
  }
  return out;
}
