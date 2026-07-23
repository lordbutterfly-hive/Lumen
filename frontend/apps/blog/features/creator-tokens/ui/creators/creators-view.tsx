'use client';

import { FC, useMemo, useState } from 'react';
import { Link } from '@hive/ui';
import type { CreatorTokenSummary } from '../../market/types';
import { MOCK_CREATORS, MOCK_NEW_CREATORS } from '../../market/mock';
import { usdCompact, usdPrice, usdWhole } from '../../market/format';
import TokenShell from '../token-shell';

// TODO i18n — staged copy; move to locales/*/common_blog.json once final.
const COPY = {
  title: 'Discover creators',
  sub: 'People who offer their time and expertise. Hold their token, spend it on their work — a question, a review, a day of building. Ranked by how reliably they deliver.',
  answers: 'Answers',
  newHere: 'New here',
  newHereSub: 'Just launched — not ranked by reliability yet.',
  newNothing: 'New — nothing completed yet.',
  recordUnavailable: 'Delivery record unavailable',
  launchTitle: 'Launch your creator token',
  launchSub: 'Let people hold your token and pay you for your time.',
  launchCta: 'Set up in Creator Studio →',
  howTitle: 'How it works',
  how1: 'Hold a creator’s token.',
  how2: 'Spend it on a question or session.',
  how3: 'The token can appreciate; the floor is your downside.'
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

const CreatorCard: FC<{ c: CreatorTokenSummary }> = ({ c }) => (
  <Link
    href={`/creators/${c.handle}`}
    className="block rounded-[18px] border border-[#ebebeb] bg-white p-5 shadow-[0_1px_2px_rgba(20,18,10,0.03)] transition-colors hover:bg-[#faf9f6]"
  >
    <div className="mb-3.5 flex items-center gap-3">
      <span className="h-[46px] w-[46px] flex-shrink-0 rounded-[13px]" style={{ background: c.avatarColor }} />
      <div className="min-w-0 flex-1">
        <div className="text-[15.5px] font-bold text-[#161511]">@{c.handle}</div>
        <div className="font-serif text-[13px] text-[#4b5563]">{c.what}</div>
      </div>
    </div>

    {c.delivery.available ? (
      <div>
        <DeliveryStrip marks={c.delivery.marks} />
        <div className="text-[13px] tabular-nums text-[#3f4650]">
          {c.delivery.completionPct}% completion rate · {c.delivery.answered} of {c.delivery.total} · usually within{' '}
          {c.delivery.typicalResponse}
        </div>
      </div>
    ) : (
      <div className="rounded-[11px] border border-dashed border-[#e4e6e9] px-3.5 py-3 text-[13px] text-[#9ca3af]">
        {COPY.recordUnavailable}
      </div>
    )}

    <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-[#f1f3f5] pt-3.5">
      <span className="text-[12.5px] tabular-nums text-[#6b7280]">From {usdWhole(c.fromPriceUsd)} per task</span>
      <span className="text-[11.5px] tabular-nums text-[#9ca3af]">
        Token {usdPrice(c.priceUsd)} · cap {usdCompact(c.marketCapUsd)}
      </span>
    </div>
  </Link>
);

const CreatorsView: FC = () => {
  const [sort, setSort] = useState<Sort>('reliable');
  const [showNew, setShowNew] = useState(true);

  const creators = useMemo(() => {
    const list = [...MOCK_CREATORS];
    // Reliability is the ONLY ranking metric — never price/cap/volume. Missing
    // record sorts last (missing ≠ perfect), never rank-boosted.
    if (sort === 'reliable') {
      list.sort((a, b) => Number(b.delivery.available) - Number(a.delivery.available) || b.delivery.completionPct - a.delivery.completionPct);
    }
    return list;
  }, [sort]);

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
      <h1 className="font-serif text-[32px] font-semibold tracking-[-0.015em] text-[#161511]">{COPY.title}</h1>
      <p className="mt-2 max-w-[660px] text-[14.5px] leading-[1.55] text-[#6b7280]">{COPY.sub}</p>

      <div className="my-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex gap-1.5 rounded-xl border border-[#ebedf0] bg-[#f4f5f7] p-[5px]">
          {SORTS.map((s) => {
            const on = sort === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setSort(s.id)}
                className={`rounded-lg px-[15px] py-2 text-[13.5px] font-semibold ${
                  on ? 'bg-white text-[#161511] shadow-[0_1px_2px_rgba(20,18,10,0.08)]' : 'text-[#6b7280]'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
        <span className="rounded-full border border-[#c0392b] bg-[#fbeeec] px-[15px] py-2 text-[13px] font-semibold text-[#c0392b]">
          {COPY.answers}
        </span>
      </div>

      {showNew ? (
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
            {MOCK_NEW_CREATORS.map((c) => (
              <Link
                key={c.handle}
                href={`/creators/${c.handle}`}
                className="block min-w-[240px] rounded-2xl border border-[#ebebeb] bg-white p-4 transition-colors hover:border-[#e0ddd6]"
              >
                <div className="mb-3 flex items-center gap-3">
                  <span className="h-10 w-10 rounded-[11px]" style={{ background: c.avatarColor }} />
                  <div>
                    <div className="text-[14.5px] font-bold text-[#161511]">@{c.handle}</div>
                    <div className="text-xs text-[#9ca3af]">{c.what}</div>
                  </div>
                </div>
                <div className="text-[12.5px] font-semibold text-[#b45309]">{COPY.newNothing}</div>
                <div className="mt-1.5 text-[12.5px] tabular-nums text-[#6b7280]">From {usdWhole(c.fromPriceUsd)} per task</div>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {creators.map((c) => (
          <CreatorCard key={c.handle} c={c} />
        ))}
      </div>
    </TokenShell>
  );
};

export default CreatorsView;
