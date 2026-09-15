'use client';

import { FC, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@hive/ui';
import { UserAvatarImg } from '@ui/components';
import TimeAgo from '@ui/components/time-ago';
import { cn } from '@ui/lib/utils';
import { StaleTime } from '@/blog/lib/react-query';
import { useTranslation } from '@/blog/i18n/client';
import { buildSlotQueues } from '@/blog/lib/builders-board-shape';
import type { BuilderRow, SlotEntry } from '@/blog/lib/builders-board-shape';
import { BUILDERS_CURATOR } from '@/blog/lib/builders-roster';
import { readBuildersHidden, writeBuildersHidden, BUILDERS_HIDDEN_KEY } from '@/blog/lib/builders-card-visibility';

/**
 * ★★★ THE BUILDERS BOARD — the right-rail card on HOME and TOPICS showing what
 * the people building on Hive are publishing (owner, 2026-09-15).
 *
 * Deliberately the same object as the Meritum departures board
 * (`creator-tokens/ui/meritum/board/offerings-board.tsx`): a fixed number of
 * SLOTS, each holding one (builder, post) and flipping to the next on a
 * staggered timer, the way an airport board cycles a flight. The first
 * version pinned one builder per row and flipped only the post; the owner
 * asked for the WRITERS to flip too ("make sure the card flips the writers as
 * well as their posts"), so a slot now cycles through a queue dealt across
 * every builder — see `buildSlotQueues` for how the queues are dealt so no
 * two slots show the same builder at once. The three rules the Meritum board
 * learned the hard way apply here unchanged:
 *
 *  1. IT LIVES ONLY WHERE IT WAS ASKED FOR. `RightRail` renders this only when
 *     handed `builders`, and exactly three call sites pass it: `home-shell`,
 *     `topic-shell` and the topics `loading.tsx`. Every other shell that mounts
 *     `<RightRail />` — post pages, profiles, wallet, witnesses, proposals,
 *     Meritum — never sees it. The gate is a prop, not a route test, so it
 *     cannot drift onto a page nobody meant it to reach.
 *
 *  2. IT NEVER ROTATES UNDER A READER'S EYES. Paused on hover and while the tab
 *     is hidden; `paused` is a single derived flag so a slot cannot be flipping
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
 *
 * ★ THE READER CAN HIDE IT, AND THAT STICKS (owner, 2026-09-15: "add a button
 * to hide this on top right. if someone hides it that persists in their cache
 * so its hidden until they open it"). Hidden = the card collapses to its
 * heading and a "Show" link, and the board is not even fetched. The choice is
 * read from localStorage in a LAYOUT effect after mount, never in the
 * `useState` initializer: the server has no storage, so an initializer that
 * read it would hydrate a collapsed card over expanded HTML and React would
 * throw the mismatch (the rule every cross-page store in this app follows).
 */

/** `useLayoutEffect` on the client (runs before paint, so a hidden card never flashes open), `useEffect` on the server (no layout there, and React warns). */
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/** How long one entry holds its slot before the flip (owner, 2026-09-15: "it flips
 *  once every 30 second per person"). Staggered per slot below so slots never
 *  flip in unison. */
const DWELL_MS = 30_000;
/** The flip itself — short enough to read as a change, not an animation. */
const FLAP_MS = 260;

/**
 * ★ NO IN-CARD SCROLL, AND THE RAIL IT SITS IN IS NOT STICKY (owner,
 * 2026-09-15: "its still weird on scroll. how about you remove the incard
 * scroll and unlock the whole right navbar area so you can scroll down
 * normally and it isnt sticky"). The first version capped the list at the
 * viewport and scrolled it inside a sticky aside, the way the Meritum board
 * does; the owner found the nested scroller weird. So the list is plain, and
 * the two shells that mount this card (`home-shell`, `topic-shell`, plus the
 * topics `loading.tsx`) drop `sticky top-24` from their RIGHT aside: the page
 * scrolls past the rail like any other content. Every other shell keeps its
 * sticky rail; this card is not there.
 */

async function fetchBuildersBoard(): Promise<BuilderRow[]> {
  const res = await fetch('/api/builders-board');
  if (!res.ok) throw new Error(`builders board request failed: HTTP ${res.status}`);
  const body = (await res.json()) as { builders?: BuilderRow[]; degraded?: boolean };
  // A degraded answer is an honest "nothing to show", not data — see the route.
  if (body.degraded) return [];
  return body.builders ?? [];
}

/** One slot of the board: a queue of (builder, post) entries, showing one and flipping through the rest. */
const SlotView: FC<{ queue: SlotEntry[]; index: number; paused: boolean }> = ({ queue, index, paused }) => {
  const [step, setStep] = useState(0);
  const [flapping, setFlapping] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = queue[step % queue.length];

  useEffect(() => {
    // A one-entry queue never flips, a paused board never flips. Both are the
    // ABSENCE of a timer, so a paused board costs no wakeups at all.
    if (paused || queue.length < 2) return;
    // Staggered so slots never flip in unison — that reads as the page
    // re-rendering rather than a board updating. 1.5 s apart: with a 30 s
    // dwell the slots drift through the half-minute instead of ticking together.
    const delay = DWELL_MS + index * 1_500;
    timer.current = setTimeout(() => {
      setFlapping(true);
      setTimeout(() => {
        setStep((s) => s + 1);
        setFlapping(false);
      }, FLAP_MS);
    }, delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [paused, queue.length, index, step]);

  const { account, post } = current;
  const postHref = `/${post.category}/@${account}/${post.permlink}`;

  return (
    <li className="border-b border-line-2 py-2.5 last:border-0" data-testid="builders-row" data-account={account}>
      {/* The whole entry flaps — name, avatar, time and title leave and arrive together, because the writer changes too. */}
      <div
        className={cn(
          'transition-all motion-reduce:transition-none',
          // The flap: the outgoing entry lifts and fades, the incoming settles.
          // `motion-reduce` drops it to a plain swap — the change still happens.
          flapping ? '-translate-y-1 opacity-0' : 'translate-y-0 opacity-100'
        )}
        style={{ transitionDuration: `${FLAP_MS}ms` }}
      >
        <div className="flex min-w-0 items-center justify-between gap-2">
          <Link
            href={`/@${account}`}
            className="flex min-w-0 flex-1 items-center gap-2 font-ui text-[13px] leading-[20px] font-semibold text-ink-2 hover:text-ink-brand-6"
            title={`@${account}`}
          >
            {/* The same avatar component the feed byline uses, at the board's 24px. */}
            <UserAvatarImg username={account} pixelSize={24} alt={`@${account} profile picture`} />
            <span className="min-w-0 flex-1 truncate">@{account}</span>
          </Link>
          {/* One token, never wrapped. */}
          <span className="shrink-0 font-ui text-caption text-ink-14">
            <TimeAgo date={post.created} />
          </span>
        </div>
        <Link
          href={postHref}
          data-testid="builders-post-link"
          className="mt-1 block min-w-0 break-words font-ui text-caption leading-[18px] text-ink-10 hover:text-ink-brand-6"
          title={post.title}
        >
          {post.title}
        </Link>
      </div>
    </li>
  );
};

const Builders = () => {
  const { t } = useTranslation('common_blog');
  const [hovered, setHovered] = useState(false);
  const [tabHidden, setTabHidden] = useState(false);
  // ★ THREE STATES, NOT TWO. `'unknown'` is the server's and the first client
  // render's answer: no storage has been consulted yet. The query is enabled
  // only once the answer is `'shown'`, so a reader who hid the card never
  // pays for the board (measured 2026-09-15: with a boolean that started
  // `false`, the request had already left before the layout effect flipped
  // it — react-query dispatches from the mount effect, and by then the
  // observer was created enabled). While `'unknown'`, the card paints its
  // skeleton, exactly what the server painted, so hydration matches.
  const [pref, setPref] = useState<'unknown' | 'shown' | 'hidden'>('unknown');
  const collapsed = pref === 'hidden';

  useIsomorphicLayoutEffect(() => {
    setPref(readBuildersHidden() ? 'hidden' : 'shown');
  }, []);

  useEffect(() => {
    // Animating a board nobody is looking at is pure battery.
    const onVisibility = () => setTabHidden(document.visibilityState === 'hidden');
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
    retry: 1,
    // A hidden (or not-yet-known) card costs no request; showing it fetches.
    enabled: pref === 'shown',
    // ★ A TAB LEFT OPEN KEEPS UP (owner, 2026-09-15: "if new post comes 1
    // previous post from that author is removed and replaced by new post").
    // The server re-reads the roster every ten minutes; without this, a tab
    // that never lost focus would flip the same posts for hours. Matched to
    // the server TTL so the interval never asks for what it cannot get; off
    // while the tab is hidden, like the flips.
    refetchInterval: 10 * 60_000,
    refetchIntervalInBackground: false
  });

  useEffect(() => {
    // Hidden in one tab, hidden in the next one over: the storage event fires
    // in every OTHER tab of the same origin when the key changes.
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === BUILDERS_HIDDEN_KEY) setPref(readBuildersHidden() ? 'hidden' : 'shown');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setHidden = (next: boolean) => {
    setPref(next ? 'hidden' : 'shown');
    writeBuildersHidden(next);
  };

  // Above the early return: a hook. The queues are dealt once per answer, so a
  // slot's queue keeps its identity across renders and its timer is not reset
  // by the parent re-rendering.
  const queues = useMemo(() => buildSlotQueues(data ?? []), [data]);

  if (collapsed) {
    // The heading and a way back, nothing else: the reader asked for the
    // space. (Rendered even when the board would be empty or failed — the
    // reader must always be able to reopen what they closed.)
    return (
      <section aria-labelledby="right-rail-builders-heading" data-testid="right-rail-builders" data-collapsed="true">
        <div className="flex items-center justify-between gap-2">
          <h2 id="right-rail-builders-heading" className="font-ui text-lg font-medium text-ink-2">
            {t('right_rail.builders.heading')}
          </h2>
          <button
            type="button"
            onClick={() => setHidden(false)}
            className="shrink-0 font-ui text-caption text-ink-14 underline-offset-2 hover:text-ink-brand-6 hover:underline"
            data-testid="builders-show"
          >
            {t('right_rail.builders.show')}
          </button>
        </div>
      </section>
    );
  }

  if (isError) return null;
  if (!isLoading && queues.length === 0) return null;

  return (
    <section aria-labelledby="right-rail-builders-heading" data-testid="right-rail-builders" data-collapsed="false">
      <div className="mb-0.5 flex items-start justify-between gap-2">
        <h2 id="right-rail-builders-heading" className="font-ui text-lg font-medium text-ink-2">
          {t('right_rail.builders.heading')}
        </h2>
        {/* Top right, as asked. An icon button with its name for screen readers and on hover. */}
        <button
          type="button"
          onClick={() => setHidden(true)}
          className="-mr-1 -mt-0.5 shrink-0 rounded p-1 text-ink-14 hover:bg-surface-11 hover:text-ink-2"
          aria-label={t('right_rail.builders.hide')}
          title={t('right_rail.builders.hide')}
          data-testid="builders-hide"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
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
        <ul onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} data-testid="builders-list">
          {queues.map((queue, i) => (
            // Keyed by slot, not by builder: the slot is the stable thing, its occupant changes.
            <SlotView key={i} queue={queue} index={i} paused={hovered || tabHidden} />
          ))}
        </ul>
      )}
      {/* Owner, 2026-09-15: "add small in italic words, request to be added to the list of builders". */}
      <p className="mt-2 font-ui text-caption italic text-ink-14" data-testid="builders-request">
        <Link href={`/@${BUILDERS_CURATOR}`} className="hover:text-ink-brand-6">
          {t('right_rail.builders.request', { curator: BUILDERS_CURATOR })}
        </Link>
      </p>
    </section>
  );
};

export default Builders;
