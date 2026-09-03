'use client';

import DialogLogin from '@/blog/components/dialog-login';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useTranslation } from '@/blog/i18n/client';

/**
 * The "Reply" affordance beside a comment's vote control (QUICK-REPLY-SPEC §2.1).
 *
 * ★ A REAL `<button>`, translated label. `onCardClick` in `medium-post-card.tsx`
 * ignores clicks that land on a `button` (and anything inside the drawer), so this
 * never toggles the card shut — but it STILL `stopPropagation`s on click AND on
 * Enter/Space keydown, the same belt-and-braces the vote slot documents
 * (`top-comment-drawer.tsx:377-380`): the moment anyone wraps the block in a click
 * handler, an unguarded activation here would reply AND navigate.
 *
 * ★ LOGGED OUT: the affordance still renders (mirror of the quick-post's box
 * always rendering) and is wrapped in `DialogLogin`, so clicking it opens the
 * login dialog and the composer never mounts (§3.3). The `onToggle` callback fires
 * only for a signed-in reader.
 */
export default function QuickReplyButton({
  active,
  onToggle,
  className,
  replyKey
}: {
  /** True while THIS comment's composer is the open one — drives `aria-expanded`. */
  active: boolean;
  /** Open/close this comment's composer. Called only when signed in. */
  onToggle: () => void;
  className?: string;
  /**
   * The target comment's `author/permlink` key, stamped as `data-reply-key` so
   * the composer can return focus to THIS button when it closes (review F10).
   */
  replyKey?: string;
}) {
  const { t } = useTranslation('common_blog');
  const identity = useSessionIdentity();

  const button = (
    <button
      type="button"
      data-testid="quick-reply-button"
      data-reply-key={replyKey}
      /* ★ Only meaningful when signed in — it reports the COMPOSER's state.
         Signed out, the button is a Radix DialogTrigger child and Radix manages
         its own aria-expanded for the login dialog; a static value here would
         fight it (review F13). */
      aria-expanded={identity.isLoggedIn ? active : undefined}
      className={className}
      /* ★ preventDefault on mousedown (review F7) — the same load-bearing line
         `composer-action.tsx` and the emoji picker's trigger carry: without it,
         a press held longer than a frame blurs the composer's textarea, the
         empty-composer blur-close fires mid-press, and the click then REOPENS
         the composer it just closed. Preventing the default keeps focus (and
         the open/closed state) where it was until the click decides. */
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        if (identity.isLoggedIn) onToggle();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      }}
    >
      {t('short_form_composer.reply')}
    </button>
  );

  if (!identity.isLoggedIn) {
    return <DialogLogin>{button}</DialogLogin>;
  }
  return button;
}
