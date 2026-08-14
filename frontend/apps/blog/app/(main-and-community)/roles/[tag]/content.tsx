'use client';

import { useQuery } from '@tanstack/react-query';
import Loading from '@ui/components/loading';
import AddRole from '@/blog/features/community-profile/add-role';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@ui/components/table';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { getRoleValue, Roles, rolesLevels } from '@/blog/features/community-profile/lib/utils';
import TableItem from '@/blog/features/community-profile/table-item';
import NoDataError from '@/blog/components/no-data-error';
import { fetchCommunityRoles } from '@/blog/lib/chain-fetch';
import { useTranslation } from '@/blog/i18n/client';
import PageMasthead from '@/blog/features/layouts/page-masthead';

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

  // ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). This called
  // `getListCommunityRoles` directly, unconditionally, on `/roles/[tag]` —
  // reachable by any visitor, signed in or not. (Note this query's key,
  // `['rolesList', community]`, has never matched this route's own
  // `page.tsx`'s SSR-prefetch key, `['community', tag]` — so that server
  // fetch was always discarded before this fix too; fixing the fetcher here
  // removes the browser-side WASM cost regardless of that separate
  // hydration mismatch.) See `apps/blog/app/api/community-roles/route.ts`.
  const { data, isLoading, isError } = useQuery({
    queryKey: ['rolesList', community],
    queryFn: () => fetchCommunityRoles(community),
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
    // ★ RESTYLE, 2026-08-14. `/roles/<community>` was the last route still
    // wrapped by the pre-Lumen `CommunityLayout` sidebar — every OTHER
    // community-scoped feed (trending/hot/created/muted/payout for a tag) now
    // redirects to `/topics/<tag>` (see `trending/[tag]/page.tsx`), which is
    // why this page alone still showed the legacy slate table header and blue
    // Subscribe/New-post chrome. That outer sidebar + breadcrumb lives in
    // `features/layouts/community/**`, outside this restyle's file ownership,
    // and is left exactly as-is (see the delivery notes). Everything below is
    // this route's own content, rebuilt to match `topic-shell.tsx` /
    // `account-lists/follow-list/**`.
    <div className="w-full pb-10" translate="no">
      {/* No `mark` glyph: per page-masthead.tsx's own rule, a mark is only
          assigned once somebody has reviewed a page for one — nobody has for
          roles yet, so this stays unassigned like witnesses/proposals/wallet. */}
      <PageMasthead
        eyebrow={t('communities.roles')}
        title={<span data-testid="community-roles-heading">{community}</span>}
      >
        <span data-testid="community-roles-count">
          {t('communities.roles_count', { count: data.length })}
        </span>
      </PageMasthead>

      {/* ★ WARM CARD + HAIRLINE, REPLACING `border-secondary`/`bg-secondary`
          (the old header row). Both resolved through the legacy shadcn slate
          ramp — `--secondary: 210 40% 96.1%`, a blue-tinted grey, verified in
          `globals.css` — while every redesigned surface (this table's own
          `page-masthead.tsx` above, `follow-list/tokens.ts`) reads through the
          warm `line-9` / `surface-1` / `surface-10` tokens instead. These are
          TOKEN NAMES (`tailwind.config.js` → `rgb(var(--line-9))` etc.), not a
          fresh hardcoded literal — the same generated palette `PageMasthead`
          already draws from, so this table stays correct if that palette is
          ever re-tuned, and it responds to dark mode for free. */}
      <div
        className="w-full overflow-hidden rounded-[18px] border border-line-9 bg-surface-1"
        data-testid="community-roles-table-card"
      >
        <Table className="w-full" data-testid="community-roles-table">
          <TableHeader>
            {/* `hover:bg-surface-10` repeats the row's own resting colour —
                it exists only to CANCEL `TableRow`'s built-in
                `hover:bg-muted/50` (the same slate ramp), not to add a new
                hover effect on a header nobody meaningfully hovers. */}
            <TableRow className="border-b border-line-9 bg-surface-10 hover:bg-surface-10">
              <TableHead className="px-4 py-3 text-12 font-semibold uppercase tracking-[0.14em] text-ink-10">
                {t('communities.account')}
              </TableHead>
              <TableHead className="w-48 px-4 py-3 text-12 font-semibold uppercase tracking-[0.14em] text-ink-10">
                {t('communities.role')}
              </TableHead>
              <TableHead className="px-4 py-3 text-12 font-semibold uppercase tracking-[0.14em] text-ink-10">
                {t('communities.title')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((e) => (
              <TableItem loggedUserValue={loggedUser.value} item={e} community={community} key={e.name} />
            ))}
          </TableBody>
        </Table>
      </div>

      {loggedUser.value >= 3 && <AddRole loggedUserLevel={loggedUser.value} community={community} />}

      <div className="mt-8 rounded-[18px] border border-line-9 bg-surface-1 p-6">
        {/* `<h2>`, not `<h1>` — `PageMasthead` above already renders this
            page's one `<h1>`; the original bare `<h1>{t('communities.
            role_permissions')}</h1>` gave the page two, which is its own
            pre-existing a11y defect fixed as part of this restyle. */}
        <h2 className="mb-3 font-serif text-20 font-semibold text-ink-2">
          {t('communities.role_permissions')}
        </h2>
        <div className="flex flex-col gap-2">
          {rolesLevels.map((role) => (
            <div key={role.name} className="text-14 text-ink-10">
              <span className="font-semibold text-ink-2">{t(`communities.${role.name}`)}</span>
              <span> — {t(`communities.description_${role.name}`)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Content;
