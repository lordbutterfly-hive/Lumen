import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isValidTagFormat, isCommunityFormat } from '@transaction/lib/validation';
import TopicShell from '@/blog/features/discovery-feed/topic-shell';

/**
 * A topic, rendered as the Lumen feed.
 *
 * ★ WHY THIS ROUTE EXISTS OUTSIDE `(main-and-community)` (2026-08-07). Topics
 * used to live at `/trending/<tag>` inside that route group, whose layout wraps
 * every child in the inherited denser shell — a second navigation column and a
 * communities list. Rendering the Lumen feed INSIDE that layout still left the
 * old chrome around it, so the page remained visibly the old product. A route
 * group's layout cannot be opted out of; the only way out is to not be in it.
 *
 * `/trending/<tag>` now redirects here for plain tags, and keeps the community
 * layout for `hive-12345` ids, which genuinely need it (moderators, roles,
 * subscribe).
 */
export function generateMetadata({ params }: { params: { tag: string } }): Metadata {
  const tag = decodeURIComponent(params.tag);
  return {
    title: `#${tag}`,
    description: `Posts about ${tag} on Lumen, ranked for you.`
  };
}

const Page = ({ params }: { params: { tag: string } }) => {
  const tag = decodeURIComponent(params.tag).toLowerCase();
  // Community ids arrive here too — they are shown as tags, never as pages.
  if (!isValidTagFormat(tag) && !isCommunityFormat(tag)) notFound();
  return <TopicShell tag={tag} />;
};

export default Page;
