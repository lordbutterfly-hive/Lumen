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
 */
export function useComposerDraft(username: string) {
  const key = username ? `${KEY_PREFIX}${username}` : '';
  const [draft, setDraft, removeDraft] = useStorageWithTTL<ComposerDraft>(
    key,
    EMPTY_DRAFT,
    StorageTTL.DRAFT
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  /** Debounced so a fast typist writes to localStorage twice a second, not per keystroke. */
  const save = useCallback(
    (next: ComposerDraft) => {
      if (!key) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (next.body.trim() === '' && next.media.length === 0) removeDraft();
        else setDraft(next);
      }, SAVE_DEBOUNCE_MS);
    },
    [key, removeDraft, setDraft]
  );

  /** Immediate, undebounced — used on a successful publish, where a pending timer would resurrect the note. */
  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (key) removeDraft();
  }, [key, removeDraft]);

  return { draft, save, clear, enabled: Boolean(key) };
}
