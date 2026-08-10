import { redirect } from 'next/navigation';

/**
 * ★ RETIRED (owner ruling, 2026-08-08): "trending hot created muted payout we
 * don't need at all."
 *
 * Lumen has one feed — the ranked home feed — plus topic pages. These five
 * inherited chain-sort pages were a second, competing way to browse, in a
 * different visual language, that nothing in Lumen's own navigation ever
 * linked to. The route survives only so old links and bookmarks land
 * somewhere real instead of a 404.
 */
const Page = () => {
  redirect('/');
};

export default Page;
