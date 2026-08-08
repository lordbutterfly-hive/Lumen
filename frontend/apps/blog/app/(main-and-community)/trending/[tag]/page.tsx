import { redirect } from 'next/navigation';

interface PageProps {
  params: { tag: string };
}

/**
 * ★ NO COMMUNITY PAGES (owner ruling, 2026-08-07).
 *
 * Lumen dropped communities as a section — there are no moderator tools, roles
 * or subscribe flows to host. A community is simply shown as a TAG: the same
 * Lumen feed, filtered to it. So every tag, community id or plain topic alike,
 * redirects to `/topics/<tag>`.
 *
 * This route only still exists because links to it are everywhere — in old
 * posts, in bookmarks, and in Hive content we render.
 */
const Page = ({ params }: PageProps) => {
  redirect(`/topics/${encodeURIComponent(params.tag.toLowerCase())}`);
};

export default Page;
