'use client';

import { useTranslation } from '@/blog/i18n/client';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ui/components/tabs';
import { Link } from '@hive/ui';
import { usePathname } from 'next/navigation';
import { ReactNode } from 'react';

/**
 * ★ Only Comments is left here, 2026-08-06.
 *
 * `/@user/posts` and `/@user/payout` were DELETED. They were duplicates of tabs
 * the redesigned profile already has (`?tab=posts`), wearing the old chrome, and
 * for a lite account they settled on "No Data Available … Check Node Status" —
 * they asked Hive for the posts of a handle that has no Hive account. Their
 * triggers had to go with them: a tab strip linking to a deleted route is a
 * guaranteed 404 on click.
 */
type SortType = 'comments';

const AccountPostsTabs = ({ username, children }: { username: string; children: ReactNode }) => {
  const { t } = useTranslation('blog');
  const pathname = usePathname();
  const segment = pathname?.slice(pathname.lastIndexOf('/') + 1);
  const sort: SortType = segment === 'comments' ? 'comments' : 'comments';

  return (
    <Tabs value={sort} className="w-full">
      <TabsList className="flex justify-start bg-background-tertiary" data-testid="user-post-menu">
        <TabsTrigger value="comments" className="p-0">
          <Link className="rounded-sm px-3 py-1.5" href={`/@${username}/comments`}>
            {t('navigation.profile_posts_tab_navbar.comments')}
          </Link>
        </TabsTrigger>
      </TabsList>
      <TabsContent value={sort}>{children}</TabsContent>
    </Tabs>
  );
};

export default AccountPostsTabs;
