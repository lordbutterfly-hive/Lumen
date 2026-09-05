/**
 * ★ 2026-08-28: this file put HIVE's branding on LUMEN's share cards. Every
 * community page without its own avatar produced an og:image of
 * `https://hive.blog/images/hive-blog-share.png`, a title ending "- Hive", and the
 * description "Hive: Communities Without Borders." Verified live on
 * /roles/hive-139531 before the fix. Nothing here is env-driven, so the
 * REACT_APP_BLOG_DOMAIN fix did not cover it. Now Lumen's own og image and copy.
 */
import { Metadata } from 'next';
import { getCommunityCached } from '@/blog/lib/cached-api';
import { getLogger } from '@ui/lib/logging';
import { isCommunity } from '@ui/lib/utils';

const logger = getLogger('app');

export async function buildCommunityTagMetadata(
  params: { tag: string },
  sectionLabel?: string
): Promise<Metadata> {
  const tag = params.tag;

  if (!isCommunity(tag)) return { title: `#${tag}${sectionLabel ? ` / ${sectionLabel}` : ''} - Lumen` };

  try {
    const data = await getCommunityCached(tag);

    const communityName = data?.title ?? data?.name ?? tag;
    const titleSection = sectionLabel ? ` / ${sectionLabel}` : '';
    const title = `${communityName}${titleSection} - Lumen`;
    const description = data?.description || `${tag} community. A calmer place to read and write.`;
    /**
     * ★ Falls through to OUR generated share card, not a flat logo (2026-08-28).
     * `/api/og` draws the name in Lora on Lumen's paper; it is the same card
     * `app/[param]/[p2]/[permlink]/layout.tsx:209` already falls back to for a
     * post with no image, and that comment records the identical bug being fixed
     * there: without it the fallback "advertised a different product". Community
     * pages never got the same treatment and were still serving
     * hive.blog/images/hive-blog-share.png. `author` is omitted deliberately — a
     * community has none, and the card drops the segment and its separator rather
     * than printing a stranded middot.
     */
    const generatedCard = (() => {
      const p = new URLSearchParams();
      p.set('title', String(communityName));
      p.set('community', String(data?.name ?? tag));
      return `/api/og?${p.toString()}`;
    })();
    const image = data?.avatar_url || generatedCard;

    return {
      title,
      description,
      openGraph: {
        title,
        description,
        images: [image]
      },
      twitter: {
        card: 'summary_large_image',
        title,
        description,
        images: [image]
      }
    };
  } catch (error) {
    logger.error(error, 'Error in buildCommunityTagMetadata:');
  }
  return {
    title: `#${tag}${sectionLabel ? ` / ${sectionLabel}` : ''} - Lumen`,
    description: `${tag} community. A calmer place to read and write.`,
    openGraph: {
      title: `#${tag}${sectionLabel ? ` / ${sectionLabel}` : ''} - Lumen`,
      description: `${tag} community. A calmer place to read and write.`,
      images: [`/api/og?title=${encodeURIComponent(`#${tag}`)}`]
    }
  };
}
