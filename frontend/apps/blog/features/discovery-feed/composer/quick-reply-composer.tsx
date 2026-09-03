'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useQueryClient } from '@tanstack/react-query';
import type { Entry } from '@hive/common-hiveio-packages/wax';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { UserAvatarImg } from '@ui/components';
import { cn } from '@ui/lib/utils';
import { toast } from '@ui/components/hooks/use-toast';
import { useTranslation } from '@/blog/i18n/client';
import { IMAGE_ACCEPT, MAX_IMAGE_BYTES } from '@/blog/components/hooks/use-image-upload';
import { useStorageWithTTL } from '@ui/hooks/useStorageWithTTL';
import { StorageTTL } from '@ui/lib/storage-with-ttl';
import { DEFAULT_PREFERENCES, type Preferences } from '@/blog/lib/utils';
import { useLoggedUserContext } from '@/blog/features/votes/hooks/use-logged-user';
import { scheduleValidatedRefetch } from '@/blog/lib/react-query';
import { fetchDiscussion } from '@/blog/lib/lite/client/discussion-fetch';
import ComposerFooter from './composer-footer';
import ComposerMediaStrip from './composer-media-strip';
import { useComposerDraft } from './use-composer-draft';
import { MAX_IMAGES, useComposerImages, type ImageIssue } from './use-composer-images';
import { MAX_NOTE_LENGTH, toggleMarkerWrap } from './marker-wrap';
import { useReplyPublish } from './use-reply-publish';
import { discussionKey } from '../lib/top-comment';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * QUICK REPLY IN THE FEED DRAWER — the EXPANDED-STATE MIRROR of the quick-post
 * "What's on your mind?" box (`short-form-composer.tsx`), one substitution:
 * the broadcast is a COMMENT under a parent instead of a root post, and success
 * updates the thread in place instead of navigating (QUICK-REPLY-SPEC §3).
 *
 * ★★★ MIRROR, ADD NOTHING. Every shared piece is IMPORTED, not copied —
 * `ComposerFooter`, `ComposerMediaStrip`, the dynamic `EmojiPicker`,
 * `useComposerImages`, `useComposerDraft`, `MAX_NOTE_LENGTH` + `toggleMarkerWrap`
 * (`marker-wrap.ts`) — so the reply cannot drift from the quick-post. The JSX
 * skeleton below is transcribed from `short-form-composer.tsx:384-537` (the
 * expanded state) minus the collapsed card and the `DialogLogin` wrapper; the
 * drag-state card chrome is kept identical.
 *
 * The ONLY new logic vs the quick-post: no collapsed state (mount = expanded +
 * focused), `onClose` when it empties out and loses focus (the analog of the
 * quick-post's collapse), and the publish/success swap (`useReplyPublish` + the
 * drawer-cache insert, §4).
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ★ Same as the quick-post: the picker's ~9KB data table stays out of the bundle
//   until the emoji button is pressed. Already behind `dynamic()` there; kept so.
const EmojiPicker = dynamic(() => import('./emoji-picker'), { ssr: false });

/** Reason code -> i18n key — the SAME map the quick-post uses. */
const ISSUE_KEYS: Record<ImageIssue, string> = {
  'too-many': 'too_many_images',
  'too-large': 'image_too_large',
  'not-an-image': 'image_not_an_image',
  'upload-failed': 'image_upload_failed',
  blocked: 'image_blocked'
};

/**
 * One in-flight reconcile per THREAD — the module-level mirror of
 * `useCommentMutation`'s `cleanupRef` (use-comment-mutations.ts:34, :52): a
 * second reply posted into the same thread cancels the previous
 * validated-refetch schedule, so an OLDER snapshot (validated by the first
 * reply, fetched before the second indexed) can never land on top of a newer
 * optimistic insert. Module-level because each composer instance unmounts on
 * close while its reconcile must keep running.
 */
const pendingReconciles = new Map<string, () => void>();

export interface QuickReplyComposerProps {
  /** The comment being replied to (the top comment's `.entry`, or a thread node's). */
  parent: Entry;
  /** The POST's author + permlink — the thread's cache identity (§4.3). */
  rootAuthor: string;
  rootPermlink: string;
  /** Sets `activeReplyKey = null` in the drawer. */
  onClose: () => void;
}

export default function QuickReplyComposer({ parent, rootAuthor, rootPermlink, onClose }: QuickReplyComposerProps) {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const identity = useSessionIdentity();
  const queryClient = useQueryClient();
  const { reputation } = useLoggedUserContext();

  const [text, setText] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** Set once the reader has actually touched the composer — guards the draft restore. */
  const dirtyRef = useRef(false);
  const textareaId = useId();

  const isLite = user.account_tier === 'lite';
  const displayUsername = user.username || identity.username;

  // ★ Draft keyed PER PARENT COMMENT (§5), so switching targets never loses text.
  //   Empty username -> '' -> the hook disables itself, same as the quick-post.
  //   '/' as the FIELD delimiter (2026-09-03 review F11): it is illegal in Hive
  //   usernames and permlinks, so two different (user, author, permlink) triples
  //   can never collide on one key the way '-' joins could — usernames and
  //   permlinks legally contain '-'.
  const draftKey = user.username
    ? `lumen-reply-draft-${user.username}/${parent.author}/${parent.permlink}`
    : '';
  const { draft, save: saveDraft, clear: clearDraft } = useComposerDraft(user.username, draftKey);
  const { publish, cancel, submitting } = useReplyPublish({ isLite });

  // Same read the shipped reply path does (`reply-textbox.tsx:135-139`): the
  // stored reward-split preference, honored in the broadcast (§4.2).
  const [preferences] = useStorageWithTTL<Preferences>(
    user.username ? `user-preferences-${user.username}` : '',
    DEFAULT_PREFERENCES,
    StorageTTL.PERMANENT
  );

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
  }, []);

  const insertAtCaret = useCallback(
    (snippet: string) => {
      const textarea = textareaRef.current;
      setText((current) => {
        const start = textarea?.selectionStart ?? current.length;
        const end = textarea?.selectionEnd ?? current.length;
        requestAnimationFrame(() => {
          if (!textarea) return;
          textarea.focus();
          const caret = start + snippet.length;
          textarea.setSelectionRange(caret, caret);
        });
        return current.slice(0, start) + snippet + current.slice(end);
      });
      markDirty();
    },
    [markDirty]
  );

  const wrapSelection = useCallback(
    (marker: string) => {
      const textarea = textareaRef.current;
      setText((current) => {
        const start = textarea?.selectionStart ?? current.length;
        const end = textarea?.selectionEnd ?? current.length;
        const result = toggleMarkerWrap(current, start, end, marker);
        requestAnimationFrame(() => {
          if (!textarea) return;
          textarea.focus();
          textarea.setSelectionRange(result.selectionStart, result.selectionEnd);
        });
        return result.text;
      });
      markDirty();
    },
    [markDirty]
  );

  const images = useComposerImages({
    insertSnippet: insertAtCaret,
    onDirty: markDirty,
    onStatus: (next) =>
      setStatus(next ? t(`short_form_composer.${next === 'uploading' ? 'uploading' : 'uploaded'}`) : null),
    onIssue: (issue, name) =>
      setError(
        t(`short_form_composer.${ISSUE_KEYS[issue]}`, {
          name,
          max: MAX_IMAGES,
          limit: Math.round(MAX_IMAGE_BYTES / (1024 * 1024))
        })
      )
  });

  const overLimit = text.length > MAX_NOTE_LENGTH;

  /* -------------------- draft: restore once, then save (mirror) -------------------- */
  const restoreMedia = images.setMedia;
  useEffect(() => {
    // Same guard as the quick-post: not "ran once" but "there is something to
    // restore and the reader has not started typing" — the storage read can
    // legitimately arrive a microtask after mount.
    if (dirtyRef.current) return;
    if (!draft || (draft.body === '' && draft.media.length === 0)) return;
    dirtyRef.current = true;
    setText(draft.body);
    restoreMedia(draft.media);
  }, [draft, restoreMedia]);

  useEffect(() => {
    if (!dirtyRef.current) return;
    saveDraft({ body: text, media: images.media });
  }, [text, images.media, saveDraft]);

  /* -------------------- textarea auto-grow (mirror) -------------------- */
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [text]);

  /**
   * Focus the textarea on mount — the composer only mounts when the READER clicks
   * Reply, so this is the analog of the quick-post's `expandAndFocus` (§6.7):
   * focus on a reader action, never on a draft restore (the restore effect above
   * only sets text, it never focuses).
   */
  useEffect(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  /**
   * ★ RETURN FOCUS TO THE REPLY BUTTON when this composer closes (a11y, review
   * F10). Closing via the Reply toggle or a successful publish removes the
   * focused textarea along with the composer, and without this the reader's
   * keyboard position falls to the top of the document. Guards, in order:
   *  - `skipFocusReturnRef`: the blur-when-empty close means the reader
   *    DELIBERATELY moved focus elsewhere — never steal it back on that path.
   *  - the activeElement check: focus is ours to return only when it sits
   *    INSIDE the composer being removed (effect cleanup runs before React
   *    detaches the DOM) or has already been dropped on <body>.
   * The button is found by the `data-reply-key` its mount points stamp on it
   * (`top-comment-drawer.tsx` / `top-comment-thread.tsx`).
   */
  const skipFocusReturnRef = useRef(false);
  useEffect(() => {
    const replyKey = discussionKey(parent.author, parent.permlink);
    const root = rootRef.current;
    return () => {
      if (skipFocusReturnRef.current) return;
      const active = document.activeElement;
      if (active && active !== document.body && !(root && root.contains(active))) return;
      document
        .querySelector<HTMLButtonElement>(`[data-testid="quick-reply-button"][data-reply-key="${replyKey}"]`)
        ?.focus();
    };
  }, [parent.author, parent.permlink]);

  /**
   * ★ CLOSE WHEN EMPTY AND FOCUS LEAVES — the analog of the quick-post's
   * collapse (§3.1). The quick-post folds back to its card when `!isFocused &&
   * text==='' && media==[] && !emojiOpen && !uploading`; the reply has no card to
   * fold to, so the same condition calls `onClose`. Deferred a frame so focus
   * moving to an intra-composer control (a toolbar button, the emoji search) does
   * not read as leaving. The toolbar buttons `preventDefault` on mousedown
   * (`composer-action.tsx`), so a click on them never blurs the textarea at all —
   * this only fires on a genuine click away from an empty composer.
   */
  const handleBlur = useCallback(() => {
    requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) return;
      if (root.contains(document.activeElement)) return;
      if (submitting || emojiOpen || images.uploading) return;
      if (text.trim() !== '' || images.media.length > 0) return;
      // The reader clicked AWAY from an empty composer — closing must not yank
      // their focus back to the Reply button (see the focus-return effect).
      skipFocusReturnRef.current = true;
      onClose();
    });
  }, [submitting, emojiOpen, images.uploading, images.media.length, text, onClose]);

  /* -------------------- publish (comment, not root post) -------------------- */
  /**
   * ★ MAKE THE REPLY APPEAR IN THE DRAWER (§4.3.1). The drawer renders from its
   * OWN query `['post-card-top-comment', rootKey]` (`use-visible-discussion.ts`),
   * NOT from `['discussionData', …]` that `useCommentMutation` seeds — so we insert
   * an optimistic node of the same shape the mutation builds
   * (`use-comment-mutations.ts:77-113`), with `parent_author`/`parent_permlink`
   * set to the TARGET comment (what `deriveThread` keys children by) and the
   * parent's `children` bumped. Do NOT refetch immediately: the broadcast is
   * `observe:false` and Hivemind lags, so a same-tick fetch would return a thread
   * WITHOUT the reply — the silent-success shape this codebase has paid for. The
   * scheduled invalidate below reconciles the temp entry once indexed.
   */
  const insertOptimisticReply = useCallback(
    (body: string) => {
      const cacheKey = ['post-card-top-comment', discussionKey(rootAuthor, rootPermlink)];
      const parentKey = discussionKey(parent.author, parent.permlink);
      const tempPermlink = `re-${parent.author}-${Date.now()}`;
      const tempKey = discussionKey(user.username, tempPermlink);

      queryClient.setQueryData<Record<string, Entry>>(cacheKey, (old) => {
        // Nothing cached yet (drawer never fetched) — the scheduled invalidate
        // below will fetch fresh; there is nothing to insert into.
        if (!old) return old;
        const parentEntry = old[parentKey];
        const next: Record<string, Entry> = {};
        for (const [key, entry] of Object.entries(old)) {
          next[key] = key === parentKey ? { ...entry, children: (entry.children || 0) + 1 } : entry;
        }
        const optimistic = {
          active_votes: [],
          author: user.username,
          author_payout_value: '0.000 HBD',
          author_reputation: reputation,
          beneficiaries: [],
          blacklists: [],
          body,
          parent_author: parent.author,
          parent_permlink: parent.permlink,
          category: parentEntry?.category ?? '',
          children: 0,
          created: new Date().toISOString(),
          curator_payout_value: '0.000 HBD',
          depth: (parentEntry?.depth ?? 0) + 1,
          is_paidout: false,
          json_metadata: { images: [], author: user.username, image: '' },
          max_accepted_payout: '1000000.000 HBD',
          net_rshares: 0,
          payout: 0,
          payout_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          pending_payout_value: '0.000 HBD',
          percent_hbd: 10000,
          permlink: tempPermlink,
          post_id: Date.now(),
          promoted: '',
          replies: [],
          stats: { hide: false, gray: false, total_votes: 0, flag_weight: 0 },
          title: '',
          updated: new Date().toISOString(),
          url: `/${parentEntry?.category ?? ''}/@${user.username}/${tempPermlink}`,
          _optimistic: true
        };
        next[tempKey] = optimistic as Entry;
        return next;
      });
    },
    [queryClient, rootAuthor, rootPermlink, parent.author, parent.permlink, user.username, reputation]
  );

  const submit = async () => {
    const trimmed = text.trim();
    if (trimmed === '' || submitting || overLimit || images.uploading) return;
    setError(null);
    setStatus(t('short_form_composer.publishing'));
    const outcome = await publish(
      {
        parentAuthor: parent.author,
        parentPermlink: parent.permlink,
        rootAuthor,
        rootPermlink,
        body: trimmed,
        preferences,
        reputation,
        observer: user.username
      },
      {
        timedOut: t('short_form_composer.timed_out'),
        cancelled: t('short_form_composer.cancelled'),
        generic: t('short_form_composer.generic_error')
      }
    );
    setStatus(null);
    if (!outcome.ok) {
      // Mirror the quick-post: show the failure under the toolbar, keep the text.
      setError(outcome.message);
      return;
    }

    // ★ SUCCESS: make it visible in the thread, then close (§4.3).
    const rootKey = discussionKey(rootAuthor, rootPermlink);
    const cacheKey = ['post-card-top-comment', rootKey];
    if (isLite) {
      // No optimistic insert — the server decides permlink/badge/ordering and
      // there is no rollback story (§4.3.3). NOTE (corrected 2026-09-03, review
      // F14): the POST PAGE does show a queued lite reply immediately — it
      // merges a separate `['liteReplies', …]` query into its thread
      // (reply-textbox.tsx:390-404 / content.tsx). The drawer deliberately
      // carries no `liteReplies` query, so HERE the reply appears only once the
      // publisher broadcasts it to chain; the toast below names that wait
      // honestly instead of pretending the thread already shows it.
      queryClient.invalidateQueries({ queryKey: cacheKey });
    } else {
      // ★★★ CANCEL → INSERT → VALIDATED RECONCILE, never a blind invalidate
      // (2026-09-03 review F1). `scheduleInvalidations` here was the exact
      // hazard `lib/react-query.ts:71-84` documents: its first blind refetch at
      // 8s lands inside Hivemind's own 8-30s indexing lag, so a stale response
      // would REPLACE this map and vanish the reply the reader just watched
      // appear. So: cancel any in-flight fetch first (a stale response landing
      // after the insert would clobber it — same reason the mutation calls
      // cancelQueries in onMutate, use-comment-mutations.ts:56), insert, then
      // reconcile with `scheduleValidatedRefetch`, which only writes fresh data
      // once it actually CONTAINS the new reply — the same lifecycle
      // `useCommentMutation` runs for its own optimistic key (:199-224).
      await queryClient.cancelQueries({ queryKey: cacheKey });
      // Count the reader's REAL (non-optimistic) replies under this parent
      // BEFORE scheduling, so an OLDER reply of theirs cannot satisfy the
      // validator and let an early snapshot wipe the new one — the exact
      // `prevRealCommentCount` guard the mutation uses (:200-205).
      const prev = queryClient.getQueryData<Record<string, Entry>>(cacheKey);
      const prevRealCount = prev
        ? Object.values(prev).filter(
            (e) =>
              e.author === user.username &&
              e.parent_author === parent.author &&
              e.parent_permlink === parent.permlink &&
              !(e as Entry & { _optimistic?: boolean })._optimistic
          ).length
        : 0;
      insertOptimisticReply(trimmed);
      // One reconcile per thread: a second reply into the same thread cancels
      // the previous schedule (see `pendingReconciles` above).
      pendingReconciles.get(rootKey)?.();
      pendingReconciles.set(
        rootKey,
        scheduleValidatedRefetch(
          queryClient,
          cacheKey,
          // The same observer-less read the drawer's own query performs
          // (use-visible-discussion.ts:54) — the validated data must be shaped
          // exactly like what the query itself would fetch.
          () => fetchDiscussion(rootAuthor, rootPermlink),
          (freshData) => {
            if (!freshData) return false;
            const real = Object.values(freshData).filter(
              (e) =>
                e.author === user.username &&
                e.parent_author === parent.author &&
                e.parent_permlink === parent.permlink
            );
            return real.length > prevRealCount;
          }
        )
      );
    }

    // Clear + drop the draft + close, mirroring the quick-post's success.
    setText('');
    images.setMedia([]);
    setEmojiOpen(false);
    dirtyRef.current = false;
    clearDraft();
    toast({
      title: t('short_form_composer.reply_published_title'),
      description: isLite
        ? t('short_form_composer.reply_published_lite')
        : t('short_form_composer.reply_published_hive'),
      variant: 'success'
    });
    onClose();
  };

  /* -------------------- render (expanded state, transcribed) -------------------- */
  return (
    <div
      ref={rootRef}
      data-testid="quick-reply-composer"
      data-state="expanded"
      onDragOver={(event) => {
        if (event.dataTransfer?.types?.includes('Files')) {
          event.preventDefault();
          setDragActive(true);
        }
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => {
        setDragActive(false);
        const files = images.filesFromTransfer(event.dataTransfer);
        if (files.length === 0) return;
        event.preventDefault();
        void images.handleFiles(files);
      }}
      className={cn(
        'rounded-panel border bg-white p-[20px_22px] font-sans shadow-[0_1px_2px_rgba(26,22,18,0.035),0_3px_12px_-6px_rgba(70,46,30,0.13)] transition-colors',
        dragActive ? 'border-dashed border-line-brand-10/40' : 'border-[#ebebeb]'
      )}
    >
      <div className="flex gap-3">
        <UserAvatarImg username={displayUsername} pixelSize={44} alt={displayUsername} />
        <textarea
          ref={textareaRef}
          id={textareaId}
          name="quick-reply-note"
          aria-label={t('short_form_composer.reply_aria_label')}
          aria-busy={submitting}
          value={text}
          onChange={(event) => {
            markDirty();
            setText(event.target.value);
          }}
          onBlur={handleBlur}
          onPaste={(event) => {
            const files = images.filesFromTransfer(event.clipboardData);
            if (files.length === 0) return;
            event.preventDefault();
            void images.handleFiles(files);
          }}
          onKeyDown={(event) => {
            // Escape closes an open picker BEFORE it does anything else.
            if (event.key === 'Escape' && emojiOpen) {
              event.preventDefault();
              setEmojiOpen(false);
              return;
            }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={t('short_form_composer.reply_placeholder')}
          rows={1}
          className="max-h-[420px] min-h-[56px] flex-1 resize-none overflow-y-auto border-none bg-transparent py-2 font-sans text-[18px] leading-[30px] text-foreground placeholder:text-ink-14 focus:outline-none focus-visible:ring-0"
        />
      </div>

      <input
        ref={fileRef}
        type="file"
        className="hidden"
        multiple
        accept={IMAGE_ACCEPT}
        data-testid="quick-reply-composer-file-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          void images.handleFiles(files);
        }}
      />

      <ComposerMediaStrip
        media={images.media}
        pendingCount={images.pendingCount}
        removeLabel={t('short_form_composer.remove_image')}
        onRemove={(url) => images.removeMedia(url, setText)}
        testIdPrefix="quick-reply-composer"
      />

      <ComposerFooter
        testIdPrefix="quick-reply-composer"
        labels={{
          bold: t('short_form_composer.bold'),
          italic: t('short_form_composer.italic'),
          addImage: t('short_form_composer.add_image'),
          addEmoji: t('short_form_composer.add_emoji'),
          post: t('short_form_composer.post_button'),
          posting: t('short_form_composer.posting_button'),
          cancel: t('short_form_composer.cancel')
        }}
        count={text.length}
        limit={MAX_NOTE_LENGTH}
        overLimit={overLimit}
        submitting={submitting}
        canSubmit={text.trim() !== ''}
        uploading={images.uploading}
        emojiOpen={emojiOpen}
        onToggleBold={() => wrapSelection('**')}
        onToggleItalic={() => wrapSelection('*')}
        onOpenFilePicker={() => fileRef.current?.click()}
        onToggleEmoji={() => setEmojiOpen((open) => !open)}
        onSubmit={() => void submit()}
        onCancel={cancel}
        picker={
          emojiOpen ? (
            <EmojiPicker
              onSelect={insertAtCaret}
              onClose={() => setEmojiOpen(false)}
              /* ★ The drawer is a fixed-height `overflow:hidden` box; the
                 picker's normal `absolute` placement would be CLIPPED at the
                 drawer's edge (review F3). `fixedPosition` keeps it in the SAME
                 DOM spot (focus-within, blur containment and outside-click all
                 unchanged) but positions it against the viewport, which
                 `overflow:hidden` ancestors cannot clip — safe here because no
                 ancestor of the composer carries a transform/filter (verified
                 2026-09-03: .card hovers with shadow only, no feed
                 virtualization). */
              fixedPosition
              testIdPrefix="quick-reply-composer"
              labels={{
                searchLabel: t('short_form_composer.emoji_search_label'),
                searchPlaceholder: t('short_form_composer.emoji_search_placeholder'),
                noResults: t('short_form_composer.emoji_no_results'),
                recent: t('short_form_composer.emoji_recent')
              }}
            />
          ) : null
        }
      />

      {overLimit ? (
        <p
          className="mt-2 pl-[56px] font-sans text-caption text-ink-brand-6"
          data-testid="quick-reply-composer-over-limit"
        >
          {t('short_form_composer.over_limit', {
            limit: MAX_NOTE_LENGTH,
            over: text.length - MAX_NOTE_LENGTH
          })}
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 pl-[56px] font-sans text-caption text-ink-brand-6" data-testid="quick-reply-composer-error">
          {error}
        </p>
      ) : null}
      {/* Upload and publish progress, announced rather than only drawn. */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="quick-reply-composer-status">
        {status ?? ''}
      </p>
    </div>
  );
}
