'use client';

import { useQuery } from '@tanstack/react-query';
import { Link } from '@hive/ui';
import { getPost } from '@transaction/lib/bridge-api';
import { useLiteOverlay } from '@/blog/lib/lite/client/use-lite-overlay';
import { MiniPostCard } from './mini-post-card';

/**
 * On a reblog comment's own page (quote reblog spec v2 3.4): the post it is about, as
 * the small card, linking to it. The post is named in the comment's own metadata
 * (`quote_of`); a comment without it (edited elsewhere) simply shows no card.
 */
export function QuoteTargetCard({ metadata, observer }: { metadata: unknown; observer: string }) {
  const of = quoteOf(metadata);
  const { data: entry } = useQuery({
    queryKey: ['quote-target', of?.author ?? '', of?.permlink ?? '', observer],
    enabled: !!of,
    staleTime: 60_000,
    queryFn: () => (of ? getPost(of.author, of.permlink, observer) : Promise.resolve(null))
  });
  const overlay = useLiteOverlay(entry ?? null);
  if (!of || !entry) return null;
  const displayAuthor = overlay?.author ?? entry.author;
  return (
    <Link href={`/${entry.category}/@${displayAuthor}/${entry.permlink}`} className="mt-4 block" data-testid="quote-target-card">
      <MiniPostCard entry={entry} title={overlay?.title || entry.title} displayAuthor={displayAuthor} />
    </Link>
  );
}

function quoteOf(metadata: unknown): { author: string; permlink: string } | null {
  let meta: unknown = metadata;
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      return null;
    }
  }
  const of = (meta as { quote_of?: { author?: unknown; permlink?: unknown } } | null)?.quote_of;
  return typeof of?.author === 'string' && typeof of?.permlink === 'string' ? { author: of.author, permlink: of.permlink } : null;
}
