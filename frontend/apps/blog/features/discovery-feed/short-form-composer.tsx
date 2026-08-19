'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { UserAvatarImg } from '@ui/components';
import { cn } from '@ui/lib/utils';
import { toast } from '@ui/components/hooks/use-toast';
import DialogLogin from '@/blog/components/dialog-login';
import { useTranslation } from '@/blog/i18n/client';
import { IMAGE_ACCEPT, MAX_IMAGE_BYTES } from '@/blog/components/hooks/use-image-upload';
import ComposerFooter from './composer/composer-footer';
import ComposerMediaStrip from './composer/composer-media-strip';
import { useComposerDraft } from './composer/use-composer-draft';
import { MAX_IMAGES, useComposerImages, type ImageIssue } from './composer/use-composer-images';
import { useNotePublish } from './composer/use-note-publish';

/**
 * ★ The picker and its ~9KB data table stay out of the Home bundle until the
 * emoji button is pressed. Home already carries this composer, the feed, the
 * topics rail and the Creator Tokens gql client (audit §9.5).
 */
const EmojiPicker = dynamic(() => import('./composer/emoji-picker'), { ssr: false });

/** A note is short by definition; the counter now states the limit it enforces. */
const MAX_NOTE_LENGTH = 1000;

/** Reason code -> i18n key, so the hook stays free of translation concerns. */
const ISSUE_KEYS: Record<ImageIssue, string> = {
  'too-many': 'too_many_images',
  'too-large': 'image_too_large',
  'not-an-image': 'image_not_an_image',
  'upload-failed': 'image_upload_failed',
  blocked: 'image_blocked'
};

/**
 * "What's on your mind?" compose box near the top of the home feed. At rest it is
 * a single-line card (avatar + placeholder + ink Post button, all Lora — the
 * product's only typeface since 2026-08-19; this used to read "all Open Sans per
 * design-handoff-v2 — no serif display face", and both halves of that are now
 * false); clicking it expands into the real editor surface.
 *
 * ★★★ "POST" POSTS. FOR EVERY ACCOUNT TIER. THAT IS THE WHOLE CONTRACT.
 * The tier decides which machinery runs (`useNotePublish`), never whether a post
 * happens.
 *
 * ★★★ WHAT THE 2026-08-14 AUDIT CHANGED, AND WHY EACH ONE MATTERS.
 *
 * THE PAYLOAD. A note used to broadcast as an ordinary root post whose `title`
 * was a truncated COPY of its own body, under a permlink that was a bare slug of
 * that text with no unique suffix, carrying `json_metadata.image: [""]` — a
 * non-empty array of nothing, so every thumbnail reader downstream got a blank
 * `src` — plus `summary: ""` and `author: ""`. Captured verbatim from the live
 * :4100 build at the Keychain boundary, without broadcasting:
 *
 *   permlink      "payload-probe-alpha-bravo-charlie-delta"
 *   title         "Payload probe alpha bravo charlie delta."   (=== body)
 *   json_metadata {"format":"markdown+html","summary":"","app":"lumen/1.0",
 *                  "tags":["lumen"],"image":[""],"author":""}
 *
 * and the same input on this build:
 *
 *   permlink      "payload-probe-alpha-bravo-charlie-delta-mss8kiuo"
 *   json_metadata {"format":"markdown+html","app":"lumen/1.0","type":"note",
 *                  "tags":["lumen"]}
 *
 * The permlink is the dangerous one, and it compounds with the feedback bug: the
 * most likely path through this code was a reader who thought publishing had
 * failed and pressed Post again — and that retry is exactly what a bare slug
 * makes Hive reject. See `lib/short-post-note.ts`.
 *
 * The title is still derived from the body, deliberately: a titleless post
 * breaks every other Hive front end, our share cards and our search results.
 * What changed is that OUR renderers no longer print it twice — the `type:"note"`
 * marker tells `medium-post-card.tsx` and the permalink page to drop the
 * headline and let the note speak for itself.
 *
 * THE TOOLBAR. There were 0 file inputs, 0 svg elements and 1 button inside this
 * card, and neither `paste` nor `drop` was handled (both `defaultPrevented
 * false` against a real `File`, while the long-form editor prevented both). The
 * upload pipeline it lacked already existed one directory over; it is now shared
 * through `useImageUpload`, not copied.
 *
 * ★ IDENTITY. `useSessionIdentity()` rather than `useUserClient()` for the
 * signed-in gate: the latter reports a genuinely signed-in reader as logged out
 * for the 3-5s `/api/users/me` takes, and this card sits at the top of Home, so
 * that flash hit it first (2026-08-11, same class as the header/left-rail fix).
 */
export default function ShortFormComposer() {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const identity = useSessionIdentity();
  const router = useRouter();

  const [text, setText] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** Set once the reader has actually touched the composer — guards the draft restore. */
  const dirtyRef = useRef(false);
  const textareaId = useId();

  const loggedIn = identity.isLoggedIn;
  const isLite = user.account_tier === 'lite';
  const displayUsername = user.username || identity.username;
  const { draft, save: saveDraft, clear: clearDraft } = useComposerDraft(user.username);
  const { publish, cancel, submitting } = useNotePublish({ isLite });

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

  const images = useComposerImages({
    insertSnippet: insertAtCaret,
    onDirty: markDirty,
    onStatus: (next) => setStatus(next ? t(`short_form_composer.${next === 'uploading' ? 'uploading' : 'uploaded'}`) : null),
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
  /**
   * ★ The collapse condition now also asks whether a PICKER is open or an upload
   * is in flight (audit §9.7). Without those, pressing the emoji button folded
   * the card up under the reader's own cursor.
   */
  const isExpanded =
    isFocused || text.length > 0 || images.media.length > 0 || emojiOpen || images.uploading;

  /* -------------------- draft: restore once, then save -------------------- */
  // `setMedia` comes straight from `useState`, so it is referentially stable —
  // depending on the whole `images` object would re-run this on every render.
  const restoreMedia = images.setMedia;
  useEffect(() => {
    // Not a "ran once" guard — `useStorageWithTTL` reads through
    // `useSyncExternalStore` and its first value can legitimately arrive a
    // microtask after mount, so "we already tried" would consume the empty
    // pre-read and never restore anything. "There is something to restore, and
    // the reader has not started typing" is the condition that is actually true.
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

  /* -------------------- textarea plumbing -------------------- */
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [text, isExpanded]);

  /**
   * Focus the textarea when the READER expands the card — never when a restored
   * draft expands it, which would steal focus and scroll the page on every load.
   */
  const expandAndFocus = () => {
    setIsFocused(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  /* -------------------- publish -------------------- */
  const submit = async () => {
    const trimmed = text.trim();
    if (trimmed === '' || submitting || overLimit || images.uploading) return;
    setError(null);
    setStatus(t('short_form_composer.publishing'));
    const outcome = await publish(
      trimmed,
      images.media.map((item) => item.url),
      {
        timedOut: t('short_form_composer.timed_out'),
        cancelled: t('short_form_composer.cancelled'),
        generic: t('short_form_composer.generic_error')
      }
    );
    setStatus(null);
    if (!outcome.ok) {
      // ★ The failure path used to be silent — no toast, no inline error,
      // nothing in the console. It is shown under the toolbar, and the text is
      // kept, so a rejection never costs the reader their note.
      setError(outcome.message);
      return;
    }
    // ★ SUCCESS MUST BE VISIBLE. The audit's worst finding was that a note
    // PUBLISHED and the UI actively suggested it had not: text still in the box,
    // no toast, no redirect, nothing. Clearing the box is not confirmation
    // either — it is exactly what a silent failure looks like. So: clear,
    // collapse, drop the draft, and SAY SO.
    setText('');
    images.setMedia([]);
    setIsFocused(false);
    setEmojiOpen(false);
    dirtyRef.current = false;
    clearDraft();
    toast({
      title: t('short_form_composer.published_title'),
      description: isLite
        ? t('short_form_composer.published_lite')
        : t('short_form_composer.published_hive'),
      variant: 'success'
    });
    // A lite post publishes as a COMMENT under a rolling container root, so it
    // can never appear on a tag page; the profile is where it actually is.
    if (isLite && user.username) router.push(`/@${user.username}`);
    else router.refresh();
  };

  /* -------------------- render -------------------- */
  if (!loggedIn) {
    return (
      <DialogLogin>
        <div className="cursor-pointer rounded-panel border border-[#ebebeb] bg-white p-[20px_22px] font-sans text-[18px] leading-[30px] text-ink-14 shadow-[0_1px_2px_rgba(20,18,10,0.03)] transition-colors hover:bg-background-secondary">
          {t('short_form_composer.login_prompt')}
        </div>
      </DialogLogin>
    );
  }

  if (!isExpanded) {
    return (
      <div
        data-testid="short-form-composer"
        data-state="collapsed"
        className="flex items-center gap-4 rounded-panel border border-[#ebebeb] bg-white p-[20px_22px] shadow-[0_1px_2px_rgba(20,18,10,0.03)]"
      >
        <UserAvatarImg username={displayUsername} pixelSize={44} alt={displayUsername} />
        <button
          type="button"
          onClick={expandAndFocus}
          className="flex-1 text-left font-sans text-[18px] leading-[30px] text-ink-14"
        >
          {t('short_form_composer.placeholder')}
        </button>
        <button
          type="button"
          onClick={expandAndFocus}
          className="ml-auto rounded-control bg-surface-brand-12 px-[22px] py-[10px] text-sm font-semibold text-white transition-colors hover:bg-surface-brand-16"
        >
          {t('short_form_composer.post_button')}
        </button>
      </div>
    );
  }

  // ★ Same card recipe as the collapsed state (audit §9.8): radius 18 not 16,
  // padding 20/22 not 24, the warm shadow not `shadow-sm`. Only the height
  // changes on click now, which is the only thing that should.
  return (
    <div
      data-testid="short-form-composer"
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
        'rounded-panel border bg-white p-[20px_22px] font-sans shadow-[0_1px_2px_rgba(20,18,10,0.03)] transition-colors',
        // ★ `line-brand-10`, not `#c0392b` (2026-08-14 token-migration pass):
        // brand LINE role (a border), matching `tailwind.config.js`'s own
        // border → `line-*` mapping.
        dragActive ? 'border-dashed border-line-brand-10/40' : 'border-[#ebebeb]'
      )}
    >
      <div className="flex gap-3">
        <UserAvatarImg username={displayUsername} pixelSize={44} alt={displayUsername} />
        <textarea
          ref={textareaRef}
          id={textareaId}
          name="short-form-note"
          aria-label={t('short_form_composer.aria_label')}
          aria-busy={submitting}
          value={text}
          onChange={(event) => {
            markDirty();
            setText(event.target.value);
          }}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
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
          placeholder={t('short_form_composer.placeholder')}
          rows={1}
          // ★ `max-h-[420px] overflow-y-auto`, was `max-h-80 overflow-hidden`.
          // Measured on the control build at 3,510 characters: clientHeight 320,
          // scrollHeight 1552, `overflow-y: hidden`, `resize: none` — the text
          // existed and a person had no wheel, no scrollbar and no drag handle to
          // reach it. Everything past roughly line 10 was invisible while typing.
          className="max-h-[420px] min-h-[56px] flex-1 resize-none overflow-y-auto border-none bg-transparent py-2 font-sans text-[18px] leading-[30px] text-foreground placeholder:text-ink-14 focus:outline-none focus-visible:ring-0"
        />
      </div>

      <input
        ref={fileRef}
        type="file"
        className="hidden"
        multiple
        accept={IMAGE_ACCEPT}
        data-testid="short-form-composer-file-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // Reset so re-picking the SAME file still fires `change`.
          event.target.value = '';
          void images.handleFiles(files);
        }}
      />

      <ComposerMediaStrip
        media={images.media}
        pendingCount={images.pendingCount}
        removeLabel={t('short_form_composer.remove_image')}
        onRemove={(url) => images.removeMedia(url, setText)}
      />

      <ComposerFooter
        labels={{
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
        onOpenFilePicker={() => fileRef.current?.click()}
        onToggleEmoji={() => setEmojiOpen((open) => !open)}
        onSubmit={() => void submit()}
        onCancel={cancel}
        picker={
          emojiOpen ? (
            <EmojiPicker
              onSelect={insertAtCaret}
              onClose={() => setEmojiOpen(false)}
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
        // ★ `ink-brand-6`, not `#c0392b` (2026-08-14 token-migration pass).
        <p
          className="mt-2 pl-[56px] font-sans text-caption text-ink-brand-6"
          data-testid="short-form-composer-over-limit"
        >
          {t('short_form_composer.over_limit', {
            limit: MAX_NOTE_LENGTH,
            over: text.length - MAX_NOTE_LENGTH
          })}
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 pl-[56px] font-sans text-caption text-ink-brand-6" data-testid="short-form-composer-error">
          {error}
        </p>
      ) : null}
      {/* Upload and publish progress, announced rather than only drawn. */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="short-form-composer-status">
        {status ?? ''}
      </p>
    </div>
  );
}
