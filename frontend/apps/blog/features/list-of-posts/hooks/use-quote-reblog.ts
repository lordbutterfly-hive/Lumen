'use client';

import { quoteReblogsEnabled } from '@/blog/lib/quote-reblog/quote-flag';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import { quoteCommentBody } from '@transaction/lib/quote-ops';
import { csrfHeaderName } from '@smart-signer/lib/csrf-protection';
import { configuredSiteDomain } from '@ui/config/public-vars';
import type { Entry } from '@hive/common-hiveio-packages/wax';
import type { Preferences } from '@/blog/lib/utils';
import {
  publishQuote,
  removeQuote,
  QuoteFlowError,
  type ApiResult,
  type ChainRef,
  type QuoteFlowDeps
} from '@/blog/lib/quote-reblog/quote-flow';

/**
 * Quote reblogs ("reblog with a comment", spec v2 3.1) for the reblog popup: the
 * person's own comment on a post, saving it and removing it. A Hive login signs with
 * its own key through `lib/quote-reblog/quote-flow.ts`; a lite login goes through the
 * Lumen publisher (`/api/quotes/lite`).
 */

export { quoteReblogsEnabled };

/** What the popup knows about the post, for the link line under the comment. */
export interface QuoteTargetInfo {
  /** ON-CHAIN coordinates (a Lumen post: the publishing account, never the handle). */
  author: string;
  permlink: string;
  title: string;
  category: string;
  /** The name Lumen shows (a Lumen post: the writer's handle). */
  displayAuthor: string;
  /** Set for a Lumen post: named by handle, without @, in the link line. */
  liteHandle: string | null;
  /** The post itself, for the small card in the popup. */
  entry?: Entry;
}

const JSON_POST: HeadersInit = { 'Content-Type': 'application/json', [csrfHeaderName]: '1' };

async function call<T>(url: string, body?: unknown): Promise<ApiResult<T>> {
  const res = await fetch(
    url,
    body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: JSON_POST, body: JSON.stringify(body) }
  );
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return res.ok ? { ok: true, value: data as T } : { ok: false, status: res.status, error: String(data.error ?? `http_${res.status}`) };
}

function hiveDeps(preferences: Preferences): QuoteFlowDeps {
  const at = (r: ChainRef) => ({ author: r.author, permlink: r.permlink });
  return {
    prepare: (r) => call('/api/quotes/prepare', at(r)),
    confirm: (r) => call('/api/quotes/confirm', at(r)),
    removePlan: (r) => call('/api/quotes/remove-plan', at(r)),
    removed: (r) => call('/api/quotes/removed', at(r)),
    signQuote: async (input) => {
      await transactionService.quoteReblog(input, preferences, { observe: true });
    },
    signRemove: async ({ undoReblog, ...plan }) => {
      await transactionService.removeQuote(
        {
          permlink: plan.permlink,
          parentAuthor: plan.parentAuthor,
          parentPermlink: plan.parentPermlink,
          existingJsonMetadata: plan.jsonMetadata,
          mode: plan.mode,
          undoReblog
        },
        { observe: true }
      );
    },
    signUnreblog: async (r) => {
      await transactionService.unreblog(r.author, r.permlink, { observe: true });
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  };
}

function linkTarget(target: QuoteTargetInfo) {
  const origin = configuredSiteDomain.replace(/\/+$/, '');
  return {
    author: target.author,
    permlink: target.permlink,
    title: target.title,
    url: `${origin}/${target.category || 'hive'}/@${target.displayAuthor}/${target.permlink}`,
    lite: target.liteHandle ? { handle: target.liteHandle } : null
  };
}

/** A refusal in words the popup can show. */
export function quoteErrorText(error: unknown): string {
  const code = error instanceof QuoteFlowError ? error.code : '';
  switch (code) {
    case 'blocked':
      return "You can't reblog this post.";
    case 'is_a_quote':
      return "A reblog comment can't be reblogged.";
    case 'not_a_post':
      return 'Only posts can be reblogged with a comment.';
    case 'rate_limited':
      return 'You are going a bit fast. Please try again later.';
    case 'too_long':
      return 'Keep the comment to 280 characters.';
    case 'disabled':
    case 'no_container':
      return "Reblog comments aren't available right now.";
    case 'account_restricted':
      return "Your account can't post right now.";
    case 'unauthorized':
    case 'hive_login_required':
      return 'Please sign in again.';
    default:
      // A server code nobody wrote words for reads as a raw token ("server_error");
      // a wallet's own message ("user rejected the request") is already readable.
      if (error instanceof QuoteFlowError) return 'Something went wrong. Please try again.';
      return error instanceof Error && error.message ? error.message : 'Something went wrong. Please try again.';
  }
}

const myQuoteKey = (t: ChainRef | null) => ['my-quote', t?.author ?? '', t?.permlink ?? ''];

/** Their own comment on this post, while the popup is open. */
export function useMyQuote(target: ChainRef | null, enabled: boolean) {
  return useQuery({
    queryKey: myQuoteKey(target),
    enabled: enabled && !!target,
    staleTime: 0,
    queryFn: async () => {
      if (!target) return null;
      const r = await call<{ quote: { state: string; body: string } | null }>(
        `/api/quotes/mine?author=${encodeURIComponent(target.author)}&permlink=${encodeURIComponent(target.permlink)}`
      );
      return r.ok ? r.value.quote : null;
    }
  });
}

export function useQuoteMutations(lite: boolean, username: string, preferences: Preferences) {
  const queryClient = useQueryClient();
  const settle = (target: ChainRef, reblogged: boolean) => {
    queryClient.invalidateQueries({ queryKey: myQuoteKey(target) });
    queryClient.setQueriesData({ queryKey: ['PostRebloggedBy', target.author, target.permlink, username] }, reblogged);
  };

  const save = useMutation({
    mutationFn: async (input: { target: QuoteTargetInfo; caption: string; alreadyReblogged: boolean }) => {
      const ref = { author: input.target.author, permlink: input.target.permlink };
      if (lite) {
        const r = await call('/api/quotes/lite', { ...ref, caption: input.caption });
        if (!r.ok) throw new QuoteFlowError(r.error, r.error);
        return ref;
      }
      await publishQuote(hiveDeps(preferences), {
        target: ref,
        caption: input.caption,
        bodyFor: (caption) => quoteCommentBody(caption, linkTarget(input.target)),
        alreadyReblogged: input.alreadyReblogged
      });
      return ref;
    },
    onSuccess: (ref) => settle(ref, true)
  });

  const remove = useMutation({
    mutationFn: async (input: { target: ChainRef; undoReblog: boolean }) => {
      if (lite) {
        const r = await call('/api/quotes/lite/remove', { ...input.target, undoReblog: input.undoReblog });
        if (!r.ok) throw new QuoteFlowError(r.error, r.error);
      } else {
        await removeQuote(hiveDeps(preferences), input);
      }
      return input;
    },
    onSuccess: (input) => settle(input.target, !input.undoReblog)
  });

  return { save, remove };
}
