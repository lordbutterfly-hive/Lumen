'use client';

import { useCallback, useRef, useState } from 'react';
import { createAsset } from '@transaction/lib/utils';
import { createLitePost } from '@/blog/lib/lite/client/lite-write';
import { usePostMutation } from '@/blog/features/post-editor/hooks/use-post-mutation';
import { shortPostTitle } from '@/blog/lib/short-post-title';
import { NOTE_METADATA_TYPE, shortPostPermlink } from '@/blog/lib/short-post-note';

/** Tag every short post carries — the same constant the lite backend uses. */
const SHORT_POST_TAG = 'lumen';

/** Hive's default max accepted payout, in the units `createAsset` expects. */
const MAX_PAYOUT_HBD = '1000000000';

/**
 * ★★★ SIGNING CANNOT BE ABORTED, SO THE UI MUST STOP WAITING (audit finding 6).
 *
 * Measured on the audited build: the button read "Posting…", disabled, at
 * 37,202ms and was still stuck — a Keychain approval window nobody had answered.
 * No timeout, no cancel; the only recovery was a reload, which also threw the
 * draft away.
 *
 * What can honestly be fixed is the WAITING, not the transaction. `mutateAsync`
 * resolves inside wax/Keychain and there is no abort signal to pull, so at 60s
 * (or on Cancel) this stops waiting, re-enables the composer, KEEPS the text and
 * says plainly that the note may still publish — because it may. Silently
 * offering a retry that could double-post would be worse than the hang.
 *
 * Measured on the fixed build with a Keychain stub that never answers: still
 * "Posting…" and disabled at 56,754ms, settled with the timeout message at
 * 60,003ms, text intact, nothing broadcast.
 */
export const SIGN_TIMEOUT_MS = 60_000;

class ComposerTimeout extends Error {}
class ComposerCancelled extends Error {}

export interface PublishMessages {
  timedOut: string;
  cancelled: string;
  generic: string;
}

export type PublishOutcome = { ok: true } | { ok: false; message: string };

/**
 * The one publish action, for both account tiers.
 *
 *  * LITE — no Hive keys, cannot sign in-browser. `createLitePost` hands the
 *    text to /api/lite/posts, which persists it and enqueues a publish job.
 *  * HIVE-KEYED — signs in the browser through the SAME `usePostMutation` the
 *    full editor uses: same optimistic cache seeding, same shadow draft, same
 *    error handling. A short post is a normal Hive root post; it is short, not
 *    different.
 */
export function useNotePublish({ isLite }: { isLite: boolean }) {
  const postMutation = usePostMutation();
  const [submitting, setSubmitting] = useState(false);
  const abortRef = useRef<((reason: Error) => void) | null>(null);

  const publish = useCallback(
    async (body: string, images: string[], messages: PublishMessages): Promise<PublishOutcome> => {
      setSubmitting(true);
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const raced = new Promise<never>((_resolve, reject) => {
          abortRef.current = reject;
          timer = setTimeout(() => reject(new ComposerTimeout()), SIGN_TIMEOUT_MS);
        });

        const work = (async () => {
          if (isLite) {
            const result = await createLitePost({ body });
            if (result.status !== 'ok') throw new Error(result.message);
            return;
          }
          const title = shortPostTitle(body);
          const permlink = shortPostPermlink(title);
          const maxAcceptedPayout = await createAsset(MAX_PAYOUT_HBD, 'HBD');
          await postMutation.mutateAsync({
            permlink,
            title,
            body,
            reputation: 0,
            tags: [SHORT_POST_TAG],
            category: SHORT_POST_TAG,
            // Empty strings are OMITTED downstream rather than broadcast — see
            // `normalizeImages` and the `post()` doc in packages/transaction/index.ts.
            summary: '',
            altAuthor: '',
            image: images,
            extraJsonMetadata: { type: NOTE_METADATA_TYPE },
            editMode: false,
            beneficiaries: [],
            maxAcceptedPayout,
            percentHbd: 10000
          });
        })();
        // If the race is decided by the timeout, `work` may still reject later.
        // Nothing awaits it by then, so give it a terminal handler or the browser
        // logs an unhandled rejection for a failure already reported.
        work.catch(() => undefined);

        await Promise.race([work, raced]);
        return { ok: true };
      } catch (error) {
        if (error instanceof ComposerTimeout) return { ok: false, message: messages.timedOut };
        if (error instanceof ComposerCancelled) return { ok: false, message: messages.cancelled };
        return { ok: false, message: error instanceof Error ? error.message : messages.generic };
      } finally {
        if (timer) clearTimeout(timer);
        abortRef.current = null;
        setSubmitting(false);
      }
    },
    [isLite, postMutation]
  );

  /** Stop waiting now. Same honest caveat as the timeout — see its doc above. */
  const cancel = useCallback(() => {
    abortRef.current?.(new ComposerCancelled());
  }, []);

  return { publish, cancel, submitting };
}
