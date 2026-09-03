'use client';

import { useCallback, useRef, useState } from 'react';
import { useCommentMutation } from '@/blog/features/post-rendering/hooks/use-comment-mutations';
import { createLitePost } from '@/blog/lib/lite/client/lite-write';
import { litePostIdOf } from '@/blog/lib/lite/render/lite-post-id';
import type { Preferences } from '@/blog/lib/utils';
import { SIGN_TIMEOUT_MS, type PublishMessages, type PublishOutcome } from './use-note-publish';

/**
 * ★★★ THE QUICK-REPLY'S ONE PUBLISH ACTION — a structural clone of
 * `useNotePublish` (QUICK-REPLY-SPEC §3.2). The 60s stop-waiting/cancel race,
 * the `PublishOutcome`/`PublishMessages` contract and the `submitting` flag are
 * IMPORTED from `use-note-publish.ts` (`SIGN_TIMEOUT_MS` + the two types), not
 * redeclared, so the reply cannot drift from the quick-post's timeout semantics.
 * The ONLY substitution is the `work` body: a COMMENT under a parent instead of
 * a root post (§4).
 *
 * Signing cannot be aborted — the same finding `use-note-publish.ts` documents at
 * length. At 60s (or on Cancel) this stops WAITING, keeps the text, and says the
 * reply may still publish, because it may.
 */

// Private markers for the race, exactly as `use-note-publish.ts` uses them. Only
// the SHARED contract (SIGN_TIMEOUT_MS + the types) is imported; these two are an
// implementation detail of the race, redeclared to keep the module self-contained.
class ComposerTimeout extends Error {}
class ComposerCancelled extends Error {}

/**
 * Everything the reply broadcast needs. `body` already carries any attached
 * images as inline `![](url)` markdown (mirroring the shipped reply path, which
 * puts a comment's images in its body, `reply-textbox.tsx`) — a comment has no
 * separate `json_metadata.image` array the way a root post does.
 */
export interface ReplyPublishInput {
  /** The comment being replied to — its CHAIN coordinates (§4.1). */
  parentAuthor: string;
  parentPermlink: string;
  /** The POST — the thread's identity, for the mutation's discussion cache (§4.2). */
  rootAuthor: string;
  rootPermlink: string;
  /** Trimmed body, image markdown already inline. */
  body: string;
  /** Decides the comment's reward split in the broadcast (`reply-textbox.tsx:135-139`). */
  preferences: Preferences;
  /** `useLoggedUserContext()` — the author's reputation for the optimistic entry. */
  reputation: number;
  /** `user.username`, exactly as the post page passes `observer`. */
  observer: string;
}

export function useReplyPublish({ isLite }: { isLite: boolean }) {
  const commentMutation = useCommentMutation();
  const [submitting, setSubmitting] = useState(false);
  const abortRef = useRef<((reason: Error) => void) | null>(null);

  const publish = useCallback(
    async (input: ReplyPublishInput, messages: PublishMessages): Promise<PublishOutcome> => {
      setSubmitting(true);
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const raced = new Promise<never>((_resolve, reject) => {
          abortRef.current = reject;
          timer = setTimeout(() => reject(new ComposerTimeout()), SIGN_TIMEOUT_MS);
        });

        const work = (async () => {
          if (isLite) {
            // ★★★ THE PARENT MUST BE CLASSIFIED, NOT JUST FORWARDED (H5,
            // 2026-08-16) — byte-for-byte the logic at `reply-textbox.tsx:325-360`.
            // `litePostIdOf` recovers our own row id from a lite permlink so the
            // server derives the real on-chain coordinate itself; a genuine reply
            // to a real chain post falls through to `type: 'chain'`.
            const liteParentId = litePostIdOf({ permlink: input.parentPermlink });
            const result = await createLitePost({
              body: input.body,
              parentRef: liteParentId
                ? { type: 'lite', id: liteParentId }
                : { type: 'chain', author: input.parentAuthor, permlink: input.parentPermlink }
            });
            if (result.status !== 'ok') throw new Error(result.message);
            return;
          }
          // Hive-keyed account — the EXACT mutation the post page's reply box uses
          // (`reply-textbox.tsx:167, 423-428`). It self-generates the reply
          // permlink, appends the mandatory attribution footer, seeds its own
          // optimistic `['discussionData', …]` cache, toasts, and runs the
          // validated refetch — all for free (§4.2).
          const commentParams = {
            parentAuthor: input.parentAuthor,
            parentPermlink: input.parentPermlink,
            body: input.body,
            preferences: input.preferences,
            reputation: input.reputation,
            discussionAuthor: input.rootAuthor,
            discussionPermlink: input.rootPermlink,
            observer: input.observer
          };
          await commentMutation.mutateAsync(commentParams);
        })();
        // If the timeout wins the race, `work` may still reject later with nothing
        // awaiting it — give it a terminal handler so the browser does not log an
        // unhandled rejection for a failure already reported.
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
    [isLite, commentMutation]
  );

  /** Stop waiting now. Same honest caveat as the timeout — see the doc above. */
  const cancel = useCallback(() => {
    abortRef.current?.(new ComposerCancelled());
  }, []);

  return { publish, cancel, submitting };
}
