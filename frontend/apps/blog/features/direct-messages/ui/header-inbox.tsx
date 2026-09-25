'use client';

import { FC } from 'react';
import { Link } from '@hive/ui';
import { buttonVariants } from '@ui/components/button';
import { cn } from '@ui/lib/utils';
import { Icons } from '@ui/components/icons';
import TooltipContainer from '@ui/components/tooltip-container';
import { useDmKeyOnSignIn, useDmUnread } from '../live/use-direct-messages';

// TODO i18n - staged copy.
const COPY = {
  inbox: 'Inbox',
  unread: (n: number) => `Inbox (${n} unread)`
};

/**
 * The header's inbox control, beside the notifications bell, for every signed-in
 * account (owner, 2026-09-25: "give everyone a inbox top right"). A link to /inbox
 * with the unread-message count, drawn exactly like the bell: the same ghost icon
 * button, the same filled icon weight, the same badge. The glyph is a letter (`mail`).
 *
 * It is also where a signed-in account gets its messaging key (`useDmKeyOnSignIn`),
 * because the header is on every page a reader lands on after signing in.
 *
 * Not drawn below 360px wide: the phone header had about 3px to spare at 320px, and a
 * fifth 40px control pushed the page 21px sideways there (measured, 320px viewport).
 * The bell's "New message" rows still lead to /inbox at that width.
 */
const HeaderInbox: FC = () => {
  useDmKeyOnSignIn();
  const { count } = useDmUnread();
  return (
    <TooltipContainer title={COPY.inbox}>
      <Link
        href="/inbox"
        aria-label={count > 0 ? COPY.unread(count) : COPY.inbox}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'sm' }),
          'relative h-10 w-10 rounded-control px-0 max-[359px]:hidden'
        )}
        data-testid="nav-inbox"
      >
        <Icons.mail className="h-5 w-5 text-ink-2" />
        {count > 0 ? (
          <span
            className="absolute right-0 top-0.5 z-10 inline-block -translate-y-1/2 translate-x-2/4 rounded-full bg-destructive-icon px-1.5 py-1 text-center align-baseline text-caption font-bold leading-none text-ink-27"
            data-testid="nav-inbox-unread"
          >
            {count}
          </span>
        ) : null}
      </Link>
    </TooltipContainer>
  );
};

export default HeaderInbox;
