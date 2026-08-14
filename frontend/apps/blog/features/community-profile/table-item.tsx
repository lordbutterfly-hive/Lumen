'use client';

import { TableCell, TableRow } from '@ui/components/table';
import { Pen, Save, X } from 'lucide-react';
import { Roles, User } from './lib/utils';
import BasePathLink from '@/blog/components/base-path-link';
import { useSetRoleMutation } from '@/blog/features/community-profile/hooks/use-set-role-mutations';
import { useState } from 'react';
import { EAvailableCommunityRoles } from '@hiveio/wax';
import { handleError } from '@ui/lib/handle-error';
import clsx from 'clsx';
import { UserAvatarImg } from '@hive/ui';
import RolesSelect from './roles-select';

const TableItem = ({
  community,
  item,
  loggedUserValue
}: {
  community: string;
  item: User;
  loggedUserValue: number;
}) => {
  const setRoleMutation = useSetRoleMutation();
  const [selectedRole, setSelectedRole] = useState<Roles>(item.role as Roles);
  const [editMode, setEditMode] = useState(false);

  const onUpdateRole = async () => {
    try {
      await setRoleMutation.mutateAsync({
        community,
        username: item.name,
        role: selectedRole as EAvailableCommunityRoles
      });
    } catch (error) {
      handleError(error, {
        method: 'setRole',
        params: { community, username: item.name, role: selectedRole as EAvailableCommunityRoles }
      });
    } finally {
      setEditMode(false);
    }
  };

  return (
    <TableRow
      key={item.name}
      // ★ WARM HAIRLINE ROW, NOT THE SHARED PRIMITIVE'S SLATE HOVER (2026-08-14
      // restyle). `TableRow`'s own default is `border-b transition-colors
      // hover:bg-muted/50` — `muted` is the same legacy shadcn ramp as
      // `secondary` (see content.tsx's header note) — so left alone this row
      // would still hover cool-grey while `follow-list-row.tsx` (this
      // redesign's reference) hovers `surface-10` (#faf9f8). `cn()`'s
      // tailwind-merge keeps whichever conflicting utility comes LAST, so this
      // override wins without forking the shared `Table` component; verified
      // directly against this repo's `tailwind-merge` build before relying on
      // it. `last:border-b-0` drops the final row's divider, same as the card
      // pattern in `follow-list/tokens.ts`'s `LIST_ROW`.
      className="border-b border-line-9 last:border-b-0 hover:bg-surface-10"
      data-testid="community-role-row"
      data-account={item.name}
    >
      <TableCell className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          {/* ★ AVATAR (redesign spec P3, same fix as follow-list-row.tsx): this
              table showed a bare `@handle` and nothing else — every other
              identity row in Lumen (feed, comments, the follower/following
              lists) shows an avatar, and its absence here was a large part of
              why this page read as a different product. */}
          <BasePathLink href={`/@${item.name}`} className="shrink-0" tabIndex={-1} aria-hidden>
            <UserAvatarImg
              username={item.name}
              pixelSize={32}
              radiusClassName="rounded-[10px]"
              className="ring-1 ring-inset ring-line-9"
            />
          </BasePathLink>
          {/* ★ NO RED ON THE USERNAME (same fix as follow-list-row.tsx P2).
              This was `text-destructive`, which is the OLD shadcn destructive
              red (`hsl(0,70%,51%)` ≈ #d92b2b) — not even this app's own
              CURRENT brand red (`ink-brand-6` = #c0392b) — painting every
              ordinary account link the "danger" colour and leaving nothing
              left over to distinguish the genuinely destructive Cancel control
              two columns over. Hover is now an underline, matching every other
              plain identity link in the app. */}
          <BasePathLink
            href={`/@${item.name}`}
            className="text-14 font-semibold text-ink-2 hover:underline"
            data-testid="community-role-account"
          >
            @{item.name}
          </BasePathLink>
        </div>
      </TableCell>
      <TableCell className="px-4 py-3">
        {loggedUserValue >= 4 && item.value < loggedUserValue ? (
          <span className="flex items-center gap-2">
            {editMode ? (
              <>
                <div className="w-36">
                  <RolesSelect
                    disabled={setRoleMutation.isPending}
                    loggedUserLevel={loggedUserValue}
                    value={selectedRole}
                    onValueChange={setSelectedRole}
                    testId="community-role-edit-select"
                  />
                </div>
                <button
                  onClick={onUpdateRole}
                  disabled={setRoleMutation.isPending}
                  data-testid="community-role-save-button"
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-ink-ok-5 transition-colors hover:bg-surface-ok-1 disabled:pointer-events-none disabled:opacity-50"
                >
                  <Save className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setEditMode((prev) => !prev)}
                  disabled={setRoleMutation.isPending}
                  data-testid="community-role-cancel-button"
                  // ★ TOKEN BRAND RED, NOT `text-destructive` (same fix as the
                  // account link above): Cancel is the one control on this row
                  // that should still read as "stop/undo", so it keeps a red
                  // treatment — just the app's CURRENT red, not the old one.
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-ink-brand-6 transition-colors hover:bg-surface-brand-1 disabled:pointer-events-none disabled:opacity-50"
                >
                  <X className="h-4 w-4" />
                </button>
              </>
            ) : (
              <>
                <span
                  className={clsx('text-14 text-ink-2', {
                    'animate-pulse text-ink-brand-6': item.temprary
                  })}
                  data-testid="community-role-name"
                >
                  {item.role}
                </span>
                <button
                  onClick={() => setEditMode(true)}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] text-ink-14 transition-colors hover:bg-surface-21 hover:text-ink-7 disabled:pointer-events-none disabled:opacity-40"
                  disabled={item.temprary}
                  data-testid="community-role-edit-button"
                >
                  <Pen className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </span>
        ) : (
          <span className="text-14 text-ink-2" data-testid="community-role-name">
            {item.role}
          </span>
        )}
      </TableCell>

      <TableCell className="px-4 py-3 text-14 text-ink-10" data-testid="community-role-title">
        {item.title}
      </TableCell>
    </TableRow>
  );
};
export default TableItem;
