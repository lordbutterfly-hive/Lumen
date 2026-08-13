'use client';

import { ReactNode } from 'react';
import { UserAvatarImg } from '@hive/ui';
import BasePathLink from '@/blog/components/base-path-link';
import { LIST_ROW, LIST_ROW_HOVER } from './tokens';

/**
 * One 60px identity row.
 *
 * ★ THE AVATAR IS THE POINT (redesign spec P3). Both lists rendered zero
 * avatars and no identity at all — a username in brand red, twice over (as the
 * label and as the link target), on a 36px zebra stripe. Every other list
 * surface in Lumen (feed, comments, witnesses, the moderation lists) shows an
 * avatar; this is the single biggest reason these two pages read as a different
 * product. `UserAvatarImg` is the app's ONE avatar implementation, with the
 * direct-host -> proxy -> monogram fallback chain already solved.
 *
 * ★ ONE LINE, NOT TWO. The spec's row has a display name over an `@username`.
 * `condenser_api.get_followers` / `get_following` return `{follower, following,
 * what}` — no display name, no reputation, no bio (verified against
 * api.hive.blog on 2026-08-13, and `IFollow` in
 * `packages/common-hiveio-packages/src/wax/extended-hive.chain.ts:650` says the
 * same). Resolving one would cost a `get_accounts` per row, 50 per page. So the
 * spec's own documented fallback applies: the username IS the primary line, at
 * 14px/w600/#161511, and it is NOT printed a second time underneath.
 *
 * ★ NO RED ON THE USERNAME (spec P2). `text-destructive` (rgb(218,43,43)) used
 * to paint every name in the list, which spends the app's danger colour on an
 * ordinary link and leaves nothing to signal danger with — part of why `Block`
 * could sit at the same weight as `Follow`. The hover affordance is an
 * underline, not a colour change, so red stays reserved for the accent button
 * and the Block menu item.
 */
export default function FollowListRow({
  username,
  temporary = false,
  actions
}: {
  username: string;
  /** An optimistic row that is not on chain yet — dimmed and not linked. */
  temporary?: boolean;
  actions?: ReactNode;
}) {
  return (
    <li
      className={`${LIST_ROW} ${LIST_ROW_HOVER} ${temporary ? 'opacity-50' : ''}`}
      data-testid="follow-list-row"
    >
      <BasePathLink href={`/@${username}`} className="shrink-0" tabIndex={-1} aria-hidden>
        <UserAvatarImg
          username={username}
          pixelSize={40}
          radiusClassName="rounded-[12px]"
          className="ring-1 ring-inset ring-[#ebebeb]"
        />
      </BasePathLink>
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <BasePathLink
          href={`/@${username}`}
          className="truncate font-sans text-[14px] leading-[22px] font-semibold text-[#161511] hover:underline"
          data-testid="follow-list-row-name"
        >
          {username}
        </BasePathLink>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </li>
  );
}
