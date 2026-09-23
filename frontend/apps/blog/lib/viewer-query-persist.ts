'use client';

import { dehydrate, hydrate, type Query, type QueryClient } from '@tanstack/react-query';

/**
 * ★ THE READER'S OWN DATA SURVIVES A PAGE LOAD (2026-09-23, owner: "should home fire 20-26
 * api calls?").
 *
 * Measured in the owner's own signed-in home loads (Caddy access log, 28 loads): ~26
 * requests after the page, about a dozen of them about the reader (account, manabar,
 * blacklist, ignore list, Lumen block list, interests, own rank, wallet DIDs, Lumen
 * notification rows) and each asked again on every full page load, because React Query's
 * cache lives in memory and a full load starts empty. Most of these already carry a 1-10
 * minute staleTime; they simply never had a chance to use it across loads.
 *
 * This keeps the successful results for those keys in sessionStorage (per tab, per reader)
 * and restores them on the next load.
 *
 * ★ RESTORED AFTER HYDRATION, NEVER DURING IT. Restoring before React hydrates would give a
 * component keyed on the server-known identity data the server did not have, so its first
 * client render would differ from the server HTML and React would throw that subtree's HTML
 * away and render it again. Restoring right after hydration costs nothing on screen, and
 * every query that is enabled later than that (most of these wait for the client identity
 * or another read, and start 1.6-3.6s after the page request in the access log) finds its
 * answer already there and, within its own staleTime, does not ask again.
 *
 * Scope rules: only the keys below, only successful results, only the reader who saved them
 * (a different username drops everything), and nothing older than MAX_AGE_MS. Mutations keep
 * working as before: they invalidate these keys, the refetch lands, and the new value is the
 * one saved next.
 */

const STORAGE_KEY = 'lumen-viewer-queries:v1';
const MAX_AGE_MS = 15 * 60_000;
const WRITE_DELAY_MS = 1_000;

/** First element of each persisted key, with the rest of the key checked where it matters. */
function isPersistedKey(key: readonly unknown[]): boolean {
  const [root, second, third] = key;
  switch (root) {
    case 'loggedUserAccount': // header account + voting power (use-logged-user)
    // NOT 'manabars': its readings carry `cooldown: Date` (chain-fetch.ts), which JSON would
    // bring back as a string. It refetches every 60 s anyway.
    case 'blacklisted': // the reader's blacklist (use-follow-list)
    case 'lumenBlockList': // Lumen blocks (use-lumen-block)
    case 'liteInterests': // interests (interest-picker)
    case 'retention': // own rank emblem (use-retention)
    case 'rank-marks': // author rank emblems on the page (use-rank-marks)
    case 'LumenNotifications': // Lumen bell rows (use-lumen-notifications)
    case 'unreadNotifications': // the bell's chain count; the header polls it every 20 s anyway
    case 'retention-nudge-notifications': // the feed nudge's 12 rows (5 min staleTime, retention-nudge.tsx)
    case 'right-rail-builders-board': // 5 min staleTime, server roster refreshes every 10 min (builders.tsx)
      return true;
    case 'followingData': // only the ignore (mute) list, not browsed follow lists
      return third === 'ignore';
    case 'creatorTokens': // the reader's wallet DIDs
      return second === 'walletDids';
    // NOT the Meritum market or the batched feed prices: `readMarketPrices` returns a Map
    // (JSON would bring back `{}` and every chip's `.get()` would throw), and the Market
    // object is too large a shape to vouch for field by field. Both are now fresh for
    // 10 minutes in memory instead (use-token-price-chip.ts).
    // NOT the contract rules (['meritum','contract-rules']): their 60 s window is deliberate,
    // two screens share it so they "cannot disagree, even mid-flip" (use-contract-rules.ts),
    // and the v6 flip is on 2026-09-24.
    default:
      return false;
  }
}

/**
 * Only data that survives JSON unchanged: plain objects, arrays, strings, finite numbers,
 * booleans and null. A Date, Map, Set, BigInt or class instance would come back as something
 * else and break the code reading it, so a result holding one is simply not saved. This is
 * the guard for keys added later, not only for the ones above.
 */
function isPlainJson(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object': {
      if (Array.isArray(value)) return value.every((v) => isPlainJson(v, depth + 1));
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return false;
      return Object.values(value as Record<string, unknown>).every((v) => v === undefined || isPlainJson(v, depth + 1));
    }
    default:
      return false;
  }
}

function shouldPersist(query: Query): boolean {
  return (
    Array.isArray(query.queryKey) &&
    isPersistedKey(query.queryKey) &&
    query.state.status === 'success' &&
    query.state.data !== undefined &&
    isPlainJson(query.state.data)
  );
}

interface Saved {
  viewer: string;
  savedAt: number;
  state: ReturnType<typeof dehydrate>;
}

function read(): Saved | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

export function clearViewerQueries(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* blocked storage: nothing was saved either */
  }
}

/** Put the saved results for `viewer` back into the cache. Call after hydration. */
export function restoreViewerQueries(client: QueryClient, viewer: string): void {
  if (!viewer) return;
  const saved = read();
  if (!saved) return;
  if (saved.viewer !== viewer || Date.now() - saved.savedAt > MAX_AGE_MS) {
    clearViewerQueries();
    return;
  }
  try {
    // `hydrate` never replaces data that is newer than what it brings, so a query that
    // already answered on this load keeps its own answer.
    hydrate(client, saved.state);
  } catch {
    clearViewerQueries();
  }
}

/** Save the persisted keys whenever one of them changes. Returns the unsubscribe. */
export function persistViewerQueries(client: QueryClient, viewer: string): () => void {
  if (!viewer) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const write = () => {
    timer = null;
    try {
      const state = dehydrate(client, { shouldDehydrateQuery: shouldPersist });
      if (state.queries.length === 0) return;
      const saved: Saved = { viewer, savedAt: Date.now(), state };
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
      /* quota or blocked storage: the next load simply asks again, as before */
    }
  };
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || !shouldPersist(event.query)) return;
    if (timer === null) timer = setTimeout(write, WRITE_DELAY_MS);
  });
  return () => {
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
  };
}
