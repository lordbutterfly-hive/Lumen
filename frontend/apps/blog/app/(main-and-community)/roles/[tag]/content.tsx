'use client';

import { useQuery } from '@tanstack/react-query';
import Loading from '@ui/components/loading';
import AddRole from '@/blog/features/community-profile/add-role';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@ui/components/table';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { getRoleValue, Roles, rolesLevels } from '@/blog/features/community-profile/lib/utils';
import TableItem from '@/blog/features/community-profile/table-item';
import NoDataError from '@/blog/components/no-data-error';
import { getListCommunityRoles } from '@transaction/lib/bridge-api';
import { useTranslation } from '@/blog/i18n/client';

const Content = ({ community }: { community: string }) => {
  /**
   * ★★★ SAME RACE AS EVERY OTHER PERMISSION GATE (2026-08-12, G1). This was
   * raw `useUserClient()`'s `user.username`, which cannot answer during SSR
   * and reports empty until `/api/users/me` returns — so `loggedUser` never
   * matched the viewer's own row in `data` for that whole window, `AddRole`
   * stayed hidden even for a genuine admin/mod, and the fallback object below
   * always claimed `role: 'guest'`. `identity.username` is seeded from the
   * session cookie the server already read, so the match is correct on the
   * first render. No `account_tier`-style field is involved here — the role
   * list itself is server-fetched and not tier-gated — so nothing needs to
   * wait on `identity.clientAnswered`, unlike the lite-only panels.
   */
  const identity = useSessionIdentity();
  const { t } = useTranslation('common_blog');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['rolesList', community],
    queryFn: () => getListCommunityRoles(community),
    enabled: Boolean(community),
    select: (list) =>
      list
        ? list.map((e) => ({
            name: e[0],
            value: getRoleValue(e[1] as Roles),
            role: e[1] as Roles,
            title: e[2],
            temprary: !!e[3]
          }))
        : []
  });

  const loggedUser = data?.find((e) => e.name === identity.username) ?? {
    value: 1,
    role: 'guest',
    name: identity.username,
    title: ''
  };

  if (isLoading) return <Loading loading={isLoading} />;
  if (isError) return <NoDataError />;

  return (
    <div className="my-4 flex w-full items-center justify-between" translate="no">
      <div className="m-2 w-full bg-background px-8 py-6">
        <h2 className="mb-1 text-2xl" data-testid="community-roles-heading">
          {t('communities.user_roles')}
        </h2>
        <Table
          className="w-full border-[1px] border-solid border-secondary"
          data-testid="community-roles-table"
        >
          <TableHeader className="text-">
            <TableRow className="bg-secondary">
              <TableHead className="px-2">{t('communities.account')}</TableHead>
              <TableHead className="w-48 px-2">{t('communities.role')}</TableHead>
              <TableHead className="px-2">{t('communities.title')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((e) => (
              <TableItem loggedUserValue={loggedUser.value} item={e} community={community} key={e.name} />
            ))}
          </TableBody>
        </Table>
        {loggedUser.value >= 3 && <AddRole loggedUserLevel={loggedUser.value} community={community} />}
        <div className="mt-12">
          <h1>{t('communities.role_permissions')}</h1>
          <div className="text-sm">
            {rolesLevels.map((role) => (
              <div key={role.name}>
                <span className="font-bold"> {t(`communities.${role.name}`)}</span>
                <span>- {t(`communities.description_${role.name}`)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Content;
