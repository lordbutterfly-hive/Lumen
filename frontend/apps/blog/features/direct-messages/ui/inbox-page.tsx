'use client';

import { FC, useEffect } from 'react';
import PageShell from '@/blog/features/layouts/page-shell';
import PageMasthead from '@/blog/features/layouts/page-masthead';
import { useDmUnread } from '../live/use-direct-messages';
import DmInboxPanel from './dm-inbox-panel';

// TODO i18n - staged copy.
const COPY = {
  title: 'Inbox',
  intro: "Private messages with anyone on Lumen. They are encrypted on your device, so Lumen can't read them."
};

/**
 * The /inbox page: the same inbox creators have in the Studio (`DmInboxPanel`), in the
 * account-page frame /settings uses (no feed rail). Opening it marks incoming messages
 * read, exactly as the Studio's Messages tab does, so the header badge clears here too;
 * the count is a dependency so a message arriving while the page is open clears as well.
 */
const InboxPage: FC<{ to: string | null }> = ({ to }) => {
  const { count, markRead } = useDmUnread();
  useEffect(() => {
    if (count > 0) void markRead();
  }, [count, markRead]);

  return (
    <PageShell rightRail={null}>
      <PageMasthead title={COPY.title}>
        <p className="max-w-[620px] font-ui text-caption text-ink-10">{COPY.intro}</p>
      </PageMasthead>
      <DmInboxPanel to={to} />
    </PageShell>
  );
};

export default InboxPage;
