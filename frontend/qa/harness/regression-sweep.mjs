/**
 * HARNESS — did today's fixes break anything?
 *
 * ~35 changes landed today, many of them quickly, some on a wrong first
 * diagnosis that had to be walked back. Each was verified by a narrow check
 * written by the same person who made the change. Nobody has driven them
 * TOGETHER, and several touch shared code:
 *
 *   · `chainObserver()` replaced the same expression in TWELVE files.
 *   · `isError && entries.length === 0` changed error handling in FOUR lists —
 *     which could now HIDE a real failure behind stale content.
 *   · The Follow control on post pages pulls the WASM signer onto a reading
 *     surface it never loaded before.
 *   · `distDir`, CSP, observer cookie and session changes all affect every page.
 *
 * Your job is not to re-confirm the fixes. It is to find what they cost.
 */
import { openApp, visit, BASE } from '../../qa-harness.mjs';
export { openApp, visit, BASE };

/** Everything that changed today, and the neighbour most likely to have broken. */
export const CHANGES = [
  { area: 'chain observer', what: 'chainObserver() in 12 files; lite handle never sent to Hive', neighbour: 'Do personalised reads still work for a HIVE-keyed viewer? Vote/follow/mute state, community subscribe, "my feed" — anything that used to rely on observer being the username.' },
  { area: 'list error handling', what: 'profile posts/comments, search, tag pages: only error when empty', neighbour: 'Does a genuinely failing list now show STALE content and no error? Force a failure (offline, bad tag) and see whether you are ever told.' },
  { area: 'follow on posts', what: 'ButtonsContainer added to the post byline', neighbour: 'Post page weight and first-paint; does it work for a lite author, a chain author, yourself, and logged out? Does mute stay hidden?' },
  { area: 'Following feed', what: 'new /api/lite/feed/following merging Lumen + chain authors', neighbour: 'Ordering, duplicates, a followee with no posts, unfollow mid-session, >24 followees (the chain fan-out cap).' },
  { area: 'follow lists', what: 'lite fallback in both follow hooks', neighbour: 'A HIVE account with real followers must still page correctly — the fallback only fires on an empty first page, so check page 2+.' },
  { area: 'search', what: 'pattern normalisation + account/tag namespace normalisation', neighbour: 'Does a legitimate search still work? Accents, CJK, hyphens, a real account with dots, a tag with digits.' },
  { area: 'toasts/errors', what: 'readable message promoted to the title; detail mounts when expanded', neighbour: 'Does a RAW chain error still get refused? And do genuine errors still surface at all?' },
  { area: 'submit gating', what: 'live trimmed values; reply box zero-width', neighbour: 'Can you still submit legitimate content — leading spaces, markdown, a single character, emoji?' },
  { area: 'avatars', what: 'dead image host falls back to a generated avatar', neighbour: 'Does a REAL avatar still load? And is the fallback cached so it does not re-fetch per row?' },
  { area: 'creator tokens', what: 'deep links honour the write gate and the wind-down rail; overdue banner', neighbour: 'Can a capable account still reach Buy/Sell/Ask by deep link? The gate must not block someone who CAN sign.' },
  { area: 'publish confirmation', what: 'toasts on composer, editor, reply', neighbour: 'Do they appear on failure too, and is the failure message readable rather than "Error"?' },
  { area: 'streak / hivesense / notifications', what: 'queries gated off for lite accounts', neighbour: 'Do they still RUN for a chain account? A gate that never opens is the same bug in reverse.' },
  { area: 'empty vs error', what: 'tag page treats "does not exist" as empty', neighbour: 'Does a real outage now read as "nobody posted here yet"? That is the failure this fix could have introduced.' }
];

/** Force a page to fail so you can see whether the app admits it. */
export async function withOffline(page, fn) {
  await page.context().setOffline(true);
  try { return await fn(); } finally { await page.context().setOffline(false); }
}

/** Time to first meaningful paint-ish, for the weight question on post pages. */
export async function timeTo(page, path, selector, timeout = 30000) {
  const t = Date.now();
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
  const ok = await page.locator(selector).first().waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
  return { ms: Date.now() - t, appeared: ok };
}
