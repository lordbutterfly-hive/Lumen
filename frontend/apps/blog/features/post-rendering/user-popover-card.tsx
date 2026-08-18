import UserAvatar from '@/blog/features/post-rendering/user-avatar';
import { accountReputation } from '@hive/ui';
import { Popover, PopoverContent, PopoverTrigger } from '@ui/components/popover';
import PopoverCardData from './popover-card-data';
import { useTranslation } from '@/blog/i18n/client';
import { Icons } from '@ui/components/icons';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/tooltip';
import { QuillMark } from './quill-mark';

export interface UserPopoverCardProps {
  /**
   * The account that actually signed this post on chain. Every ACTION in the card —
   * follow, mute, the profile lookup — uses this, never the name on screen.
   */
  author: string;
  /**
   * Set only for a Lumen lite author, whose words are published on chain by a shared
   * account. It is what the reader sees, and it is NOT a Hive account: there is no
   * profile to fetch and nothing to follow or mute there, so the card shows the name
   * alone. Passing it as the `author` instead would point Mute at the wrong account
   * (or at an unrelated real Hive user who happens to share the handle).
   */
  liteName?: string;
  author_reputation: number;
  blacklist: string[];
  withImage?: boolean;
}

export function UserPopoverCard({
  author,
  liteName,
  author_reputation,
  blacklist,
  withImage = false
}: UserPopoverCardProps) {
  const { t } = useTranslation('common_blog');
  const shownName = liteName || author;

  return (
    <>
      <Popover>
      <PopoverTrigger data-testid="author-name-link" asChild>
        <button className="flex items-center gap-1 hover:cursor-pointer">
          {withImage && <UserAvatar username={shownName} size="normal" />}
          {/* ★ ONE INK FOR A USERNAME (2026-08-13, audit §5.3). `text-foreground`
              computes rgb(51,51,51) — measured on the shipped build — while the
              redesigned surfaces (the followers list, the profile masthead, the
              settings cards, the rail cards) all print identity at #161511. Two
              different blacks for the same thing, on pages a reader moves
              between. #161511 is the one the redesign standardised on, so the
              odd one out changes. Hex literal rather than a theme token for the
              same reason `account-lists/follow-list/tokens.ts` documents: the
              warm Lumen palette is not the legacy `bg-background-*` theme. */}
          <span className="font-semibold text-ink-2 hover:text-destructive">{shownName}</span>
          {/*
           * ★★★ A LITE ACCOUNT NEVER SHOWS A HIVE REPUTATION (2026-08-16, owner).
           *
           * It was not merely irrelevant, it was somebody else's number. A lite
           * post is signed by the shared gateway account, so `author_reputation`
           * on the entry is the GATEWAY's. Measured: `hbd-temp` has raw
           * reputation 0, which `accountReputation` formats to exactly 25. So
           * EVERY Google, Bitcoin and Ethereum account displayed the same "(25)",
           * a number none of them earned, and 25 is Hive's brand-new-nobody
           * value. The product was stamping every keyless writer with a
           * stranger's low score.
           *
           * `liteName` is the existing signal for "this byline belongs to a lite
           * account" (it is what swaps the displayed handle above), so it gates
           * this too rather than introducing a second detection.
           *
           * The quill mark takes this slot instead, rendered as a SIBLING of the
           * trigger below rather than inside it. Standing for these accounts is
           * separately carried by the League emblem (features/retention), which is
           * earned on Lumen and shows from Ember up.
           */}
          {liteName ? null : (
            <span
              title={t('post_content.reputation_title')}
              aria-label={`${t('post_content.reputation_title')} ${accountReputation(author_reputation)}`}
              className="text-muted-foreground"
              data-testid="author-reputation"
            >
              ({accountReputation(author_reputation)})
            </span>
          )}
          {blacklist && blacklist[0] ? (
            <span title={blacklist[0]}>
              <Icons.warning className="ml-1 h-4 w-4 text-destructive" />
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 border border-border bg-background p-0 shadow-lg" data-testid="user-popover-card-content">
        <PopoverCardData author={author} liteName={liteName} blacklist={blacklist} authorReputation={author_reputation} />
      </PopoverContent>
      </Popover>
      {/*
       * ★ OUTSIDE the trigger button, deliberately. Spec `quill-mark/README.md`
       * wants the mark focusable so the tooltip is reachable by keyboard, and a
       * focusable element nested inside a <button> is both invalid content and
       * useless: focusing the button would not surface the tooltip anyway. As a
       * sibling it gets its own stop, and the parent (UserInfo) is a flex row
       * with a gap, so it still sits immediately after the handle.
       *
       * delayDuration 140ms in, `disableHoverableContent` so it does not linger.
       * The svg stays aria-hidden; this span carries the accessible text.
       */}
      {liteName ? (
        <TooltipProvider delayDuration={140} disableHoverableContent>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                data-testid="lite-account-mark"
                className="inline-flex items-center text-muted-foreground"
              >
                <QuillMark size={18} />
              </span>
            </TooltipTrigger>
            <TooltipContent>{t('lite_account.mark_tooltip')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
    </>
  );
}
