'use client';

import { useQuery } from '@tanstack/react-query';
import { Link, UserAvatarImg } from '@hive/ui';
import TimeAgo from '@ui/components/time-ago';
import { getPostSummary } from '@/blog/lib/utils';
import { Entry } from '@hive/common-hiveio-packages/wax';

/**
 * Lumen-native (lite-account) posts, shown ABOVE the Hive discovery feed on the
 * home page. This is deliberately ISOLATED and additive: it fetches
 * `/api/lite/posts` on its own and renders a minimal card that makes NO Hive
 * queries (lite posts may not be on-chain yet). If lite is disabled, the fetch
 * fails, or there are no posts, it renders nothing — the Hive feed below is never
 * affected. Full MediumPostCard treatment comes once posts are published on-chain
 * under the frontend account (then they appear in the Hive feed natively).
 */

async function fetchLiteFeed(): Promise<Entry[]> {
  try {
    const res = await fetch('/api/lite/posts?limit=10');
    if (!res.ok) return [];
    const body = (await res.json().catch(() => null)) as { entries?: Entry[] } | null;
    return Array.isArray(body?.entries) ? (body?.entries ?? []) : [];
  } catch {
    return [];
  }
}

function LitePostCard({ entry }: { entry: Entry }) {
  const dek = getPostSummary(entry.json_metadata, entry.body);
  const image = typeof entry.json_metadata?.image === 'string' ? entry.json_metadata.image : '';
  // ★ ALWAYS CLICKABLE (2026-08-07). This used to render a pending post as an
  // inert block, on the theory that a not-yet-broadcast post has no destination.
  // It does: `/blog/@<author>/<lite-permlink>` renders the post for ANY viewer —
  // author or stranger, signed in or out — and says honestly "Saved and visible
  // on Lumen. It will appear on Hive shortly." Verified live.
  //
  // So the guard was protecting against a problem that no longer exists, and its
  // cost was severe: the owner opened the app, found a feed of posts that could
  // not be clicked, and reasonably concluded the product was broken. A pending
  // post now links to its own page like any other, and says it is pending.
  const published = !entry.permlink.startsWith('lite-');
  const href = published
    ? `/${entry.category}/@${entry.author}/${entry.permlink}`
    : `/blog/@${entry.author}/${entry.permlink}`;
  const body = (
    <>
      <div className="mb-2 flex items-center gap-2 font-sans text-sm">
        {/* ★ CONVERGED (F6 item 22). This never attempted a real avatar at all —
            always the bare initial, even for a lite account with a real uploaded
            picture (`/api/avatar` resolves those via `liteAvatar()`; see that
            route). Amber tint kept, to match this strip's own "via Lumen" accent. */}
        <UserAvatarImg username={entry.author ?? 'L'} pixelSize={24} className="bg-[#f0ead9] text-[#9a7b2e]" />
        <span className="font-medium text-[#161511]">{entry.author}</span>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">via Lumen</span>
        <span className="text-xs text-muted-foreground">
          · <TimeAgo date={entry.created} />
        </span>
      </div>
      {entry.title ? <h3 className="font-serif text-2xl font-bold leading-snug text-[#161511]">{entry.title}</h3> : null}
      {dek ? <p className="mt-1 line-clamp-3 font-serif text-lg text-[#4b5563]">{dek}</p> : null}
      {image ? <img src={image} alt="" className="mt-3 max-h-44 w-full rounded-lg object-cover" /> : null}
    </>
  );
  return published ? (
    <Link href={href} className="mb-4 block rounded-[18px] border border-[#ebebeb] bg-white p-[22px] shadow-[0_1px_2px_rgba(20,18,10,0.03)] transition-colors hover:bg-[#fdfcfb]">
      {body}
    </Link>
  ) : (
    // Pending: still a real link, with the state said out loud rather than
    // expressed as "nothing happens when you click".
    <Link href={href} className="mb-4 block rounded-[18px] border border-[#ebebeb] bg-white p-[22px] shadow-[0_1px_2px_rgba(20,18,10,0.03)] transition-colors hover:bg-[#fdfcfb]">
      {body}
      <p className="mt-2 text-[12px] text-[#9a7b2e]">Publishing to Hive — visible on Lumen now.</p>
    </Link>
  );
}

export default function LiteFeedStrip() {
  const { data } = useQuery({
    queryKey: ['liteFeedStrip'],
    queryFn: fetchLiteFeed,
    staleTime: 30_000
  });
  if (!data || data.length === 0) return null;
  return (
    <div>
      {data.map((entry) => (
        <LitePostCard key={`${entry.author}-${entry.permlink}`} entry={entry} />
      ))}
    </div>
  );
}
