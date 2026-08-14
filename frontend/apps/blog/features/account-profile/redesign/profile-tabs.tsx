'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { cn } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import ProfilePostsList from './profile-posts-list';
import ProfileCommentsList from './profile-comments-list';

type TabKey = 'posts' | 'comments';
const TAB_KEYS: readonly TabKey[] = ['posts', 'comments'];
const TAB_PARAM = 'tab';

function toTabKey(raw: string | null): TabKey {
  return raw !== null && (TAB_KEYS as readonly string[]).includes(raw) ? (raw as TabKey) : 'posts';
}

/**
 * Underline Posts/Comments tab control (design-handoff-v2, Profile.dc.html):
 * active tab = red underline. `?tab=` sync mirrors the homepage's FeedTabs so
 * the tab survives back/forward and is linkable.
 *
 * ★ P-3: NEITHER TAB CARRIES A COUNT NOW. "Posts" had a red count chip and
 * "Comments" had nothing beside it, so the pair read as one finished control
 * and one unfinished one. There is no honest number to give Comments — Hive
 * exposes no account-side comment total, and the alternative was to invent one.
 * And the number Posts was showing was not the posts count either: `post_count`
 * on a Hive account is posts AND comments together, so the chip labelled a
 * combined total as one half of itself. The stats bar three rows up already
 * shows that same figure, correctly labelled, so nothing is lost by dropping
 * the chip and the two tabs become symmetric.
 */
export default function ProfileTabs({
  username,
  observer,
  initialPosts,
  lite = false
}: {
  username: string;
  observer: string;
  initialPosts?: Entry[] | null;
  /** True for a Lumen lite account: its posts live in Lumen's own store, not on
   *  Hive under this handle. Decides which source both tabs read from. */
  lite?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [activeTab, setActiveTab] = useState<TabKey>(() => toTabKey(searchParams?.get(TAB_PARAM) ?? null));

  useEffect(() => {
    setActiveTab(toTabKey(searchParams?.get(TAB_PARAM) ?? null));
  }, [searchParams]);

  const selectTab = (tab: TabKey) => {
    setActiveTab(tab);
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    if (tab === 'posts') {
      params.delete(TAB_PARAM);
    } else {
      params.set(TAB_PARAM, tab);
    }
    const query = params.toString();
    const path = pathname ?? '/';
    router.replace(query ? `${path}?${query}` : path, { scroll: false });
  };

  return (
    <div>
      <div role="tablist" className="mb-1 flex gap-1 border-b border-line-9">
        <TabButton
          isActive={activeTab === 'posts'}
          onClick={() => selectTab('posts')}
          label={t('user_profile.lists.posts_label')}
        />
        <TabButton
          isActive={activeTab === 'comments'}
          onClick={() => selectTab('comments')}
          label={t('profile.tabs.comments')}
        />
      </div>

      {activeTab === 'comments' ? (
        <ProfileCommentsList username={username} observer={observer} lite={lite} />
      ) : (
        <ProfilePostsList username={username} observer={observer} initialEntries={initialPosts} lite={lite} />
      )}
    </div>
  );
}

function TabButton({ isActive, onClick, label }: { isActive: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 border-b-[2px] px-1.5 py-3 font-sans text-[16px] font-semibold transition-colors',
        isActive ? 'border-line-brand-10 text-ink-2' : 'border-transparent text-ink-10 hover:text-ink-2'
      )}
    >
      {label}
    </button>
  );
}
