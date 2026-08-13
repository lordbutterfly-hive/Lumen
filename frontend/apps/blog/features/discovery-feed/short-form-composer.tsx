'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { UserAvatarImg } from '@ui/components';
import { Button } from '@ui/components/button';
import { cn } from '@ui/lib/utils';
import DialogLogin from '@/blog/components/dialog-login';
import { createLitePost } from '@/blog/lib/lite/client/lite-write';
import { toast } from '@ui/components/hooks/use-toast';
import { createAsset, createPermlink } from '@transaction/lib/utils';
import { usePostMutation } from '@/blog/features/post-editor/hooks/use-post-mutation';
import { shortPostTitle } from '@/blog/lib/short-post-title';

// TODO: move to i18n (t('...'))
const LABELS = {
  placeholder: "What's on your mind?",
  postButton: 'Post',
  loginPrompt: 'Start writing. Log in to post.'
};

/**
 * Tag every short post carries. Deliberately the SAME constant the lite backend
 * puts on a normal-tier post (`NORMAL_TAG` in lib/lite/content/post-service.ts),
 * so a short post is the same kind of thing on chain whichever tier wrote it.
 * It also becomes the parent permlink of a Hive root post, which needs a tag.
 */
const SHORT_POST_TAG = 'lumen';

/** Hive's default max accepted payout, in the units `createAsset` expects. */
const MAX_PAYOUT_HBD = '1000000000';

/**
 * "What's on your mind?" compose box near the top of the home feed. At rest it is
 * a single-line card (avatar + placeholder + ink Post button, all Open Sans per
 * design-handoff-v2 — no serif display face); clicking it expands into the real
 * editor surface.
 *
 * ★★★ "POST" POSTS. FOR EVERY ACCOUNT TIER. THAT IS THE WHOLE CONTRACT.
 *
 * It did not, and this is what the owner hit. A visible "write a full post"
 * link was removed from here earlier, but the ESCAPE HATCH ITSELF SURVIVED
 * INSIDE THE BUTTON: for a Hive-keyed account, clicking Post stashed the text in
 * localStorage and navigated to /submit.html. So the label said Post, and what
 * happened was "you have been moved to a different, much larger editor and
 * nothing has been published". Removing the link while leaving the behaviour is
 * worse than leaving both — at least a link announces where it is taking you.
 *
 * Both tiers now publish from here, by the path each one actually has:
 *
 *  * LITE — no Hive keys, cannot sign in-browser. `createLitePost` hands the
 *    text to /api/lite/posts, which persists it and enqueues a publish job; the
 *    publisher account broadcasts it to Hive inside a container, exactly like
 *    any other lite post. Nothing about a short post makes it a special case.
 *
 *  * HIVE-KEYED — signs in the browser through the SAME `usePostMutation` the
 *    full editor uses. Not a second broadcast path: the same optimistic cache
 *    seeding, the same shadow draft, the same toast, the same error handling.
 *    A short post is a normal Hive root post; it is short, not different.
 *
 * The only thing this composer derives that the editor asks for explicitly is
 * the title — `shortPostTitle` in lib/short-post-title.ts, the SAME module the
 * lite backend titles with, so the two tiers cannot drift.
 */
export default function ShortFormComposer() {
  const { user } = useUserClient();
  const router = useRouter();
  // The full editor's mutation, reused verbatim for the Hive-keyed tier.
  const postMutation = usePostMutation();
  const [text, setText] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * ★★★ THE COMPOSER KNEW WHO YOU WERE LAST TOO (2026-08-11, same class of bug
   * as the header/left-rail fix in `server-session.tsx`, N-3).
   *
   * This used to be `isHydrated && user.isLoggedIn` — the "hydration-safe"
   * pattern used across the creator-tokens hooks, but hydration-safe only means
   * it will not lie about a signed-OUT visitor; it still reports a genuinely
   * signed-in reader as logged out for as long as `useUserClient()` takes to
   * read localStorage and `/api/users/me` to answer, which on this app is the
   * same 3-5s window the header/left-rail were fixed for. This composer sits at
   * the top of the home feed, so it was the very first thing that window's
   * flash hit. `useSessionIdentity()` is the same helper those already use:
   * server cookie until the client has a real answer, never overridden once one
   * arrives.
   */
  const identity = useSessionIdentity();
  const loggedIn = identity.isLoggedIn;
  // A lite account has no Hive keys, so it cannot sign in-browser: its short
  // post is proxied via /api/lite/posts instead of the Keychain/wax editor.
  // Unlike `loggedIn`, this only affects which path `submit()` takes below, and
  // submit only runs after the reader has typed something and clicked Post —
  // by then `useUserClient()` has long since answered for real, so this stays
  // on the plain client value rather than the server-cookie blend.
  const isLite = user.account_tier === 'lite';
  const isExpanded = isFocused || text.length > 0;
  // Avatar/alt only — real actions below (createPermlink, the lite/full post
  // path) keep using `user.username` untouched, for the same reason `isLite`
  // does: those only run after the client has answered.
  const displayUsername = user.username || identity.username;

  /**
   * One handler, because there is one user-facing action. The tier decides which
   * machinery runs, never whether a post happens.
   */
  const submit = async () => {
    const trimmed = text.trim();
    if (trimmed === '' || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (isLite) {
        const result = await createLitePost({ body: trimmed });
        if (result.status !== 'ok') {
          setError(result.message);
          return;
        }
      } else {
        const title = shortPostTitle(trimmed);
        // `createPermlink` dedupes against the author's existing permlinks, so
        // two short posts opening with the same words cannot collide.
        const [permlink, maxAcceptedPayout] = await Promise.all([
          createPermlink(title, user.username),
          createAsset(MAX_PAYOUT_HBD, 'HBD')
        ]);
        await postMutation.mutateAsync({
          permlink,
          title,
          body: trimmed,
          reputation: 0,
          tags: [SHORT_POST_TAG],
          category: SHORT_POST_TAG,
          summary: '',
          altAuthor: '',
          editMode: false,
          beneficiaries: [],
          maxAcceptedPayout,
          percentHbd: 10000
        });
      }
      setText('');
      setIsFocused(false);
      // ★ Confirm here too. The full editor got this and the composer did not —
      // and the composer is the one on the home page, so it is where most posts
      // are written. The text vanishing from the box is not confirmation; it is
      // exactly what a silent failure would also look like.
      // ★ 2026-08-08: "already visible on Lumen" WAS NOT TRUE, and this is the
      // composer most posts are written from. A UX tester published here, then
      // looked in the three obvious places — the home feed they had just used,
      // the Following tab, and the #lumen tag page — immediately and again 15
      // minutes later. It was in none of them. It was only on their own profile.
      //
      // It is not just early, it is partly unreachable: a lite post publishes as
      // a COMMENT under a rolling container root (`lib/lite/publisher/container.ts`),
      // and a tag page lists root posts, so it can never appear there at all.
      // The same false line was fixed in the full editor; this was its twin.
      toast({
        title: 'Post published',
        description: isLite
          ? "It's on your Lumen profile now, and queued to publish to Hive."
          : 'It is on its way to Hive.',
        variant: 'success'
      });
      // A lite author is sent to the one place the post actually is, for the
      // same reason: `router.refresh()` left them staring at a feed that does
      // not contain it, which is what made "published" feel like a lie.
      if (isLite && user.username) {
        router.push(`/@${user.username}`);
      } else {
        // Refresh the feed so the new post can appear. The toast is queued first
        // and survives it — measured visible for ~3.6 s afterwards.
        router.refresh();
      }
    } catch (e) {
      // usePostMutation already reports through handleError/toast; this keeps the
      // failure visible in the composer itself so the text is not silently lost.
      setError(e instanceof Error ? e.message : 'Could not post. Please try again.');
    } finally {
      setSubmitting(false);
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

  if (!loggedIn) {
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

  // REST state — single-line card.
  if (!isExpanded) {
    return (
      <div className="flex items-center gap-4 rounded-[18px] border border-[#ebebeb] bg-white p-[20px_22px] shadow-[0_1px_2px_rgba(20,18,10,0.03)]">
        {/* ★ CONVERGED (F6 item 22). This was a Radix `AvatarFallback` pointed at
            the EXACT SAME URL `AvatarImage` had just failed on — the same N-4 bug
            app-header.tsx's HeaderAvatar was fixed for, just not here: on a real
            error this rendered nothing, an empty ring, not a fallback. */}
        <UserAvatarImg username={displayUsername} pixelSize={44} alt={displayUsername} />
        <button
          type="button"
          onClick={() => setIsFocused(true)}
          className="flex-1 text-left font-sans text-[20px] leading-[30px] text-[#9ca3af]"
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
        <UserAvatarImg username={displayUsername} pixelSize={44} alt={displayUsername} />
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder={LABELS.placeholder}
          rows={1}
          className="max-h-80 min-h-[56px] flex-1 resize-none overflow-hidden border-none bg-transparent py-2 font-sans text-[20px] leading-[32px] text-foreground placeholder:text-[#9ca3af] focus:outline-none focus-visible:ring-0"
        />
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-border pl-[56px] pt-3">
        <span className="text-xs tabular-nums text-muted-foreground">{text.length}</span>
        <div className="flex items-center gap-3">
          {error ? <span className="text-xs text-red-600">{error}</span> : null}
          <Button
            type="button"
            variant="default"
            size="sm"
            className="rounded-[11px] bg-[#1a1a17] px-[22px] font-semibold text-white hover:bg-[#1a1a17]/90"
            disabled={text.trim() === '' || submitting}
            onClick={submit}
          >
            {submitting ? 'Posting…' : LABELS.postButton}
          </Button>
        </div>
      </div>
    </div>
  );
}
