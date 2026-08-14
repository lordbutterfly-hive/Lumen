'use client';

import { useCallback, useMemo, useState } from 'react';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSignerContext } from '@smart-signer/components/signer-provider';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import imageUserBlocklist from '@ui/config/lists/image-user-blocklist';
import { getLogger } from '@ui/lib/logging';
import { processImageForUpload } from '@/blog/features/post-editor/lib/image-processing';
import { uploadImg } from '@/blog/features/post-editor/lib/utils';

const logger = getLogger('app');

/**
 * The ONE image pipeline, shared by the long-form editor and the short-form
 * composer.
 *
 * ★ REUSE, DO NOT REINVENT (composer audit §9.1).
 *
 * The long-form editor already had a working, signed, direct-to-imagehoster
 * upload — `uploadImg` in `features/post-editor/lib/utils.ts`: it reads the file,
 * signs an `ImageSigningChallenge` with the account's own key, and POSTs to
 * `${configuredImagesEndpoint}/<owner>/<signature>`. It also already handles the
 * KEYLESS lite tier, whose `signer` is deliberately null, by routing to
 * `/api/lite/upload` where the publishing account signs server-side.
 *
 * This hook is a thin wrapper around exactly that function — not a second
 * implementation of it. There is deliberately NO `/api/upload` route: the audit
 * probed `/api/upload`, `/api/image`, `/api/images`, `/api/image-upload`,
 * `/api/upload-image` and `/api/media`, all 404, and concluded the direct
 * client-side upload is correct. Adding a proxy would move a signed upload onto
 * our own server for no benefit.
 *
 * What this ADDS over calling `uploadImg` directly is the policy every caller
 * needs and none should re-derive: the accept list, a size cap, a
 * "is this even an image" check, and the image-blocklist gate that
 * `md-editor.tsx` had to grow after a measured race let a blocked user upload
 * during the `/api/users/me` window.
 */

/** Exactly the accept list the long-form editor's hidden file input already uses. */
export const IMAGE_ACCEPT = '.jpg,.png,.jpeg,.jfif,.gif,.webp,.heic,.heif';

/** Reject above this, with a message, rather than making the reader wait for a failure. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface UploadedImage {
  url: string;
  name: string;
}

export interface RejectedImage {
  name: string;
  /** One of a small closed set so the caller can translate it. */
  reason: 'too-large' | 'not-an-image' | 'upload-failed' | 'blocked';
}

export interface ImageUploadOutcome {
  uploaded: UploadedImage[];
  rejected: RejectedImage[];
}

const IMAGE_EXTENSIONS = IMAGE_ACCEPT.split(',');

function looksLikeAnImage(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  const name = file.name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export function useImageUpload(options?: { maxBytes?: number }) {
  const maxBytes = options?.maxBytes ?? MAX_IMAGE_BYTES;
  const { user } = useUserClient();
  const { signer } = useSignerContext();
  /**
   * Same reasoning as `md-editor.tsx`'s own note: raw `user.username` is `''`
   * until `/api/users/me` answers, so a blocklist check against it reads FALSE
   * for a genuinely blocked account for that whole window — and this hook is the
   * thing that performs the upload, not merely the thing that renders a button.
   * `identity.username` comes from the session cookie the server already read.
   */
  const identity = useSessionIdentity();
  const isBlocked = useMemo(
    () => imageUserBlocklist?.includes(identity.username) ?? false,
    [identity.username]
  );
  const [uploading, setUploading] = useState(false);

  const upload = useCallback(
    async (files: File[]): Promise<ImageUploadOutcome> => {
      const uploaded: UploadedImage[] = [];
      const rejected: RejectedImage[] = [];
      if (files.length === 0) return { uploaded, rejected };
      if (isBlocked) {
        return { uploaded, rejected: files.map((f) => ({ name: f.name, reason: 'blocked' as const })) };
      }

      setUploading(true);
      try {
        // Sequential on purpose — the same choice the long-form batch uploader
        // made, for mobile memory: several full-size images decoded at once is
        // how a phone tab gets killed mid-post.
        for (const file of files) {
          if (!looksLikeAnImage(file)) {
            rejected.push({ name: file.name, reason: 'not-an-image' });
            continue;
          }
          if (file.size > maxBytes) {
            rejected.push({ name: file.name, reason: 'too-large' });
            continue;
          }
          try {
            const processed = await processImageForUpload(file, { optimize: true });
            const url = await uploadImg(processed.file, user.username, signer);
            // `uploadImg` reports its own failures through handleError/toast and
            // resolves to '' rather than throwing. An empty URL is a failure.
            if (url) uploaded.push({ url, name: processed.file.name });
            else rejected.push({ name: file.name, reason: 'upload-failed' });
          } catch (error) {
            logger.error('useImageUpload: %s failed: %o', file.name, error);
            rejected.push({ name: file.name, reason: 'upload-failed' });
          }
        }
      } finally {
        setUploading(false);
      }
      return { uploaded, rejected };
    },
    [isBlocked, maxBytes, signer, user.username]
  );

  return { upload, uploading, isBlocked };
}
