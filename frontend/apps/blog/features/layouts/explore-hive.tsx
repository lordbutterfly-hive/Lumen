import { cn } from '@ui/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@hive/ui/components/card';
import { FC } from 'react';
import { Link } from '@hive/ui';
import { Icons } from '@ui/components/icons';

import { useTranslation } from '../../i18n/client';

const ExploreHive: FC = () => {
  const { t } = useTranslation('common_blog');
  return (
    <Card
      className={cn('my-4 hidden h-fit w-auto flex-col bg-background px-8 text-primary md:flex')}
      translate="no"
    >
      <CardHeader className="px-0 py-4">
        <CardTitle>{t('navigation.explore_nav.explore_hive')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1 pb-4 font-light">
          <li>
            <Link
              href="https://hive.io"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center hover:text-destructive"
            >
              {t('navigation.explore_nav.what_is_hive')}
              <Icons.externalLink className="ml-1 h-4 w-4" />
            </Link>
          </li>
          <li>
            <Link
              href="https://hivedapps.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center hover:text-destructive"
            >
              {t('navigation.explore_nav.hive_dapps')}
              <Icons.externalLink className="ml-1 h-4 w-4" />
            </Link>
          </li>
          <li>
            <Link
              href="https://hiveblocks.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center hover:text-destructive"
            >
              {t('navigation.explore_nav.blockexplorer')}
              <Icons.externalLink className="ml-1 h-4 w-4" />
            </Link>
          </li>
          <li>
            {/* Was an external link to the OLD apps/wallet `/~witnesses` page — a
                real, in-app /witnesses page exists now (browsable logged-out,
                voting requires login), so this points there instead of keeping
                two separate governance UIs alive. */}
            <Link href="/witnesses" className="flex items-center hover:text-destructive">
              {t('navigation.explore_nav.vote_for_witnesses')}
            </Link>
          </li>
          <li>
            {/* Same as above: the old apps/wallet `/proposals` page is replaced by
                the real in-app /proposals page. */}
            <Link href="/proposals" className="flex items-center hover:text-destructive">
              {t('navigation.explore_nav.hive_proposals')}
            </Link>
          </li>
        </ul>
      </CardContent>
    </Card>
  );
};

export default ExploreHive;
