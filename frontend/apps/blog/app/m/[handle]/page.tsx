import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import MeritumLanding from '@/blog/features/creator-tokens/ui/meritum-page/meritum-landing';
import { displayHandle } from '@/blog/features/creator-tokens/live/adapt';
import { creatorPagePath, creatorPageUrl, isRoutableCreatorHandle, normalizeCreatorHandle } from '@/blog/lib/meritum/creator-handle';
import { readCreatorMarketSummary } from '@/blog/lib/meritum/server-market';
import { readCreatorProfile } from '@/blog/lib/meritum/server-profile';

/**
 * ★★★ `/m/<handle>` — ONE PUBLIC PAGE PER CREATOR (owner, 2026-09-15, from
 * the Meritum creator landing handoff). The address a creator shares, links
 * and gets previewed: public (no session to read it), server-rendered head
 * (crawlers that scrape the card never run JavaScript), a 404 when the
 * account has no Meritum (never an empty page), canonical (the old
 * `/creators/<handle>` redirects here permanently).
 *
 * Two server reads, both cached and both allowed to fail without taking the
 * page down: the market summary (registered? price?) decides the 404 and
 * feeds the card; the profile feeds the description and the hero. A read
 * that could not complete is NOT a 404 — a node outage is not a creator
 * without a market — so on a null summary the page renders and the client
 * hook shows its own honest error state.
 *
 * ★ `force-dynamic`: the head carries a live price. Prerendering this at
 * build (which Next does for any segment it can) would freeze that price in
 * the artifact until the next deploy — the exact trap `/api/builders-board`
 * fell into on 2026-09-15.
 */
export const dynamic = 'force-dynamic';

function siteDomain(): string {
  return process.env.REACT_APP_SITE_DOMAIN || 'http://localhost:3000';
}

/** A price that will not change the URL on every sub-cent tick: whole cents. */
function priceKey(priceUsd: number): string {
  return String(Math.round(Math.max(0, priceUsd) * 100));
}

export async function generateMetadata({ params }: { params: { handle: string } }): Promise<Metadata> {
  const handle = normalizeCreatorHandle(params.handle);
  if (!isRoutableCreatorHandle(handle)) return { title: 'Meritum' };
  // ★ MARKET FIRST, PROFILE ONLY FOR A MARKET THAT EXISTS (review, 2026-09-15):
  // a made-up handle must cost one cached chain read, not also a Postgres
  // lookup and a Hive RPC on the way to a 404.
  const summary = await readCreatorMarketSummary(handle);
  if (summary && !summary.registered) return { title: 'Meritum' };
  const profile = await readCreatorProfile(handle);
  const shown = displayHandle(handle);
  const title = `@${shown} on Lumen`;
  // The Hive `about`, verbatim, or a sentence that makes no claim about the person.
  const description = profile.about ?? `The Meritum of @${shown} on Lumen: buy the token, spend it on their work.`;
  const url = creatorPageUrl(siteDomain(), handle);
  const card = `/api/og/meritum?u=${encodeURIComponent(handle)}&v=${priceKey(summary?.priceUsd ?? 0)}`;
  return {
    // `absolute`: the layout's title template appends " - Lumen", which would
    // read "@x on Lumen - Lumen" in the tab. The og/twitter titles below are
    // plain strings and never templated.
    title: { absolute: title },
    description,
    alternates: { canonical: creatorPagePath(handle) },
    openGraph: {
      title,
      description,
      url,
      type: 'profile',
      images: [{ url: card, width: 1200, height: 630, alt: `@${shown} on Lumen` }]
    },
    twitter: { card: 'summary_large_image', title, description, images: [card] }
  };
}

export default async function MeritumCreatorPage({ params }: { params: { handle: string } }) {
  const handle = normalizeCreatorHandle(params.handle);
  if (!isRoutableCreatorHandle(handle)) notFound();
  // Your own token is managed in the Studio, not traded from its public page.
  if (handle === 'you') redirect('/creators/studio');
  const summary = await readCreatorMarketSummary(handle);
  // ★ Only a CONFIRMED "never registered" is a 404. `summary === null` is a
  // read that failed; the page renders and says so itself. The profile is read
  // only past this gate (see generateMetadata).
  if (summary && !summary.registered) notFound();
  const profile = await readCreatorProfile(handle);
  return <MeritumLanding handle={handle} profile={profile} shareUrl={creatorPageUrl(siteDomain(), handle)} />;
}
