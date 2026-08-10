import { redirect } from 'next/navigation';

interface PageProps {
  params: { tag: string };
}

/**
 * ★ A TAG IS STILL A REAL PAGE — the chain-sort SHELL around it is not.
 *
 * The parent feed (trending/hot/created/muted/payout) is retired per the
 * 2026-08-08 owner ruling, but a link to a specific tag should still take a
 * reader somewhere useful, so it lands on Lumen's own topic page.
 */
const Page = ({ params }: PageProps) => {
  redirect(`/topics/${encodeURIComponent(params.tag.toLowerCase())}`);
};

export default Page;
