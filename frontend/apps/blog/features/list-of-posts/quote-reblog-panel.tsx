'use client';

import { useEffect, useId, useState } from 'react';
import { CircleSpinner } from 'react-spinners-kit';
import { Button } from '@ui/components/button';
import { Textarea } from '@ui/components/textarea';
import { toast } from '@ui/components/hooks/use-toast';
import { useStorageWithTTL } from '@ui/hooks/useStorageWithTTL';
import { StorageTTL } from '@ui/lib/storage-with-ttl';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { DEFAULT_PREFERENCES, type Preferences } from '@/blog/lib/utils';
import { QUOTE_MAX_CHARS } from '@/blog/lib/quote-reblog/quote-flow';
import { quoteErrorText, useMyQuote, useQuoteMutations, type QuoteTargetInfo } from './hooks/use-quote-reblog';

/**
 * The body of the reblog popup when quote reblogs are on (spec v2 3.1): ONE reblog
 * button, an optional comment. Empty box: a plain reblog, exactly as before. Text: a
 * reblog with a comment. Once reblogged, the same popup edits or removes the comment or
 * undoes the reblog (the comment always goes with it). The text survives a cancelled
 * approval or a failed save.
 */
export function QuoteReblogPanel({
  open,
  target,
  isReblogged,
  checking,
  onPlainReblog,
  onDone
}: {
  open: boolean;
  target: QuoteTargetInfo;
  isReblogged: boolean;
  checking: boolean;
  onPlainReblog: () => void;
  onDone: () => void;
}) {
  const boxId = useId();
  const { user } = useUserClient();
  const lite = user.account_tier === 'lite';
  const [preferences] = useStorageWithTTL<Preferences>(
    user.username ? `user-preferences-${user.username}` : '',
    DEFAULT_PREFERENCES,
    StorageTTL.PERMANENT
  );
  const ref = { author: target.author, permlink: target.permlink };
  const mine = useMyQuote(ref, open && isReblogged);
  const existing = mine.data ?? null;
  const { save, remove } = useQuoteMutations(lite, user.username, preferences);

  const [caption, setCaption] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState('');
  // Fill the box with their comment once it arrives, unless they already started typing.
  useEffect(() => {
    if (!touched && existing?.body) setCaption(existing.body);
  }, [existing?.body, touched]);

  const busy = save.isLoading || remove.isLoading || checking;
  const text = caption.trim();
  const tooLong = text.length > QUOTE_MAX_CHARS;

  const run = async (work: () => Promise<unknown>, done: string) => {
    setError('');
    try {
      await work();
      toast({ title: done, variant: 'success' });
      onDone();
    } catch (e) {
      setError(quoteErrorText(e));
    }
  };

  const reblog = () => {
    if (!text) return onPlainReblog();
    run(() => save.mutateAsync({ target, caption: text, alreadyReblogged: false }), 'Reblogged with your comment');
  };
  const saveComment = () =>
    run(() => save.mutateAsync({ target, caption: text, alreadyReblogged: true }), 'Comment saved');
  const removeComment = () => run(() => remove.mutateAsync({ target: ref, undoReblog: false }), 'Comment removed');
  const undoReblog = () => run(() => remove.mutateAsync({ target: ref, undoReblog: true }), 'Reblog undone');

  return (
    <div className="flex flex-col gap-4" data-testid="quote-reblog-panel">
      <p className="text-sm text-muted-foreground" data-testid="reblog-dialog-description">
        {isReblogged
          ? existing
            ? 'You reblogged this post with a comment.'
            : 'You reblogged this post. You can add a comment to it.'
          : lite
            ? 'Your reblog stays on Lumen. A comment is published to Hive through Lumen.'
            : 'This post will be added to your blog and shared with your followers.'}
      </p>

      <div className="flex flex-col gap-1">
        <label htmlFor={boxId} className="sr-only">
          Add a comment (optional)
        </label>
        <Textarea
          id={boxId}
          value={caption}
          onChange={(e) => {
            setTouched(true);
            setCaption(e.target.value);
          }}
          placeholder="Add a comment (optional)"
          rows={3}
          disabled={busy}
          className="resize-none text-base"
          data-testid="quote-reblog-comment"
        />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{existing?.state === 'pending' ? 'Publishing to Hive' : ''}</span>
          <span className={tooLong ? 'text-destructive' : ''} data-testid="quote-reblog-count">
            {text.length} / {QUOTE_MAX_CHARS}
          </span>
        </div>
      </div>

      <div className="rounded-md border border-border px-3 py-2 text-sm">
        <div className="text-muted-foreground">{target.displayAuthor}</div>
        <div className="font-medium">{target.title || 'this post'}</div>
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert" data-testid="quote-reblog-error">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        {busy ? (
          <span className="mr-auto flex items-center gap-2 text-sm text-muted-foreground">
            <CircleSpinner loading size={14} color="currentColor" />
            {lite ? 'Saving...' : 'Waiting for your wallet...'}
          </span>
        ) : null}
        {isReblogged ? (
          <>
            <Button variant="outline" disabled={busy} onClick={undoReblog} data-testid="quote-reblog-undo">
              Undo reblog
            </Button>
            {existing ? (
              <Button variant="outline" disabled={busy} onClick={removeComment} data-testid="quote-reblog-remove">
                Remove comment
              </Button>
            ) : null}
            <Button
              disabled={busy || !text || tooLong || text === existing?.body}
              onClick={saveComment}
              data-testid="quote-reblog-save"
            >
              Save comment
            </Button>
          </>
        ) : (
          <Button disabled={busy || tooLong} onClick={reblog} data-testid="reblog-dialog-ok">
            Reblog
          </Button>
        )}
      </div>
    </div>
  );
}
