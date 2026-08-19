'use client';

import PageMasthead from '@/blog/features/layouts/page-masthead';
import { FC, ReactNode, useMemo, useState } from 'react';
import { Link, LumenLoader } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import { useLiveDiscovery } from '../../live/use-live-discovery';
import { displayHandle, usdFromHbd } from '../../live/adapt';
import type { CreatorSummary } from '../../types';
import { usdCompact, usdPrice, usdWhole } from '../../market/format';
import TokenShell from '../token-shell';

// TODO i18n — staged copy; move to locales/*/common_blog.json once final.
const COPY = {
  title: 'Discover creators',
  sub: 'People who offer their time and expertise. Hold their token, spend it on their work: a question, a review, a day of building. Ranked by how reliably they deliver.',
  answers: 'Answers',
  newHere: 'New here',
  newHereSub: 'Just launched, so not ranked by reliability yet.',
  newNothing: 'New, nothing completed yet.',
  recordUnavailable: 'Delivery record unavailable',
  launchTitle: 'Launch your Meritum',
  launchSub: 'Let people hold your token and pay you for your time.',
  launchCta: 'Set up in Creator Studio →',
  howTitle: 'How it works',
  how1: 'Hold a creator’s token.',
  how2: 'Spend it on a question or session.',
  /**
   * ★ D-4, the wording pass the list asked for. The old line opened with "The token
   * can appreciate", which is a forward-looking statement about price and the first
   * thing a regulator, or a disappointed holder, would quote back. It also called the
   * reserve figure a "floor", a word that promises a level the holder cannot actually
   * sell at, then took the promise back in the same sentence.
   *
   * What is left describes only what the contract does. No projection, no floor, and
   * the illiquidity said plainly rather than as an aside after a dash.
   */
  how3: 'A token is redeemable against the creator’s reserve, and the redemption value moves with it. It is not a price you can sell at on demand, and it is not an investment return.'
};

type Sort = 'reliable' | 'fastest' | 'new';
const SORTS: { id: Sort; label: string }[] = [
  { id: 'reliable', label: 'Most reliable' },
  { id: 'fastest', label: 'Fastest' },
  { id: 'new', label: 'New' }
];

const DeliveryStrip: FC<{ marks: boolean[] }> = ({ marks }) => (
  <div className="mb-2.5 flex gap-1">
    {marks.map((answered, i) => (
      <span
        key={i}
        className={`h-3.5 w-3.5 rounded ${answered ? 'bg-surface-ok-7' : 'border-2 border-line-20 bg-surface-1'}`}
      />
    ))}
  </div>
);

/** Blocks -> a human response label. Median, straight from the view. */
function responseLabel(blocks: number | null): string {
  if (blocks === null) return '';
  const hours = (blocks * 3) / 3600;
  if (hours < 1) return `~${Math.max(1, Math.round(hours * 60))} minutes`;
  if (hours < 48) return `~${Math.round(hours)} hours`;
  return `~${Math.round(hours / 24)} days`;
}

/** Decoration derived from the handle — not identity, and not implied to be theirs. */
function avatarFill(handle: string): string {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) % 360;
  return `linear-gradient(135deg,hsl(${h} 42% 42%),hsl(${(h + 40) % 360} 38% 48%))`;
}

const CreatorCard: FC<{ c: CreatorSummary }> = ({ c }) => {
  // The view gives COUNTS, not an ordered pass/fail history, so the strip is
  // drawn from the totals and is NOT a chronology. Do not label it one.
  const marks = [...Array(Math.min(c.answeredCount, 14)).fill(true), ...Array(Math.min(c.missedCount, 4)).fill(false)] as boolean[];
  return (
    <Link
      href={`/creators/${displayHandle(c.creator)}`}
      className="block rounded-panel border border-line-9 bg-surface-1 p-5 shadow-[0_1px_2px_rgba(20,18,10,0.03)] transition-colors hover:bg-surface-12"
    >
      <div className="mb-3.5 flex items-center gap-3">
        <span className="h-[46px] w-[46px] flex-shrink-0 rounded-card" style={{ background: avatarFill(c.creator) }} />
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-bold text-ink-2">@{displayHandle(c.creator)}</div>
          {/* No bio: not contract state, not indexed, and inventing one under
              someone's name reads as their words. */}
        </div>
      </div>

      {c.completionPct !== null ? (
        <div>
          <DeliveryStrip marks={marks} />
          <div className="text-caption tabular-nums text-ink-7">
            {c.completionPct}% completion rate · {c.answeredCount} of {c.answeredCount + c.missedCount}
            {c.medianResponseBlocks !== null ? ` · usually within ${responseLabel(c.medianResponseBlocks)}` : ''}
          </div>
          {c.avgRating !== null ? (
            <div className="mt-1 text-caption tabular-nums text-ink-10">
              Rated {c.avgRating}/5 by {c.ratingCount} buyer{c.ratingCount === 1 ? '' : 's'}
            </div>
          ) : null}
        </div>
      ) : (
        // No record YET — this creator simply has not been hired. Deliberately
        // not dressed up as a positive, and it is why they sort last.
        <div className="rounded-control border border-dashed border-line-11 px-3.5 py-3 text-caption text-ink-14">
          {COPY.recordUnavailable}
        </div>
      )}

      <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-line-2 pt-3.5">
        <span className="text-caption tabular-nums text-ink-10">From {usdWhole(usdFromHbd(c.faceHbd))} per task</span>
        <span className="text-caption tabular-nums text-ink-14">
          Token {usdPrice(usdFromHbd(c.priceHbd))} · cap {usdCompact(usdFromHbd(c.marketCapHbd))}
        </span>
      </div>
    </Link>
  );
};

interface CreatorsViewProps {
  /**
   * Rendered inside the shell's centre column, ABOVE the masthead and the list.
   * `app/creators/page.tsx` passes the Meritum intro here; the prop is optional
   * so the view still renders standalone (and so a second entry point cannot be
   * forced to carry the intro).
   *
   * It arrives as a node rather than being imported here on purpose: this view
   * is the discovery list, and it should not grow a hard dependency on a
   * marketing card that a different screen may want to omit.
   */
  intro?: ReactNode;
}

const CreatorsView: FC<CreatorsViewProps> = ({ intro }) => {
  const { t } = useTranslation('common_blog');
  const [sort, setSort] = useState<Sort>('reliable');
  const [showNew, setShowNew] = useState(true);
  const [answersOnly, setAnswersOnly] = useState(false);
  const discovery = useLiveDiscovery();

  const creators = useMemo(() => {
    // The INDEXER already ordered this (lumen_ct_discovery, ranked on delivery
    // in SQL), and the default view preserves that order verbatim — re-sorting
    // it here by default would move the product's ranking rule into a
    // comparator anyone could edit.
    //
    // The two alternate sorts are re-orderings of the SAME delivery data, never
    // of price or market cap. There is deliberately no "top gainers".
    const list = [...discovery.creators];
    const proven = (c: CreatorSummary) => Number(c.completionPct !== null);
    if (sort === 'fastest') {
      // Missing still sorts last: unproven is not fast.
      list.sort((a, b) => proven(b) - proven(a) || (a.medianResponseBlocks ?? Infinity) - (b.medianResponseBlocks ?? Infinity));
    } else if (sort === 'new') {
      list.sort((a, b) => Number(b.isNew) - Number(a.isNew));
    }
    return answersOnly ? list.filter((c) => c.completionPct !== null) : list;
  }, [sort, discovery.creators, answersOnly]);

  const newCreators = useMemo(() => discovery.creators.filter((c) => c.isNew), [discovery.creators]);

  const rightRail = (
    <div className="flex flex-col gap-5 pt-[26px]">
      <div className="rounded-panel border border-line-9 bg-surface-1 p-5 shadow-[0_1px_2px_rgba(20,18,10,0.03)]">
        <div className="mb-1.5 font-serif text-lg font-semibold text-ink-2">{COPY.launchTitle}</div>
        <p className="mb-4 font-serif text-[14px] leading-[22px] text-ink-10">{COPY.launchSub}</p>
        <Link
          href="/creators/studio"
          className="block rounded-control bg-surface-brand-12 py-3 text-center text-sm font-semibold text-ink-27 hover:bg-surface-brand-16"
        >
          {COPY.launchCta}
        </Link>
      </div>
      <div className="rounded-panel border border-line-9 bg-surface-1 p-5">
        <div className="mb-3.5 text-[15px] leading-[24px] font-bold text-ink-2">{COPY.howTitle}</div>
        <div className="flex flex-col gap-3.5">
          {[COPY.how1, COPY.how2, COPY.how3].map((line, i) => (
            <div key={i} className="flex gap-3">
              <span className="font-serif font-bold text-ink-brand-6">{i + 1}</span>
              <span className="text-caption text-ink-7">{line}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <TokenShell rightRail={rightRail}>
      {/* `mb-7` is the masthead's own bottom margin, applied HERE rather than
          inside the intro so the intro stays a card and not a page section —
          the two blocks sit the same distance apart as every other pair on the
          page. */}
      {intro ? <div className="mb-7">{intro}</div> : null}

      {/* X-1 / P0-3: /creators was a fourth page-header treatment, bare text with no
          shell. Same masthead as home, topics, witnesses and proposals now. No mark:
          /creators has no assigned glyph and R5 forbids inventing one. */}
      {/*
        When the Meritum intro is present it carries the page's h1, so this
        masthead steps down to h2 — otherwise the page ships two h1s and the
        document outline screen readers navigate by is broken. With no intro
        (any other caller) it stays the h1 it has always been.
      */}
      <PageMasthead title={COPY.title} headingLevel={intro ? 'h2' : 'h1'}>
        <p className="max-w-[660px] text-caption text-ink-10">{COPY.sub}</p>
      </PageMasthead>

      <div className="my-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex gap-1.5 rounded-xl border border-line-6 bg-surface-21 p-[5px]">
          {SORTS.map((s) => {
            const on = sort === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setSort(s.id)}
                aria-pressed={on}
                className={`rounded-lg px-[15px] py-2 text-[14px] leading-[22px] font-semibold ${
                  on ? 'bg-surface-1 text-ink-2 shadow-[0_1px_2px_rgba(20,18,10,0.08)]' : 'text-ink-10'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
        <button
          onClick={() => setAnswersOnly((v) => !v)}
          className={`rounded-full border px-[15px] py-2 text-caption font-semibold ${answersOnly ? 'border-line-brand-10 bg-surface-brand-6 text-ink-brand-6' : 'border-line-11 bg-surface-1 text-ink-10 hover:border-line-brand-10'}`}
        >
          {COPY.answers}
        </button>
      </div>

      {showNew && newCreators.length > 0 ? (
        <div className="mb-[22px] rounded-2xl border border-line-9 bg-surface-12 px-5 py-[18px]">
          <div className="mb-3.5 flex items-center justify-between">
            <div>
              <div className="text-[15px] leading-[24px] font-bold text-ink-2">{COPY.newHere}</div>
              <div className="text-caption text-ink-14">{COPY.newHereSub}</div>
            </div>
            {/* ★ min-h/min-w-[24px] FOR THE HIT TARGET (2026-08-19, WCAG 2.2 AA
                2.5.8). Glyph-only, `leading-none`, no padding: 10.6x20.
                Measured live: the header row and the card itself were both
                unchanged (44px / 232px before and after) — the row's height
                comes from the "New Here" title block beside it. */}
            <button
              onClick={() => setShowNew(false)}
              className="flex min-h-[24px] min-w-[24px] cursor-pointer items-center justify-center text-xl leading-none text-ink-14"
            >
              ×
            </button>
          </div>
          <div className="flex gap-3.5 overflow-x-auto pb-1">
            {newCreators.map((c) => (
              <Link
                key={c.creator}
                href={`/creators/${displayHandle(c.creator)}`}
                className="block min-w-[240px] rounded-2xl border border-line-9 bg-surface-1 p-4 transition-colors hover:border-line-17"
              >
                <div className="mb-3 flex items-center gap-3">
                  <span className="h-10 w-10 rounded-control" style={{ background: avatarFill(c.creator) }} />
                  <div>
                    <div className="text-[15px] leading-[24px] font-bold text-ink-2">@{displayHandle(c.creator)}</div>
                  </div>
                </div>
                <div className="text-caption font-semibold text-ink-warn-3">{COPY.newNothing}</div>
                <div className="mt-1.5 text-caption tabular-nums text-ink-10">From {usdWhole(usdFromHbd(c.faceHbd))} per task</div>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {discovery.unavailable ? (
        <div className="rounded-card border border-dashed border-line-11 px-5 py-8 text-center text-[14px] leading-[22px] text-ink-14">
          Meritum isn’t available on this build yet.
        </div>
      ) : discovery.isLoading ? (
        <LumenLoader size="md" label={t('global.loading_creators')} />
      ) : discovery.failed ? (
        // NOT "no creators" — this page must never render a failed lookup as an
        // empty market. It is the same unavailable-vs-empty rule the wallet and
        // delivery reads follow.
        <div className="rounded-card border border-dashed border-line-11 px-5 py-8 text-center text-[14px] leading-[22px] text-ink-14">
          We can’t load the creator list right now. The index that ranks creators by their delivery record is
          unreachable. If you already know a creator, their token page still works: /creators/their-name.
        </div>
      ) : creators.length === 0 ? (
        /*
         * ★★★ AN EMPTY INDEX IS NOT AN EMPTY MARKET (2026-08-17).
         *
         * This said "No creators have launched a token yet." while
         * `magi.contracts` was live on chain — ACTIVE, 8 of 100,000 tokens
         * issued, reachable at /creators/magi.contracts. The lookup did not
         * fail, so the `failed` branch above never fired: the indexer answered
         * 200 with `{"data":{"lumen_ct_discovery":[]}}`. The view simply was
         * never populated.
         *
         * So zero rows carries strictly less information than it appears to. It
         * means "the index lists nobody", which is the same answer whether
         * nobody has launched or nobody has been INDEXED — and this page cannot
         * tell those apart, because the ranking it exists to show only exists in
         * that index. Asserting the first reading is how the platform's only
         * real market became invisible in the product's own browse surface.
         *
         * Same rule as the delivery record and the wallet reads: a screen may
         * report what it knows, never a fact it merely inferred from an absence.
         * The escape hatch from the `failed` branch is repeated here because it
         * is exactly as useful — a direct handle still resolves.
         */
        <div className="rounded-card border border-dashed border-line-11 px-5 py-8 text-center text-[14px] leading-[22px] text-ink-14">
          No creators to list yet. The index that ranks creators by their delivery record has nothing in it — that may
          mean nobody has launched, or simply that no one has been indexed. If you already know a creator, their token
          page still works: /creators/their-name.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {creators.map((c) => (
            <CreatorCard key={c.creator} c={c} />
          ))}
        </div>
      )}
    </TokenShell>
  );
};

export default CreatorsView;
