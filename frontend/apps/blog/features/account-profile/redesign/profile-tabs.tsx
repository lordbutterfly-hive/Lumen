'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { cn, numberWithCommas } from '@ui/lib/utils';
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
 * active tab = red underline + filled count chip. `?tab=` sync mirrors the
 * homepage's FeedTabs so the tab survives back/forward and is linkable.
 *
 * `postsCount` is the account's total `post_count` (posts+comments
 * combined — Hive doesn't split them account-side). The Comments tab has no
 * equivalent real total available without a dedicated count query, so its
 * chip is omitted rather than showing a fabricated number.
 */
export default function ProfileTabs({
  username,
  observer,
  postsCount,
  initialPosts,
  lite = false
}: {
  username: string;
  observer: string;
  postsCount?: number;
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
      <div role="tablist" className="mb-1 flex gap-1 border-b border-[#ebebeb]">
        <TabButton
          isActive={activeTab === 'posts'}
          onClick={() => selectTab('posts')}
          label={t('user_profile.lists.posts_label')}
          count={postsCount}
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

function TabButton({
  isActive,
  onClick,
  label,
  count
}: {
  isActive: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 border-b-[2.5px] px-1.5 py-3 font-sans text-[15.5px] font-semibold transition-colors',
        isActive ? 'border-[#c0392b] text-[#161511]' : 'border-transparent text-[#6b7280] hover:text-[#161511]'
      )}
    >
      {label}
      {typeof count === 'number' ? (
        <span
          className={cn(
            'rounded-full px-2.5 py-0.5 text-[12.5px] font-bold tabular-nums',
            isActive ? 'bg-[#fdecea] text-[#c0392b]' : 'bg-[#f1f3f5] text-[#9ca3af]'
          )}
        >
          {numberWithCommas(String(count))}
        </span>
      ) : null}
    </button>
  );
}
