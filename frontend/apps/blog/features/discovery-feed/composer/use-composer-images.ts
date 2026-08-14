'use client';

import { useCallback, useState } from 'react';
import { useImageUpload, type RejectedImage } from '@/blog/components/hooks/use-image-upload';
import type { ComposerMedia } from './composer-media-strip';

/** Audit §9.3. Four is a grid, not a gallery. */
export const MAX_IMAGES = 4;

export type ImageIssue = RejectedImage['reason'] | 'too-many';

export interface ComposerImageCallbacks {
  /** Put text at the caret — the markdown is what makes the image RENDER. */
  insertSnippet: (snippet: string) => void;
  /** Reason code plus the offending file name; the caller owns translation. */
  onIssue: (issue: ImageIssue, name: string) => void;
  /** `'uploading'` while in flight, `'uploaded'` on success, `null` when idle. */
  onStatus: (status: 'uploading' | 'uploaded' | null) => void;
  /** Any change made here is a change the reader made — mark the draft dirty. */
  onDirty: () => void;
}

/**
 * Attached images for the short-form composer: the button, paste and drop all
 * land here (audit finding 4, §9.3, §9.7).
 *
 * Two representations are kept deliberately, and both are needed:
 *  * the `![](url)` markdown inside the note, which is what makes the image
 *    actually appear when the note is read; and
 *  * `media`, which becomes `json_metadata.image` — real URLs, never `[""]`.
 * Removing a thumbnail strips both, or the note would still show a picture the
 * reader just removed from the strip.
 */
export function useComposerImages({ insertSnippet, onIssue, onStatus, onDirty }: ComposerImageCallbacks) {
  const { upload, uploading } = useImageUpload();
  const [media, setMedia] = useState<ComposerMedia[]>([]);
  const [pendingCount, setPendingCount] = useState(0);

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const room = MAX_IMAGES - media.length;
      if (room <= 0) {
        onIssue('too-many', '');
        return;
      }
      const accepted = files.slice(0, room);
      if (files.length > room) onIssue('too-many', '');
      onDirty();
      setPendingCount((n) => n + accepted.length);
      onStatus('uploading');
      try {
        const outcome = await upload(accepted);
        if (outcome.uploaded.length > 0) {
          setMedia((current) => [...current, ...outcome.uploaded].slice(0, MAX_IMAGES));
          insertSnippet(`\n${outcome.uploaded.map((image) => `![](${image.url})`).join('\n')}\n`);
          onStatus('uploaded');
        } else {
          onStatus(null);
        }
        const first = outcome.rejected[0];
        if (first) onIssue(first.reason, first.name);
      } finally {
        setPendingCount((n) => Math.max(0, n - accepted.length));
      }
    },
    [insertSnippet, media.length, onDirty, onIssue, onStatus, upload]
  );

  const removeMedia = useCallback(
    (url: string, setText: (updater: (current: string) => string) => void) => {
      onDirty();
      setMedia((current) => current.filter((item) => item.url !== url));
      const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      setText((current) =>
        current.replace(new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)\\n?`, 'g'), '').replace(/\n{3,}/g, '\n\n')
      );
    },
    [onDirty]
  );

  /** Image files on a clipboard or a drag, and nothing else. */
  const filesFromTransfer = useCallback((transfer: DataTransfer | null): File[] => {
    if (!transfer) return [];
    const files: File[] = [];
    for (let index = 0; index < transfer.items.length; index += 1) {
      const item = transfer.items[index];
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file && (file.type.startsWith('image/') || /\.(gif|png|jpe?g|jfif|webp|heic|heif)$/i.test(file.name)))
        files.push(file);
    }
    return files;
  }, []);

  return {
    media,
    setMedia,
    pendingCount,
    uploading: uploading || pendingCount > 0,
    handleFiles,
    removeMedia,
    filesFromTransfer
  };
}
