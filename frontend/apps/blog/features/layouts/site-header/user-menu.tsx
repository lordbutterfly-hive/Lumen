import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@ui/components/dropdown-menu';
import { ReactNode } from 'react';
import { Link } from '@hive/ui';
import BasePathLink from '../../../components/base-path-link';
import { Icons } from '@ui/components/icons';
import LangToggle from '../lang-toggle';
import { useLogout } from '@smart-signer/lib/auth/use-logout';
import { User } from '@smart-signer/types/common';
import { useTranslation } from '@/blog/i18n/client';

// TODO i18n — staged copy, same precedent as app-header's LABELS; move to
// locales/*/common_blog.json with the rest of the Lumen copy.
const LITE_LABELS = {
  security: 'Sign-in & recovery',
  upgrade: 'Upgrade to a Hive account'
};

const UserMenu = ({
  children,
  user
}: {
  children: ReactNode;
  user: User;
}) => {
  const onLogout = useLogout();
  const { t } = useTranslation('common_blog');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent className="w-56 bg-background-secondary" data-testid="user-profile-menu-content">
        {/* Item 11: this used to also show a login-method icon (e.g. the Hive
            Keychain glyph) next to a "Hive"/"Blog" wordmark — a stray brand
            escape hatch in a Lumen-only dropdown. Username only now. */}
        <DropdownMenuLabel>
          <span data-testid="user-name-in-profile-menu">{user.username}</span>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <BasePathLink href={`/@${user.username}`} data-testid="user-profile-menu-profile-link">
            <DropdownMenuItem className="cursor-pointer">
              <Icons.user className="mr-2" />
              <span className="w-full">{t('navigation.user_menu.profile')}</span>
            </DropdownMenuItem>
          </BasePathLink>
          {/* Item 12: Notifications used to live here too, pointing at the same
              route as the bell in app-header.tsx but reachable from a second
              place. Notifications now have exactly one door: the bell. */}
          {/* Comments removed for the same reason, 2026-08-06. The redesigned
              profile already has a Comments TAB (`?tab=comments`), so this was a
              second door to the same thing — except it led somewhere WORSE: the
              legacy `/@user/comments` page, which still wears the old chrome
              (the "Blacklisted Users • Muted Users • Followed Blacklists" strip,
              "Blog / Posts / Social / Block Explorer" nav) and, for a lite
              account, settles on "No Data Available … Check Node Status"
              because it asks Hive for the posts of a handle that has no Hive
              account. Driven signed-in against the production build. */}
          {/* Item 10: Replies removed — it's the other route (besides
              Notifications) that pointed at the legacy, unredesigned page. */}
          {/*
            The two doors a lite account needs and could not previously find. Both
            pages existed with nothing anywhere linking to them — the same way /login
            was unreachable for weeks. Lite-only: a full Hive account already has its
            own keys and has nothing to upgrade to.
          */}
          {user.account_tier === 'lite' ? (
            <>
              <Link href="/security" data-testid="user-profile-menu-security-link">
                <DropdownMenuItem className="cursor-pointer">
                  <Icons.keyRound className="mr-2" />
                  <span className="w-full">{LITE_LABELS.security}</span>
                </DropdownMenuItem>
              </Link>
              <Link href="/upgrade" data-testid="user-profile-menu-upgrade-link">
                <DropdownMenuItem className="cursor-pointer">
                  <Icons.arrowUpCircle className="mr-2" />
                  <span className="w-full">{LITE_LABELS.upgrade}</span>
                </DropdownMenuItem>
              </Link>
            </>
          ) : null}
          {/* Item 9: theme toggle removed — Lumen is light-only, dark mode
              was unfinished/broken, and this was the only user-facing way in. */}
          <DropdownMenuItem className="cursor-pointer">
            <LangToggle logged={true} />
          </DropdownMenuItem>
          <DropdownMenuItem className="cursor-pointer">
            <Link
              href="/wallet"
              className="flex w-full items-center"
              data-testid="user-profile-menu-wallet-link"
            >
              <Icons.wallet className="mr-2" />
              <span className="w-full">{t('navigation.user_menu.wallet')}</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem className="cursor-pointer">
            <Link
              href=""
              onClick={async (e) => {
                e.preventDefault();
                await onLogout();
              }}
              className="flex w-full items-center"
              data-testid="user-profile-menu-logout-link"
            >
              <Icons.doorOpen className="mr-2" />
              <span className="w-full">{t('navigation.user_menu.logout')}</span>
            </Link>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
export default UserMenu;
