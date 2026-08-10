'use client';

import PageMasthead from '@/blog/features/layouts/page-masthead';
import { FC, useMemo, useState } from 'react';
import { Link } from '@hive/ui';
import { useLiveDiscovery } from '../../live/use-live-discovery';
import { usdFromHbd } from '../../live/adapt';
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
  launchTitle: 'Launch your creator token',
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
        className={`h-3.5 w-3.5 rounded ${answered ? 'bg-[#2f7d4f]' : 'border-[1.5px] border-[#d5d8dd] bg-white'}`}
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
      href={`/creators/${c.creator}`}
      className="block rounded-[18px] border border-[#ebebeb] bg-white p-5 shadow-[0_1px_2px_rgba(20,18,10,0.03)] transition-colors hover:bg-[#faf9f6]"
    >
      <div className="mb-3.5 flex items-center gap-3">
        <span className="h-[46px] w-[46px] flex-shrink-0 rounded-[13px]" style={{ background: avatarFill(c.creator) }} />
        <div className="min-w-0 flex-1">
          <div className="text-[15.5px] font-bold text-[#161511]">@{c.creator}</div>
          {/* No bio: not contract state, not indexed, and inventing one under
              someone's name reads as their words. */}
        </div>
      </div>

      {c.completionPct !== null ? (
        <div>
          <DeliveryStrip marks={marks} />
          <div className="text-[13px] tabular-nums text-[#3f4650]">
            {c.completionPct}% completion rate · {c.answeredCount} of {c.answeredCount + c.missedCount}
            {c.medianResponseBlocks !== null ? ` · usually within ${responseLabel(c.medianResponseBlocks)}` : ''}
          </div>
          {c.avgRating !== null ? (
            <div className="mt-1 text-[12.5px] tabular-nums text-[#6b7280]">
              Rated {c.avgRating}/5 by {c.ratingCount} buyer{c.ratingCount === 1 ? '' : 's'}
            </div>
          ) : null}
        </div>
      ) : (
        // No record YET — this creator simply has not been hired. Deliberately
        // not dressed up as a positive, and it is why they sort last.
        <div className="rounded-[11px] border border-dashed border-[#e4e6e9] px-3.5 py-3 text-[13px] text-[#9ca3af]">
          {COPY.recordUnavailable}
        </div>
      )}

      <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-[#f1f3f5] pt-3.5">
        <span className="text-[12.5px] tabular-nums text-[#6b7280]">From {usdWhole(usdFromHbd(c.faceHbd))} per task</span>
        <span className="text-[11.5px] tabular-nums text-[#9ca3af]">
          Token {usdPrice(usdFromHbd(c.priceHbd))} · cap {usdCompact(usdFromHbd(c.marketCapHbd))}
        </span>
      </div>
    </Link>
  );
};

const CreatorsView: FC = () => {
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
      <div className="rounded-[18px] border border-[#ebebeb] bg-white p-5 shadow-[0_1px_2px_rgba(20,18,10,0.03)]">
        <div className="mb-1.5 font-serif text-lg font-semibold text-[#161511]">{COPY.launchTitle}</div>
        <p className="mb-4 font-serif text-[13.5px] leading-[1.5] text-[#6b7280]">{COPY.launchSub}</p>
        <Link
          href="/creators/studio"
          className="block rounded-[11px] bg-[#c0392b] py-3 text-center text-sm font-semibold text-white hover:bg-[#a5301f]"
        >
          {COPY.launchCta}
        </Link>
      </div>
      <div className="rounded-[18px] border border-[#ebebeb] bg-white p-5">
        <div className="mb-3.5 text-[14.5px] font-bold text-[#161511]">{COPY.howTitle}</div>
        <div className="flex flex-col gap-3.5">
          {[COPY.how1, COPY.how2, COPY.how3].map((line, i) => (
            <div key={i} className="flex gap-3">
              <span className="font-serif font-bold text-[#c0392b]">{i + 1}</span>
              <span className="text-[13px] leading-[1.5] text-[#3f4650]">{line}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <TokenShell rightRail={rightRail}>
      {/* X-1 / P0-3: /creators was a fourth page-header treatment, bare text with no
          shell. Same masthead as home, topics, witnesses and proposals now. No mark:
          /creators has no assigned glyph and R5 forbids inventing one. */}
      <PageMasthead title={COPY.title}>
        <p className="max-w-[660px] text-[13px] leading-[1.55] text-[#6b7280]">{COPY.sub}</p>
      </PageMasthead>

      <div className="my-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex gap-1.5 rounded-xl border border-[#ebedf0] bg-[#f4f5f7] p-[5px]">
          {SORTS.map((s) => {
            const on = sort === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setSort(s.id)}
                aria-pressed={on}
                className={`rounded-lg px-[15px] py-2 text-[13.5px] font-semibold ${
                  on ? 'bg-white text-[#161511] shadow-[0_1px_2px_rgba(20,18,10,0.08)]' : 'text-[#6b7280]'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
        <button
          onClick={() => setAnswersOnly((v) => !v)}
          className={`rounded-full border px-[15px] py-2 text-[13px] font-semibold ${answersOnly ? 'border-[#c0392b] bg-[#fbeeec] text-[#c0392b]' : 'border-[#e4e6e9] bg-white text-[#6b7280] hover:border-[#c0392b]'}`}
        >
          {COPY.answers}
        </button>
      </div>

      {showNew && newCreators.length > 0 ? (
        <div className="mb-[22px] rounded-2xl border border-[#ebebeb] bg-[#faf9f6] px-5 py-[18px]">
          <div className="mb-3.5 flex items-center justify-between">
            <div>
              <div className="text-[15px] font-bold text-[#161511]">{COPY.newHere}</div>
              <div className="text-[12.5px] text-[#9ca3af]">{COPY.newHereSub}</div>
            </div>
            <button onClick={() => setShowNew(false)} className="cursor-pointer text-xl leading-none text-[#9ca3af]">
              ×
            </button>
          </div>
          <div className="flex gap-3.5 overflow-x-auto pb-1">
            {newCreators.map((c) => (
              <Link
                key={c.creator}
                href={`/creators/${c.creator}`}
                className="block min-w-[240px] rounded-2xl border border-[#ebebeb] bg-white p-4 transition-colors hover:border-[#e0ddd6]"
              >
                <div className="mb-3 flex items-center gap-3">
                  <span className="h-10 w-10 rounded-[11px]" style={{ background: avatarFill(c.creator) }} />
                  <div>
                    <div className="text-[14.5px] font-bold text-[#161511]">@{c.creator}</div>
                  </div>
                </div>
                <div className="text-[12.5px] font-semibold text-[#b45309]">{COPY.newNothing}</div>
                <div className="mt-1.5 text-[12.5px] tabular-nums text-[#6b7280]">From {usdWhole(usdFromHbd(c.faceHbd))} per task</div>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {discovery.unavailable ? (
        <div className="rounded-[14px] border border-dashed border-[#e4e6e9] px-5 py-8 text-center text-[13.5px] leading-[1.6] text-[#9ca3af]">
          Creator tokens aren’t available on this build yet.
        </div>
      ) : discovery.isLoading ? (
        <div className="rounded-[14px] border border-dashed border-[#e4e6e9] px-5 py-8 text-center text-[13.5px] text-[#9ca3af]">Loading creators…</div>
      ) : discovery.failed ? (
        // NOT "no creators" — this page must never render a failed lookup as an
        // empty market. It is the same unavailable-vs-empty rule the wallet and
        // delivery reads follow.
        <div className="rounded-[14px] border border-dashed border-[#e4e6e9] px-5 py-8 text-center text-[13.5px] leading-[1.6] text-[#9ca3af]">
          We can’t load the creator list right now. The index that ranks creators by their delivery record is
          unreachable. If you already know a creator, their token page still works: /creators/their-name.
        </div>
      ) : creators.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-[#e4e6e9] px-5 py-8 text-center text-[13.5px] text-[#9ca3af]">
          No creators have launched a token yet.
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
