'use client';

import { FC, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@hive/ui';
import { UserAvatarImg } from '@ui/components';
import TimeAgo from '@ui/components/time-ago';
import { cn } from '@ui/lib/utils';
import { StaleTime } from '@/blog/lib/react-query';
import { useTranslation } from '@/blog/i18n/client';
import type { BuilderRow } from '@/blog/lib/builders-board-shape';

/**
 * ★★★ THE BUILDERS BOARD — the right-rail card on HOME and TOPICS showing what
 * the people building on Hive are publishing (owner, 2026-09-15).
 *
 * Deliberately the same object as the Meritum departures board
 * (`creator-tokens/ui/meritum/board/offerings-board.tsx`): one row per person,
 * each row holding ONE of their recent posts and flipping to the next on a
 * staggered timer, the way an airport board cycles a flight. The three rules
 * that board learned the hard way apply here unchanged:
 *
 *  1. IT LIVES ONLY WHERE IT WAS ASKED FOR. `RightRail` renders this only when
 *     handed `builders`, and exactly three call sites pass it: `home-shell`,
 *     `topic-shell` and the topics `loading.tsx`. Every other shell that mounts
 *     `<RightRail />` — post pages, profiles, wallet, witnesses, proposals,
 *     Meritum — never sees it. The gate is a prop, not a route test, so it
 *     cannot drift onto a page nobody meant it to reach.
 *
 *  2. IT NEVER ROTATES UNDER A READER'S EYES. Paused on hover and while the tab
 *     is hidden; `paused` is a single derived flag so a row cannot be flipping
 *     while the pointer is on it.
 *
 *  3. THE TITLE WRAPS, THE NAME AND THE TIME DO NOT. A post title is the whole
 *     reason the row exists and is arbitrary length; a handle is short; a
 *     relative time is one token. Only the title is allowed to take more than
 *     one line.
 *
 * ★ RENDERS NOTHING ON ERROR OR EMPTY, LIKE THE BOARD. A rail card cannot
 * explain an empty box, and an empty box reads as broken. While loading it
 * paints a short skeleton so the rail does not jump when the rows arrive.
 */

/** How long one post holds its row before the flip. Staggered per row below. */
const DWELL_MS = 5_600;
/** The flip itself — short enough to read as a change, not an animation. */
const FLAP_MS = 260;
/** Rows the card shows, however many builders the route returns. */
const MAX_ROWS = 8;

async function fetchBuildersBoard(): Promise<BuilderRow[]> {
  const res = await fetch('/api/builders-board');
  if (!res.ok) throw new Error(`builders board request failed: HTTP ${res.status}`);
  const body = (await res.json()) as { builders?: BuilderRow[]; degraded?: boolean };
  // A degraded answer is an honest "nothing to show", not data — see the route.
  if (body.degraded) return [];
  return body.builders ?? [];
}

const BuilderRowView: FC<{ row: BuilderRow; index: number; paused: boolean }> = ({ row, index, paused }) => {
  const [slot, setSlot] = useState(0);
  const [flapping, setFlapping] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = row.posts[slot % row.posts.length];

  useEffect(() => {
    // One post never flips, a paused board never flips. Both are the ABSENCE
    // of a timer, so a paused board costs no wakeups at all.
    if (paused || row.posts.length < 2) return;
    // Staggered so rows never flip in unison — that reads as the page
    // re-rendering rather than a board updating.
    const delay = DWELL_MS + index * 460;
    timer.current = setTimeout(() => {
      setFlapping(true);
      setTimeout(() => {
        setSlot((s) => s + 1);
        setFlapping(false);
      }, FLAP_MS);
    }, delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [paused, row.posts.length, index, slot]);

  const postHref = `/${current.category}/@${row.account}/${current.permlink}`;

  return (
    <li className="border-b border-line-2 py-2.5 last:border-0" data-testid="builders-row">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <Link
          href={`/@${row.account}`}
          className="flex min-w-0 flex-1 items-center gap-2 font-ui text-[13px] leading-[20px] font-semibold text-ink-2 hover:text-ink-brand-6"
          title={`@${row.account}`}
        >
          {/* The same avatar component the feed byline uses, at the board's 24px. */}
          <UserAvatarImg username={row.account} pixelSize={24} alt={`@${row.account} profile picture`} />
          <span className="min-w-0 flex-1 truncate">@{row.account}</span>
        </Link>
        {/* One token, never wrapped. */}
        <span className="shrink-0 font-ui text-caption text-ink-14">
          <TimeAgo date={current.created} />
        </span>
      </div>
      <Link
        href={postHref}
        data-testid="builders-post-link"
        className={cn(
          'mt-1 block min-w-0 break-words font-ui text-caption leading-[18px] text-ink-10 transition-all hover:text-ink-brand-6 motion-reduce:transition-none',
          // The flap: the outgoing title lifts and fades, the incoming settles.
          // `motion-reduce` drops it to a plain swap — the change still happens.
          flapping ? '-translate-y-1 opacity-0' : 'translate-y-0 opacity-100'
        )}
        style={{ transitionDuration: `${FLAP_MS}ms` }}
        title={current.title}
      >
        {current.title}
      </Link>
    </li>
  );
};

const Builders = () => {
  const { t } = useTranslation('common_blog');
  const [hovered, setHovered] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    // Animating a board nobody is looking at is pure battery.
    const onVisibility = () => setHidden(document.visibilityState === 'hidden');
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['right-rail-builders-board'],
    queryFn: fetchBuildersBoard,
    staleTime: StaleTime.LONG,
    // Decorative widget: one retry absorbs a blip, more only lengthens the
    // worst case (see the Topics card's note on the same decision).
    retry: 1
  });

  if (isError) return null;
  const rows = (data ?? []).slice(0, MAX_ROWS);
  if (!isLoading && rows.length === 0) return null;

  return (
    <section aria-labelledby="right-rail-builders-heading" data-testid="right-rail-builders">
      <h2 id="right-rail-builders-heading" className="mb-0.5 font-ui text-lg font-medium text-ink-2">
        {t('right_rail.builders.heading')}
      </h2>
      <p className="mb-2 font-ui text-caption text-ink-14">{t('right_rail.builders.blurb')}</p>
      {isLoading ? (
        <ul className="animate-pulse" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="border-b border-line-2 py-2.5 last:border-0">
              <div className="mb-1.5 h-5 w-32 rounded bg-surface-11" />
              <div className="h-4 w-full rounded bg-surface-11" />
            </li>
          ))}
        </ul>
      ) : (
        <ul onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
          {rows.map((row, i) => (
            <BuilderRowView key={row.account} row={row} index={i} paused={hovered || hidden} />
          ))}
        </ul>
      )}
    </section>
  );
};

export default Builders;
