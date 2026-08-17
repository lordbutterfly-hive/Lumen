import { permanentRedirect } from 'next/navigation';

/**
 * ★ 2026-08-17 — `/meritum` 404'd while the left rail links to the creator-token
 * surface (`features/layouts/left-rail.tsx`, "Creators" row) and every mention of
 * "Meritum" in the product is the BRAND name for that surface, not a route of its
 * own -- `grep -rn "meritum" app` (source, not `.next*` build output) never
 * defines one; the real pages all live under `/creators` (`app/creators/**`).
 *
 * Fixed with a redirect rather than a left-rail change: the rail's own link is
 * already correct (`href="/creators"`). "Meritum" is the word this product
 * actually calls the feature everywhere a reader sees it (marketing copy, the
 * coin itself, `meritum-launch-flow.tsx`'s own headline "Launch your Meritum"),
 * so `/meritum` is exactly the spelling an external link, tweet or bookmark is
 * most likely to use -- fixing only the rail would leave that guess 404ing.
 *
 * Same `page.tsx` + `redirect()` stub shape `next.config.js`'s "RETIRED ROUTES"
 * comment documents for `/trending` etc. -- the framework's own redirect
 * mechanism, not a client-side bounce. `permanentRedirect` (308), not the
 * temporary `redirect()` those retired-sort stubs use: this isn't a migration in
 * progress with somewhere else it might still move to -- see `/followed`
 * (`[param]/(user-profile)/followed/page.tsx`) for the same call on an
 * unconditional rename to one canonical destination, and `next.config.js`'s
 * `/help`, `/tos`, `/privacy` entries for the same reasoning at the config layer.
 *
 * No `loading.tsx`/`layout.tsx` sits above this segment, so -- unlike those
 * retired-sort stubs -- there is no streaming boundary to degrade this into a
 * meta-refresh; it answers as a real 308.
 */
const Page = () => {
  permanentRedirect('/creators');
};

export default Page;
