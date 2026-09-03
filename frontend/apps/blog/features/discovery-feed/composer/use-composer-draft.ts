'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useStorageWithTTL } from '@ui/hooks/useStorageWithTTL';
import { StorageTTL } from '@ui/lib/storage-with-ttl';
import type { ComposerMedia } from './composer-media-strip';

export interface ComposerDraft {
  body: string;
  media: ComposerMedia[];
}

/**
 * Stable reference — `useStorageWithTTL` captures `initialValue` on first render
 * and compares by identity; a fresh object literal per render would loop.
 */
const EMPTY_DRAFT: ComposerDraft = { body: '', media: [] };

/** Per account. A shared key would show one reader another reader's unsent note. */
const KEY_PREFIX = 'lumen-composer-draft-';

const SAVE_DEBOUNCE_MS = 500;

/**
 * Draft persistence for the short-form composer (audit finding 13, §9.7).
 *
 * ★ `useStorageWithTTL`, not raw `localStorage`. CLAUDE.md's storage rule is
 * explicit and the ESLint config enforces it: temporary data expires. A draft is
 * `StorageTTL.DRAFT` (30 days), the same class the long-form editor's own drafts
 * use, so `<StorageCleanup />` sweeps an abandoned note rather than leaving it in
 * a browser forever.
 *
 * ★ The key is namespaced by USERNAME and is `''` — which disables the hook
 * entirely — until the session has answered. That matters more than it looks:
 * `user.username` is empty for the first few hundred ms of every page load, so a
 * single global key would (a) let account A see account B's unsent note after a
 * switch and (b) race the restore against the session read.
 *
 * ★ `storageKey` OVERRIDE (QUICK-REPLY-SPEC §5). The quick-reply composer needs a
 * DIFFERENT key per parent comment (`lumen-reply-draft-<username>-<parentAuthor>-
 * <parentPermlink>`) so each target's draft survives switching between them. When
 * omitted, the hook builds today's `lumen-composer-draft-<username>` key, so
 * `ShortFormComposer` is unchanged. An explicit `''` still disables the hook (the
 * same username-gating: the caller passes `''` until it knows the username), so
 * the empty-key guards below apply to both callers identically.
 */
export function useComposerDraft(username: string, storageKey?: string) {
  const key = storageKey !== undefined ? storageKey : username ? `${KEY_PREFIX}${username}` : '';
  const [draft, setDraft, removeDraft] = useStorageWithTTL<ComposerDraft>(
    key,
    EMPTY_DRAFT,
    StorageTTL.DRAFT
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The draft a pending (debounced) timer has not yet written. */
  const pendingRef = useRef<ComposerDraft | null>(null);

  /** Write `next` through now, honouring the empty -> remove rule. */
  const commit = useCallback(
    (next: ComposerDraft) => {
      if (next.body.trim() === '' && next.media.length === 0) removeDraft();
      else setDraft(next);
    },
    [removeDraft, setDraft]
  );
  // Latest committer for the unmount flush below — the cleanup closure runs
  // once with first-render bindings, so it reads through a ref.
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  }, [commit]);

  /**
   * ★ FLUSH THE PENDING SAVE ON UNMOUNT — never drop it (2026-09-03, quick-reply
   * review F4). This cleanup used to only `clearTimeout`, which was safe when the
   * sole caller (the quick-post) never unmounted mid-edit. The quick-reply
   * composer UNMOUNTS on every toggle/target switch, and the debounce resets per
   * keystroke — so continuous typing followed by a switch silently lost
   * everything since the last 500ms pause (possibly the entire draft). Writing
   * the pending value through on unmount closes that hole; for the quick-post it
   * is a strict improvement (a route change within the debounce window now saves
   * instead of dropping).
   */
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) commitRef.current(pending);
    },
    []
  );

  /** Debounced so a fast typist writes to localStorage twice a second, not per keystroke. */
  const save = useCallback(
    (next: ComposerDraft) => {
      if (!key) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      pendingRef.current = next;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        pendingRef.current = null;
        commit(next);
      }, SAVE_DEBOUNCE_MS);
    },
    [key, commit]
  );

  /** Immediate, undebounced — used on a successful publish, where a pending timer would resurrect the note. */
  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    if (key) removeDraft();
  }, [key, removeDraft]);

  return { draft, save, clear, enabled: Boolean(key) };
}
