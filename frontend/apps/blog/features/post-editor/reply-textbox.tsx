import { Link } from '@hive/ui';
import { Button } from '@ui/components/button';
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from '@/blog/i18n/client';
import { Icons } from '@ui/components/icons';
import dynamic from 'next/dynamic';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/tooltip';
import { CircleSpinner } from 'react-spinners-kit';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@hive/ui/components/alert-dialog';
import { Progress } from '@ui/components/progress';
import { Separator } from '@ui/components';

import { DEFAULT_PREFERENCES, hoursAndMinutes, Preferences } from '@/blog/lib/utils';
import { Entry } from '@hive/common-hiveio-packages/wax';
import RendererContainer from '../post-rendering/rendererContainer';
import { getLogger } from '@ui/lib/logging';
import { useCommentMutation, useUpdateCommentMutation } from '../post-rendering/hooks/use-comment-mutations';
import { useQueryClient } from '@tanstack/react-query';
import { createLitePost } from '@/blog/lib/lite/client/lite-write';
import { litePostIdOf } from '@/blog/lib/lite/render/lite-post-id';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { commentClassName } from '../post-rendering/comment-list-item';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { getStorageItem, removeStorageItem, StorageTTL } from '@ui/lib/storage-with-ttl';
import { useStorageWithTTL } from '@ui/hooks/useStorageWithTTL';
import { useLoggedUserContext } from '@/blog/features/votes/hooks/use-logged-user';
import { DRAFT_STATUS_SAVED, DRAFT_STATUS_SAVING } from '@/blog/features/post-editor/lib/composer-copy';
import { DraftStatusIndicator, DraftStatus } from '@/blog/features/post-editor/DraftStatusIndicator';

// ★ item 18: this used to reserve a single 200px box — but the mounted
// MdEditor is THREE bands (EditorToolbar, a `windowheight`-tall CodeMirror
// instance, EditorOptionsBar), not one, so the real thing is ~75-90px taller
// than what this placeholder held open. The gap didn't show up as "slow" — it
// showed up as the whole comment thread visibly jumping down the instant the
// dynamic import resolved, independent of how fast that import was. Each band
// below reuses the real component's own height-bearing classes (EditorToolbar:
// `h-7` buttons + `py-1` = 36px; the editor: `windowheight` itself, 200px,
// matching `use-codemirror.ts`'s `height: ${windowheight}px`; EditorOptionsBar:
// `px-3 py-2` around one content row, ~40px) so the reserved space is derived
// from the real layout, not a second guess. Not pixel-measured live in a
// browser — the shared dev server was under heavy concurrent load for this
// entire session (other agents' jobs from the same build map hammering :3000)
// — so treat these three numbers as a close approximation, not a proven exact
// match; re-measure with the F2 harness once the server is quiet if exactness
// matters.
const MdEditor = dynamic(() => import('./md-editor'), {
  ssr: false,
  loading: () => (
    <div className="w-full" data-testid="reply-editor-loading">
      <div className="h-[37px] rounded-t-md border-x border-t border-border bg-background-secondary/50" />
      <div className="flex h-[200px] w-full items-center justify-center border-x border-border bg-background-secondary/30">
        <CircleSpinner loading size={24} color="#dc2626" />
      </div>
      <div className="h-[40px] border-x border-t border-border bg-background-secondary/50" />
    </div>
  )
});

const logger = getLogger('app');

/**
 * The Resource Credits gauge, in words. Kept beside the component in the same
 * convention the other Lumen surfaces use (`PostPublishingSection`,
 * `user-menu`): newcomer copy lives next to what it describes until the whole
 * lite vocabulary is translated in one pass, rather than half-populating nine
 * locale files. Same two strings as the submit page on purpose — one gauge, one
 * explanation, so the two editors cannot describe it differently.
 */
const RC_LABEL = 'Resource Credits';
// ★ Kept byte-identical to the composer's copy in PostPublishingSection.tsx,
//   including the 2026-08-10 dash removal (C-7): the comment above promises
//   "one gauge, one explanation", and a fix applied to only one of the two
//   copies would quietly break that promise.
const RC_EXPLAINER =
  'Your Hive account’s free allowance for posting, commenting and voting. It refills on its own over time, so you only have to wait if it runs low.';

export function ReplyTextbox({
  onSetReply,
  username,
  permlink,
  parentPermlink,
  storageId,
  editMode,
  comment,
  discussionAuthor,
  discussionPermlink,
  observer
}: {
  onSetReply: (e: boolean) => void;
  username: string;
  permlink: string;
  parentPermlink?: string;
  storageId: string;
  editMode: boolean;
  comment: Entry | string;
  discussionAuthor: string;
  discussionPermlink: string;
  observer: string;
}) {
  const { user, isHydrated } = useUserClient();
  /**
   * Whether to show the Resource Credits gauge at all — see the note beside it.
   * Gated on `isHydrated` as well as the tier because before hydration `user` is
   * still the SSR default, and guessing wrong here means showing a Lumen account
   * the one number this fix exists to stop showing them.
   */
  const showResourceCredits = isHydrated && user.account_tier !== 'lite';
  // Use empty string when user is not logged in to disable storage
  // Different storage keys for reply vs edit mode
  const replyStorageKey = useMemo(
    () => (user.username ? `replyTo-/${username}/${permlink}-${user.username}` : ''),
    [username, permlink, user.username]
  );
  const editStorageKey = useMemo(
    () => (user.username && editMode ? `editDraft-/${username}/${permlink}-${user.username}` : ''),
    [username, permlink, user.username, editMode]
  );
  // Use the appropriate key based on mode
  const storageKey = editMode ? editStorageKey : replyStorageKey;

  // Get the original comment body (works for both Entry object and string)
  const commentBody = typeof comment === 'string' ? comment : (comment?.body ?? '');

  // User preferences are permanent (no TTL) - use empty key when not logged in
  const [preferences] = useStorageWithTTL<Preferences>(
    user.username ? `user-preferences-${user.username}` : '',
    DEFAULT_PREFERENCES,
    StorageTTL.PERMANENT
  );
  const { t } = useTranslation('common_blog');
  // Used to refetch the thread after a lite reply — see the note at that call site.
  const queryClient = useQueryClient();

  // Use hook for draft storage - provides cross-tab sync and SSR safety
  // Both reply and edit modes now use storage (with different keys)
  const [storedDraft, setStoredDraft, removeStoredDraft] = useStorageWithTTL<string>(
    storageKey,
    '',
    StorageTTL.DRAFT
  );

  // Calculate initial text value:
  // - In edit mode: use commentBody (the original content to edit)
  // - In reply mode: start empty
  // Note: storedDraft from localStorage will be applied via useEffect after hydration
  const initialText = editMode ? commentBody : '';

  const [text, setText] = useState(initialText);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  // Track what value we last synced from storage (for cross-tab detection)
  const lastSyncedDraftRef = useRef<string>('');

  // Get the logged-in user's reputation and manabars from context (fetched once via LoggedUserProvider)
  const { reputation, manabarsData } = useLoggedUserContext();

  const commentMutation = useCommentMutation();
  const updateCommentMutation = useUpdateCommentMutation();
  const btnRef = useRef<HTMLButtonElement>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Apply stored draft after hydration (overrides initial text if draft exists)
  // Also handles cross-tab sync when storedDraft changes
  useEffect(() => {
    if (lastSyncedDraftRef.current !== storedDraft) {
      if (storedDraft) {
        // There's a draft in storage - use it (takes priority over initial text)
        setText(storedDraft);
      } else if (editMode && lastSyncedDraftRef.current) {
        // Draft was cleared (e.g., from another tab) - revert to original in edit mode
        setText(commentBody);
      }
      lastSyncedDraftRef.current = storedDraft;
    }
  }, [storedDraft, editMode, commentBody]);

  // Shadow reply recovery — check for orphaned shadow draft from crashed session
  const [shadowReplyRecovery, setShadowReplyRecovery] = useState<{
    key: string;
    body: string;
  } | null>(null);

  useEffect(() => {
    if (editMode || !user.username) return;
    const shadowKey = `shadow-reply-${user.username}-${username}-${permlink}`;
    const item = getStorageItem<{ body: string; parentAuthor: string; parentPermlink: string }>(shadowKey);
    if (item) {
      setShadowReplyRecovery({ key: shadowKey, body: item.body });
    }
  }, [user.username, username, permlink, editMode]);

  // ★★★ A FAILED AUTO-SAVE MUST BE VISIBLE HERE TOO (2026-08-10).
  //
  // `setStorageItem` was taught to report whether the write landed on 2026-08-09,
  // and the composer grew a persistent banner for it (post-form.tsx). This — its
  // sibling, the box every reply and every comment edit is typed into — kept
  // throwing the answer away. Under a full quota or in private browsing the write
  // fails, the box looks exactly like a saved draft, and the reply is gone on
  // reload. Nobody loses a draft because a save failed; they lose it because a
  // failed save looked identical to a successful one.
  //
  // Same treatment as the composer: state, not a toast, because a toast disappears
  // and this stays true until the writer does something about it.
  const [draftSaveFailed, setDraftSaveFailed] = useState(false);

  // Reported once per transition rather than on every 500 ms tick, so a long
  // over-quota session logs one line instead of thousands.
  const reportSave = useCallback((stored: boolean) => {
    setDraftSaveFailed((was) => {
      if (was === !stored) return was;
      if (!stored) logger.error('Reply auto-save failed: the draft did not fit in localStorage');
      return !stored;
    });
  }, []);

  // Debounced save to localStorage (works for both reply and edit modes)
  const saveToStorage = useCallback(
    (value: string) => {
      if (!storageKey) return;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        // In edit mode, only save if different from original
        // In reply mode, save any non-empty value
        if (editMode) {
          if (value && value !== commentBody) {
            reportSave(setStoredDraft(value));
          } else {
            // If same as original or empty, remove draft
            removeStoredDraft();
            // Nothing is pending, so nothing can be unsaved — clearing the banner
            // here is what stops it outliving the text it was about.
            reportSave(true);
          }
        } else {
          if (value) {
            reportSave(setStoredDraft(value));
          } else {
            removeStoredDraft();
            reportSave(true);
          }
        }
      }, 500);
    },
    [storageKey, editMode, commentBody, setStoredDraft, removeStoredDraft, reportSave]
  );

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const removePost = useCallback(() => {
    if (storageKey) {
      removeStoredDraft();
    }
    // The draft is gone on purpose now (sent, or discarded), so a warning about it
    // not being saved is no longer true. The composer had the mirror-image bug —
    // a banner that outlived its subject — and it is not worth reproducing.
    setDraftSaveFailed(false);
  }, [storageKey, removeStoredDraft]);

  const handleCancel = () => {
    // Always remove the reply box state
    removeStorageItem(storageId);

    // Check if there are unsaved changes
    const hasChanges = editMode ? text !== commentBody : text !== '';

    if (!hasChanges) {
      // No changes to save, just close and cleanup any existing draft
      removePost();
      onSetReply(false);
      return;
    }

    // Ask user to confirm discarding their draft
    setCancelDialogOpen(true);
  };

  const handleCancelConfirm = () => {
    removePost();
    onSetReply(false);
    setCancelDialogOpen(false);
  };

  const postComment = async () => {
    try {
      if (btnRef.current) {
        btnRef.current.disabled = true;
      }
      if (parentPermlink && typeof comment !== 'string') {
        const payout =
          comment.max_accepted_payout === '0.000 HBD' ? '0%' : comment.percent_hbd === 0 ? '100%' : '50%';
        const updateCommentParams = {
          parentAuthor: username,
          parentPermlink,
          permlink,
          body: text,
          discussionAuthor,
          discussionPermlink,
          observer
        };
        try {
          await updateCommentMutation.mutateAsync(updateCommentParams);
        } catch (error) {
          handleError(error, { method: 'updateComment', params: updateCommentParams });
          throw error;
        }
      } else if (user.account_tier === 'lite') {
        // Keyless lite account can't sign a comment op — proxy the reply to Hive
        // via /api/lite/posts (frontend account broadcasts it under the parent).
        //
        // ★★★ THE PARENT MUST BE CLASSIFIED, NOT JUST FORWARDED (H5, 2026-08-16).
        //
        // `permlink` is whatever identity the post being replied to is CURRENTLY
        // shown under — and for a lite post that has not reached Hive yet, that is
        // its own synthetic `lite-<id>` (`render/db-post-to-entry.ts`), not a real
        // chain coordinate. Sending it through as `{type: 'chain', author:
        // username, permlink}` let the server pin it VERBATIM as the reply's
        // permanent on-chain parent — permanent because Hive refuses to ever
        // repoint a comment — and `lite-<id>` can never be a valid permlink: the
        // real parent publishes as `lumen-<id>` under the FRONTEND account, never
        // as `lite-<id>` under `username`. That is the exact failure worker.ts's
        // `resolveParentOnChain` documents finding on 2026-08-08 ("the reply's
        // parent read `hbd-temp/lite-<ulid>`"), and what a QA pass reproduced
        // again here: 201, a reply that never appears anywhere, no error shown.
        //
        // `litePostIdOf` recognises both of our own permlink shapes — published
        // (`lumen-<id>`) and not (`lite-<id>`) — and recovers the row id, which is
        // what `{type: 'lite', id}` needs: the server derives the real,
        // deterministic on-chain coordinate itself instead of trusting a name
        // captured client-side. A genuine reply to someone else's real chain post
        // still falls through to `type: 'chain'` exactly as before.
        const liteParentId = litePostIdOf({ permlink });
        const result = await createLitePost({
          body: text,
          parentRef: liteParentId
            ? { type: 'lite', id: liteParentId }
            : { type: 'chain', author: username, permlink }
        });
        if (result.status !== 'ok') {
          handleError(new Error(result.message), { method: 'lite-comment', params: { username, permlink } });
          throw new Error(result.message);
        }
        // ★ SAY SOMETHING, AND SAY THE TRUE THING.
        //
        // A lite reply is accepted here and BROADCAST LATER by the publisher
        // account, so for a short while it genuinely is not in the thread yet.
        // The reply box simply closed and the comment count did not move, which
        // a UX tester read — reasonably — as the reply having vanished. Root
        // posts have confirmed since this morning; replies never did. The wait
        // is real, so the message names it rather than claiming it is already
        // there.
        /*
         * ★ AND THEN SHOW IT (2026-08-16, found by a QA pass driving a reply).
         *
         * The comment above says a lite reply "genuinely is not in the thread
         * yet". That was true of the CHAIN, and it is what the toast honestly
         * reports — but it is not true of this page: the QA run posted a reply,
         * got 201, saw nothing, RELOADED, and the reply was there, carrying its
         * "Queued to publish to Hive" badge. So the thread can already render
         * it, in the right state; the only thing missing was asking for it.
         *
         * Leaving it out means the visible result of replying is that the box
         * closes and nothing changes — which a UX tester already read as the
         * reply vanishing, and which this file's own comment cites as the reason
         * the toast exists. A toast explaining an absence is a worse answer than
         * not having the absence.
         *
         * Invalidate rather than optimistically insert: the server decides the
         * permlink, the badge state and the ordering, and this path has no
         * rollback story. One refetch of the thread it is already looking at.
         */
        queryClient.invalidateQueries({ queryKey: ['discussionData'] });
        // ★ `liteReplies` IS A SEPARATE QUERY FROM `discussionData` (H5,
        // 2026-08-16). `content.tsx` merges two sources into the thread: the
        // chain-backed `discussionData` above, and this post's own lite replies,
        // fetched under `['liteReplies', author, permlink, parentKeys.length]`.
        // Invalidating only the first left a just-posted reply waiting on
        // `staleTime` to elapse on its own — invisible until either that expired
        // or the reader reloaded. `discussionAuthor`/`discussionPermlink` are the
        // same thread identity `author`/`permlink` is keyed on there; the
        // trailing `parentKeys.length` is left off on purpose so this matches
        // every variant of the key (React Query v4 prefix-matches array keys).
        queryClient.invalidateQueries({ queryKey: ['liteReplies', discussionAuthor, discussionPermlink] });
        toast({
          title: 'Reply sent',
          // ★ NO TIME PROMISE (2026-08-13). This said "usually within a minute".
          // That is only true while the publisher is draining, and it has not drained
          // since 9 August — a real reply sat on "Publishing…" for over 24 hours
          // having been told to expect a minute. Say what is true (it is saved, it
          // is queued) and let the badge on the reply itself report the state.
          description: 'It is saved and queued to publish to Hive.',
          variant: 'success'
        });
      } else {
        const commentParams = {
          parentAuthor: username,
          parentPermlink: permlink,
          body: text,
          preferences,
          reputation,
          discussionAuthor,
          discussionPermlink,
          observer
        };
        try {
          await commentMutation.mutateAsync(commentParams);
        } catch (error) {
          handleError(error, { method: 'comment', params: commentParams });
          throw error;
        }
      }
      setText('');
      removePost(); // Remove stored comment text
      removeStorageItem(storageId); // Remove reply box state
      onSetReply(false);
      if (btnRef.current) {
        btnRef.current.disabled = true;
      }
    } catch (error) {
      if (btnRef.current) {
        btnRef.current.disabled = false;
      }
      logger.error(error);
    }
  };

  /* ★ THE SAME LIVE "DRAFT SAVED" CUE AS THE COMPOSER (owner, 2026-09-02).
     `saveToStorage` already debounces a 500 ms write to `replyTo-…` /
     `editDraft-…`; `storedDraft` is the reactive `useStorageWithTTL` value that
     write lands in, so `storedDraft === text` is true exactly when the on-screen
     reply is in storage. A reply must have real content to be "saving" (in edit
     mode, real content means changed from the original — an unchanged edit stores
     nothing, so it stays idle); the red "not being saved" banner owns failures,
     so the quiet cue steps aside while it shows. */
  const replyHasContent = editMode ? text.trim() !== '' && text !== commentBody : text.trim() !== '';
  const replyDraftStatus: DraftStatus =
    draftSaveFailed || !replyHasContent ? 'idle' : storedDraft === text ? 'saved' : 'saving';

  return (
    <div
      className="mb-4 flex w-full flex-col gap-4 rounded-lg border border-border bg-background p-4 text-primary shadow-sm"
      data-testid="reply-editor"
      suppressHydrationWarning
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between rounded-md bg-background-secondary px-3 py-1.5">
          <span className="text-caption text-muted-foreground">
            {editMode ? t('post_content.footer.comment.editing') : t('post_content.footer.comment.replying')}
          </span>
          <Button
            type="button"
            variant="ghost"
            className="h-auto px-2 py-1 text-caption text-muted-foreground hover:text-foreground"
            onClick={() => handleCancel()}
          >
            {t('post_content.footer.comment.disable_editor')}
          </Button>
        </div>

        {shadowReplyRecovery && (
          <div className="flex items-center justify-between rounded-md bg-amber-50 px-3 py-2 text-sm">
            <span className="text-foreground/80">{t('post_content.footer.comment.shadow_draft_found')}</span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto px-2 py-1 text-caption"
                onClick={() => {
                  setText(shadowReplyRecovery.body);
                  saveToStorage(shadowReplyRecovery.body);
                  removeStorageItem(shadowReplyRecovery.key);
                  setShadowReplyRecovery(null);
                }}
              >
                {t('post_content.footer.comment.shadow_draft_recover')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto px-2 py-1 text-caption"
                onClick={() => {
                  removeStorageItem(shadowReplyRecovery.key);
                  setShadowReplyRecovery(null);
                }}
              >
                {t('post_content.footer.comment.shadow_draft_discard')}
              </Button>
            </div>
          </div>
        )}

        {draftSaveFailed ? (
          <div
            role="alert"
            data-testid="reply-draft-save-failed"
            className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
          >
            <strong className="font-semibold">This reply is not being saved.</strong> Your browser has no room
            to store it, so it will be lost if you close or reload this tab. Post it now, or copy your text
            somewhere safe.
          </div>
        ) : null}

        <div>
          <MdEditor
            windowheight={200}
            onChange={(value) => {
              setText(value);
              saveToStorage(value);
            }}
            persistedValue={text}
            placeholder={t('post_content.footer.comment.reply')}
            ariaLabel={t('post_content.footer.comment.reply')}
          />
          <div className="flex items-center justify-between gap-3 rounded-b-md border-x border-b border-border bg-background-secondary/50 px-3 py-1.5 text-caption text-muted-foreground">
            <span className="flex min-w-0 items-center">
              {t('post_content.footer.comment.insert_images')} {t('post_content.footer.comment.selecting_them')}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <Icons.info className="ml-1 w-3" />
                  </TooltipTrigger>
                  <TooltipContent>{t('submit_page.insert_images_info')}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </span>
            {/* ★ The live draft-save cue, identical to the long-form composer. */}
            <DraftStatusIndicator
              status={replyDraftStatus}
              savingLabel={DRAFT_STATUS_SAVING}
              savedLabel={DRAFT_STATUS_SAVED}
              className="shrink-0"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button
              ref={btnRef}
              variant="redHover"
              className="w-24"
              // ★ Trim, and strip zero-width characters, before deciding it is
              //   empty. `text === ''` let a reply of four spaces and a
              //   zero-width space through to a 201 — invisible content posted
              //   under your name. The composer and editor were fixed this
              //   morning; the reply box kept the old test.
              disabled={
                text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim() === '' ||
                commentMutation.isLoading ||
                updateCommentMutation.isLoading
              }
              onClick={() => postComment()}
            >
              {commentMutation.isLoading || updateCommentMutation.isLoading ? (
                <CircleSpinner
                  loading={commentMutation.isLoading || updateCommentMutation.isLoading}
                  size={18}
                  color="#dc2626"
                />
              ) : (
                t('post_content.footer.comment.post')
              )}
            </Button>
            <Button
              variant="ghost"
              disabled={commentMutation.isLoading || updateCommentMutation.isLoading}
              onClick={() => handleCancel()}
              className="text-foreground/60 hover:text-destructive"
            >
              {t('post_content.footer.comment.cancel')}
            </Button>
          </div>

          {/* ★★★ NOT SHOWN TO A LUMEN ACCOUNT, AND NAMED FOR EVERYONE ELSE
              (2026-08-08, UX tester on the new-user path).

              A lite account has no Hive account, so `manabarsData` is undefined
              for it and this rendered a full-width "0% RC" gauge, pinned at
              zero, directly beside the Reply button — the first thing a
              newcomer meets when they try to answer someone. It is not merely
              unexplained: it is a zero about a chain account they do not have,
              and it reads as "you have no capacity to post" at the exact moment
              they are deciding whether this place works. Their replies do not
              spend their RC at all; the publisher account's RC is what pays,
              and that is not theirs to see or act on.

              For a Hive-keyed account the number IS theirs and does gate
              replying, so it stays — but "RC" alone is Hive jargon, so the
              label spells it out and the tooltip says what it means in one
              sentence. `title` as well as the tooltip, so it is not
              mouse-only. */}
          {showResourceCredits ? (
            <div className="flex items-center gap-3">
              {/* ★ The SECOND copy of the same off-palette bar (2026-08-10, C-6).
                  The composer's Resource Credits gauge was `bg-[#0088FE]`,
                  measured rgb(0,136,254), and blue appears nowhere else in
                  Lumen. Fixing only the composer would have left the identical
                  bar blue two clicks away, so both move to brand red on a
                  neutral track together. */}
              {/* ★ `bg-surface-brand-12`, not `#c0392b` (2026-08-14
                  token-migration pass) — rgb(192,57,43), byte-identical to the
                  literal in light mode; same token `PostPublishingSection.tsx`
                  uses for the identical gauge in the composer. */}
              <Progress
                value={manabarsData?.rc.percentageValue ?? 0}
                className="h-2 w-20 bg-[#ebebeb]"
                indicatorClassName="bg-surface-brand-12"
              />
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="cursor-help text-caption text-muted-foreground"
                      title={RC_EXPLAINER}
                      data-testid="reply-resource-credits"
                    >
                      <span className="tabular-nums">{manabarsData?.rc.percentageValue ?? 0}%</span>{' '}
                      {RC_LABEL}
                      {manabarsData?.rc.percentageValue !== 100 && manabarsData?.rc.cooldown ? (
                        <span className="ml-1 text-muted-foreground/60">
                          ({hoursAndMinutes(manabarsData.rc.cooldown, t)})
                        </span>
                      ) : null}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[260px] text-caption">{RC_EXPLAINER}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          ) : null}
        </div>
      </div>

      <Separator />

      <div className="flex flex-col">
        <div className="flex items-center justify-between rounded-t-lg border border-b-0 border-border bg-background-secondary/50 px-3 py-1.5">
          <span className="text-label font-medium uppercase tracking-wider text-muted-foreground">
            {t('post_content.footer.comment.preview')}
          </span>
          <div className="flex items-center gap-3 text-caption">
            {editMode || preferences.comment_rewards === '50%' ? null : (
              <span className="text-muted-foreground">
                {t('post_content.footer.comment.rewards')}
                {preferences.comment_rewards === '0%'
                  ? t('post_content.footer.comment.decline_payout')
                  : t('post_content.footer.comment.power_up')}{' '}
                <Link className="text-destructive hover:underline" href={`/@${user.username}/settings`}>
                  {t('post_content.footer.comment.update_settings')}
                </Link>
              </span>
            )}
            <Link href="https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax">
              <span className="text-muted-foreground transition-colors hover:text-destructive">
                {t('post_content.footer.comment.markdown_styling_guide')}
              </span>
            </Link>
          </div>
        </div>
        <div className="rounded-b-lg border border-border">
          {text ? (
            <RendererContainer
              body={text}
              author=""
              previewMode
              className={commentClassName + ' max-w-full p-3'}
            />
          ) : (
            <div className="flex w-full flex-col items-center justify-center gap-2 p-6 text-muted-foreground">
              <Icons.eye className="h-6 w-6 opacity-20" />
              <span className="text-caption">{t('submit_page.preview_placeholder')}</span>
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('post_content.footer.comment.exit_editor')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('post_content.footer.comment.exit_editor_description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('post_content.footer.comment.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancelConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('post_content.footer.comment.discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
