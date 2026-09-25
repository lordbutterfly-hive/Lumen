'use client';

import { FC, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import PageShell from '@/blog/features/layouts/page-shell';
import PageMasthead from '@/blog/features/layouts/page-masthead';
import { useDmUnread } from '../live/use-direct-messages';
import DmInboxPanel from './dm-inbox-panel';

// The asks list carries the wallet's Meritum code; it loads when the tab is opened, not
// with every inbox visit.
const InboxAsks = dynamic(() => import('./inbox-asks'), { ssr: false });

export type InboxView = 'messages' | 'asks';

// TODO i18n - staged copy.
const COPY = {
  title: 'Inbox',
  intro: {
    messages: "Private messages with anyone on Lumen. They are encrypted on your device, so Lumen can't read them.",
    asks: 'Your requests to creators: what you asked, whether they answered, and anything left for you to do.'
  },
  tabs: [
    ['messages', 'Messages'],
    ['asks', 'Asks']
  ] as const
};

/**
 * The /inbox page: the same inbox creators have in the Studio (`DmInboxPanel`), in the
 * account-page frame /settings uses (no feed rail).
 *
 * ★ TWO TABS, NEVER MERGED (owner, 2026-09-25: "The asks should show up in the inbox as
 * well ... separate it from other normal messages"). Messages are free and private; an ask
 * carries tokens and a deadline. The toggle is the Studio Inbox's own Requests/Messages
 * toggle, drawn the same way, and `?view=asks` (the bell's Meritum rows, the "Request
 * placed" receipt) opens on Asks.
 *
 * Messages are marked read only while the Messages tab is showing, exactly as the Studio
 * does, so a message that arrives while the reader is on Asks keeps its badge. The count
 * is a dependency so one arriving while Messages is open clears as well.
 */
const InboxPage: FC<{ to: string | null; view: InboxView }> = ({ to, view: initialView }) => {
  const [view, setView] = useState<InboxView>(initialView);
  const { count, markRead } = useDmUnread();
  useEffect(() => {
    if (view === 'messages' && count > 0) void markRead();
  }, [view, count, markRead]);

  const choose = (next: InboxView) => {
    setView(next);
    // Keep the address honest so a reload or a shared link lands on the same tab.
    try {
      const url = new URL(window.location.href);
      if (next === 'asks') url.searchParams.set('view', 'asks');
      else url.searchParams.delete('view');
      window.history.replaceState(window.history.state, '', url.pathname + url.search);
    } catch {
      /* the tab still switches */
    }
  };

  return (
    <PageShell rightRail={null}>
      <PageMasthead title={COPY.title}>
        <p className="max-w-[620px] font-ui text-caption text-ink-10">{COPY.intro[view]}</p>
      </PageMasthead>
      <div className="mb-4 inline-flex gap-1.5 rounded-card border border-line-6 bg-[var(--amb-1)] p-[5px] dark:bg-surface-23">
        {COPY.tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => choose(id)}
            aria-pressed={view === id}
            style={view === id ? { boxShadow: 'var(--tab-active-glow)' } : undefined}
            className={`rounded-control px-4 py-1.5 font-ui text-[14px] leading-[22px] font-medium transition-colors ${
              view === id ? 'bg-[var(--lum-1)] text-ink-2 dark:bg-surface-1' : 'text-ink-10 hover:text-ink-2'
            }`}
            data-testid={`inbox-tab-${id}`}
          >
            {label}
            {id === 'messages' && count > 0 ? (
              <span className="ml-1.5 rounded-full bg-surface-brand-12 px-1.5 text-caption tabular-nums text-ink-27 font-num">
                {count}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {view === 'asks' ? <InboxAsks /> : <DmInboxPanel to={to} />}
    </PageShell>
  );
};

export default InboxPage;
