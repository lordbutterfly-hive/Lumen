'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { Avatar, AvatarFallback, AvatarImage } from '@ui/components';
import { getUserAvatarUrl } from '@hive/ui';
import { Button } from '@ui/components/button';
import { cn } from '@ui/lib/utils';
import { setStorageItem, StorageTTL } from '@ui/lib/storage-with-ttl';
import { withBasePath } from '@ui/lib/path-utils';
import DialogLogin from '@/blog/components/dialog-login';
import { createLitePost } from '@/blog/lib/lite/client/lite-write';

// TODO: move to i18n (t('...'))
const LABELS = {
  placeholder: "What's on your mind?",
  postButton: 'Post',
  loginPrompt: 'Start writing — log in to post',
  fullStory: 'Write a full story'
};

const SUBMIT_PATH = '/submit.html';

/**
 * "What's on your mind?" compose box near the top of the home feed. At rest it is
 * a single-line card (avatar + placeholder + ink Post button, all Open Sans per
 * design-handoff-v2 — no serif display face); clicking it expands into the real
 * editor surface. Both the "Post" button and the "Write a
 * full story" link hand the typed draft to the real editor: they write it to the
 * same localStorage draft key the editor reads on mount (`postData-new-<user>`),
 * then navigate to /submit.html — so the composer reuses the existing
 * sign/broadcast pipeline instead of a second one. Short-form and long-form are
 * the same on-chain object (a top-level comment op with parent_author="").
 */
export default function ShortFormComposer() {
  const { user } = useUserClient();
  const router = useRouter();
  const [text, setText] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // A lite account has no Hive keys, so it cannot sign in-browser: its short
  // post is proxied via /api/lite/posts instead of the Keychain/wax editor.
  const isLite = user.account_tier === 'lite';
  const isExpanded = isFocused || text.length > 0;

  const submitLite = async () => {
    const trimmed = text.trim();
    if (trimmed === '' || submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await createLitePost({ body: trimmed });
    setSubmitting(false);
    if (result.status === 'ok') {
      setText('');
      setIsFocused(false);
      router.refresh();
    } else {
      setError(result.message);
    }
  };

  // Auto-grow the textarea to fit its content (only mounted when expanded).
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [text, isExpanded]);

  // Move focus into the textarea the moment the rest card expands.
  useEffect(() => {
    if (isExpanded) textareaRef.current?.focus();
  }, [isExpanded]);

  if (!user.isLoggedIn) {
    return (
      <DialogLogin>
        <div
          className={cn(
            'cursor-pointer rounded-2xl border border-border/70 bg-background p-6 font-sans text-base text-muted-foreground transition-colors hover:bg-background-secondary'
          )}
        >
          {LABELS.loginPrompt}
        </div>
      </DialogLogin>
    );
  }

  // Hand the draft to the real editor (which reads this key on mount and prefills
  // it), reusing the entire existing broadcast pipeline rather than a second path.
  const openEditor = () => {
    if (text.trim() === '') return;
    setStorageItem(
      `postData-new-${user.username}`,
      {
        title: '',
        postArea: text,
        postSummary: '',
        tags: '',
        author: '',
        category: 'blog',
        beneficiaries: [],
        maxAcceptedPayout: 1000000,
        payoutType: '50%'
      },
      StorageTTL.DRAFT
    );
    router.push(withBasePath(SUBMIT_PATH));
  };

  // REST state — single-line card.
  if (!isExpanded) {
    return (
      <div className="flex items-center gap-4 rounded-[18px] border border-[#ebebeb] bg-white p-[20px_22px] shadow-[0_1px_2px_rgba(20,18,10,0.03)]">
        <Avatar className="h-11 w-11 shrink-0 overflow-hidden rounded-full">
          <AvatarImage
            className="h-full w-full object-cover"
            src={getUserAvatarUrl(user.username, 'small')}
            alt={user.username}
          />
          <AvatarFallback>
            <img
              className="h-full w-full object-cover"
              src={getUserAvatarUrl(user.username, 'small')}
              alt={user.username}
            />
          </AvatarFallback>
        </Avatar>
        <button
          type="button"
          onClick={() => setIsFocused(true)}
          className="flex-1 text-left font-sans text-[19px] text-[#9ca3af]"
        >
          {LABELS.placeholder}
        </button>
        <button
          type="button"
          onClick={() => setIsFocused(true)}
          className="ml-auto rounded-[11px] bg-[#1a1a17] px-[22px] py-[10px] text-sm font-semibold text-white"
        >
          {LABELS.postButton}
        </button>
      </div>
    );
  }

  // EXPANDED state — real editor surface.
  return (
    <div className="rounded-2xl border border-border bg-background p-6 font-sans shadow-sm transition-shadow">
      <div className="flex gap-3">
        <Avatar className="h-11 w-11 shrink-0 overflow-hidden rounded-full">
          <AvatarImage
            className="h-full w-full object-cover"
            src={getUserAvatarUrl(user.username, 'small')}
            alt={user.username}
          />
          <AvatarFallback>
            <img
              className="h-full w-full object-cover"
              src={getUserAvatarUrl(user.username, 'small')}
              alt={user.username}
            />
          </AvatarFallback>
        </Avatar>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder={LABELS.placeholder}
          rows={1}
          className="max-h-80 min-h-[56px] flex-1 resize-none overflow-hidden border-none bg-transparent py-2 font-sans text-[19px] leading-relaxed text-foreground placeholder:text-[#9ca3af] focus:outline-none focus-visible:ring-0"
        />
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-border pl-[56px] pt-3">
        <button
          type="button"
          onClick={openEditor}
          className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {LABELS.fullStory}
        </button>
        <div className="flex items-center gap-3">
          {error ? <span className="text-xs text-red-600">{error}</span> : null}
          <span className="text-xs tabular-nums text-muted-foreground">{text.length}</span>
          <Button
            type="button"
            variant="default"
            size="sm"
            className="rounded-[11px] bg-[#1a1a17] px-[22px] font-semibold text-white hover:bg-[#1a1a17]/90"
            disabled={text.trim() === '' || submitting}
            onClick={isLite ? submitLite : openEditor}
          >
            {submitting ? 'Posting…' : LABELS.postButton}
          </Button>
        </div>
      </div>
    </div>
  );
}
