import { Icons } from '@hive/ui/components/icons';
import TimeAgo from '@hive/ui/components/time-ago';
import { UserAvatarImg } from '@ui/components';
import { IAccountNotification } from '@hive/common-hiveio-packages/wax';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { usePathname } from 'next/navigation';
import { Link } from '@hive/ui';
import { cn } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/tooltip';

const usernamePattern = /\B@[a-z0-9.-]+/gi;

/** Get icon and color based on notification type */
function getNotificationIcon(type: string) {
  switch (type) {
    case 'vote':
      return {
        icon: <Icons.arrowUpCircle className="h-4 w-4" />,
        color: 'text-ink-ok-4'
      };
    case 'reblog':
      return {
        icon: <Icons.forward className="h-4 w-4" />,
        color: 'text-ink-info-5'
      };
    case 'reply':
    case 'reply_comment':
      return {
        icon: <Icons.comment className="h-4 w-4" />,
        color: 'text-ink-violet-1'
      };
    case 'mention':
      return {
        icon: <Icons.atSign className="h-4 w-4" />,
        color: 'text-ink-warn-6'
      };
    case 'follow':
      return {
        icon: <Icons.userPlus className="h-4 w-4" />,
        color: 'text-ink-info-8'
      };
    case 'error':
      return {
        icon: <Icons.settings className="h-4 w-4" />,
        color: 'text-ink-brand-7'
      };
    default:
      return {
        icon: <Icons.info className="h-4 w-4" />,
        color: 'text-ink-10'
      };
  }
}

const NotificationListItem = ({
  date,
  msg,
  score,
  type,
  url,
  lastRead,
  isOwner: isOwnerProp
}: IAccountNotification & {
  lastRead: Date;
  /**
   * ★ THE READ/UNREAD STATE CANNOT BE READ OFF THE URL (2026-08-10, owner
   * item Q-3).
   *
   * This component was written for a route shaped like `/@{username}/
   * notifications`, so it decided "are these MY notifications" by comparing the
   * logged-in name against the first path segment. That route is deleted. The
   * only surface left is the header bell, which renders on EVERY page — so
   * `pathname.split('/')[1]` was `topics`, `trending`, `''` … and never the
   * viewer's name, `isOwner` was therefore false on every page, and NO row was
   * ever marked unread even when the bell's own badge said there were unread
   * ones. A caller that knows whose list this is says so.
   */
  isOwner?: boolean;
}) => {
  const { t } = useTranslation('common_blog');
  const pathname = usePathname();
  const username = pathname?.split('/')[1].replace('@', '') || '';
  /**
   * ★ SAME RACE AS THE HEADER/RAIL (2026-08-12, F5). This was raw `useUserClient()`,
   * which cannot answer during SSR and reports "signed out" until `/api/users/me`
   * returns — so a real owner's own notifications briefly rendered every row as read
   * (`isOwner` false ⇒ `isUnread` false) regardless of the bell's own unread badge.
   * `useSessionIdentity` (features/layouts/server-session.tsx) is seeded from the
   * session cookie the server already read, so it is correct from the first render.
   */
  const identity = useSessionIdentity();

  const mentions = msg.match(usernamePattern);
  const notificationDate = new Date(date);
  const { icon, color } = getNotificationIcon(type);
  const fixedUrl = url.startsWith('c') ? url.replace('c', 'trending') : url;
  const errorMessage = type === 'error';
  const isOwner = isOwnerProp ?? (identity.isLoggedIn && identity.username === username);
  const isUnread = isOwner && notificationDate > lastRead;

  // Get the first mentioned user for avatar display
  const firstMention = mentions?.[0];
  const avatarUsername = firstMention?.substring(1);

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-3 transition-colors hover:bg-background-secondary',
        isUnread && 'bg-destructive/5'
      )}
      data-testid="notification-list-item"
    >
      {/* Unread indicator */}
      {isUnread ? (
        <span className="h-2 w-2 shrink-0 rounded-full bg-destructive" />
      ) : (
        <span className="h-2 w-2 shrink-0" />
      )}

      {/* Avatar for the user who triggered the notification, or fallback icon.
          ★ CONVERGED (F6 item 22). This fell back to a generic, non-personalised
          `/defaultavatar.png` on error and never tried our own `/api/avatar` proxy
          at all — so a lite account or a dead Steemit-era `profile_image` showed
          the SAME picture as everybody else instead of their own initial. */}
      {avatarUsername ? (
        <Link href={`/@${avatarUsername}`} data-testid="notification-account-icon-link" className="shrink-0">
          <UserAvatarImg username={avatarUsername} pixelSize={40} alt={`${avatarUsername} profile picture`} />
        </Link>
      ) : (
        <div
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-background-tertiary',
            color
          )}
        >
          {icon}
        </div>
      )}

      {/* Message content */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Link
          href={`/${fixedUrl}`}
          className="line-clamp-2 text-sm hover:text-destructive visited:text-ink-10"
        >
          <span data-testid="notification-account-and-message">
            <strong data-testid="subscriber-name">{msg.split(' ')[0]}</strong>
            {mentions
              ? msg.split(new RegExp(`(${mentions[0]})`, 'gi'))[2]
              : errorMessage
                ? msg.split('error:')[1]
                : null}
          </span>
        </Link>
        <span className="flex items-center gap-2 text-xs text-ink-10" data-testid="notification-timestamp">
          <span className={color}>{icon}</span>
          {/* One format for the whole list — see TimeAgo's `numeric` prop. */}
          <TimeAgo date={date} numeric="always" />
        </span>
      </div>

      {/* ★ THIS NUMBER IS A REPUTATION, AND IT NOW SAYS SO (2026-08-10, owner
          item Q-2). It rendered as a bare figure in a filled pill on the right
          edge of every row — the exact shape and position of an unread counter —
          so a list of 50 notifications showed 50 unexplained badges reading 25,
          43, 50, 67, 70. Its only explanation was a hover tooltip, which a
          touch device never sees and a screen reader was never offered: the
          element carried no `aria-label` and no `title`, so it announced as the
          digits alone. Now it is labelled text, not a count-shaped chip. */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="flex shrink-0 items-center gap-1 font-sans text-[12px] leading-[18px] text-ink-10"
              data-testid="notification-reputation-badge"
              title={t('navigation.profile_notifications_tab_navbar.reputation_at_time')}
              aria-label={`${t('navigation.profile_notifications_tab_navbar.reputation_label')} ${score}`}
            >
              <span aria-hidden className="uppercase tracking-wide">
                {t('navigation.profile_notifications_tab_navbar.reputation_label')}
              </span>
              <span aria-hidden className="font-semibold tabular-nums text-ink-2">
                {score}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="left">
            <p>{t('navigation.profile_notifications_tab_navbar.reputation_at_time')}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
};

export default NotificationListItem;
