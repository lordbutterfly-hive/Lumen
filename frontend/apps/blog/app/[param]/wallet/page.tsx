import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { extractUsernameFromParam, isUsernameValid } from '@/blog/utils/validate-links';
import { isBannedAuthor } from '@/blog/lib/moderation/banned-authors';
import { resolvePublicWalletTarget } from '@/blog/features/wallet/public/lib/resolve-public-wallet-target';
import { WalletSummaryProvider } from '@/blog/features/wallet/lib/wallet-summary-context';
import { defaultWalletTab, parseWalletTab } from '@/blog/features/wallet/lib/wallet-tab';
import PublicWalletShell from '@/blog/features/wallet/public/public-wallet-shell';

/**
 * Read-only copy of app/wallet/page.tsx's server page, for the public
 * /@name/wallet route. Removed: the session redirect and the seed race keyed
 * on session.username, since this page has no signed in user to seed with
 * (D5); resolvePublicWalletTarget races that same budget against the URL
 * name instead. Added: the same name format, ban and existence gates
 * app/[param]/(user-profile)/page.tsx already applies to an arbitrary
 * profile name, since this route also renders whatever name is in the URL.
 */

export async function generateMetadata({ params }: { params: { param: string } }): Promise<Metadata> {
  const name = extractUsernameFromParam(params.param);
  if (!name || isBannedAuthor(name) || !(await isUsernameValid(name))) {
    return { title: 'Wallet' };
  }
  return {
    title: `@${name}'s wallet`,
    description: `What @${name} holds on Hive, Magi and Meritum. Read-only.`
  };
}

export default async function Page({
  params,
  searchParams
}: {
  params: { param: string };
  searchParams?: { [key: string]: string | string[] | undefined };
}) {
  const name = extractUsernameFromParam(params.param);
  if (!name) notFound();
  if (isBannedAuthor(name)) notFound();
  if (!(await isUsernameValid(name))) notFound();

  const target = await resolvePublicWalletTarget(name);
  if (target.kind === 'none') notFound();

  // Reading searchParams keeps this route dynamic, which is what lets the
  // client shell call useSearchParams() without a Suspense boundary (same
  // mechanism as app/wallet/page.tsx). Keep this read even if the tab logic
  // moves.
  const requestedTab = parseWalletTab(searchParams?.tab);
  const tab = requestedTab ?? defaultWalletTab(target.kind === 'lite' ? 'lite' : 'full');
  const seed = tab === 'hive' && target.kind === 'hive' ? target.seed : null;

  return (
    <WalletSummaryProvider value={seed}>
      <PublicWalletShell username={name} target={target.kind} initialTab={tab} />
    </WalletSummaryProvider>
  );
}
