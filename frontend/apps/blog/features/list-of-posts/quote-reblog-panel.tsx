'use client';

import { useEffect, useId, useState } from 'react';
import { UserAvatarImg } from '@hive/ui';
import { toast } from '@ui/components/hooks/use-toast';
import { useStorageWithTTL } from '@ui/hooks/useStorageWithTTL';
import { StorageTTL } from '@ui/lib/storage-with-ttl';
import { cn } from '@ui/lib/utils';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { DEFAULT_PREFERENCES, type Preferences } from '@/blog/lib/utils';
import { QUOTE_MAX_CHARS } from '@/blog/lib/quote-reblog/quote-flow';
import { quoteErrorText, useMyQuote, useQuoteMutations, type QuoteTargetInfo } from './hooks/use-quote-reblog';
import { MiniPostCard } from './mini-post-card';

/** Where the comment goes, in two lines (owner, 2026-09-24: "you can't write an essay"). */
const COPY = {
  title: 'Reblog',
  hint: 'Add a comment and it shows above this post on your profile and in your followers’ feeds. Leave it empty to just reblog.',
  hintReblogged: 'You reblogged this. A comment shows above it on your profile and in your followers’ feeds.',
  hintOrphan: 'Your reblog was undone somewhere else, but your comment is still on Hive. Reblog again or remove it.',
  reblogAgain: 'Reblog again',
  placeholder: 'Add a comment (optional)',
  reblog: 'Reblog',
  save: 'Save comment',
  remove: 'Remove comment',
  undo: 'Undo reblog',
  publishing: 'Publishing to Hive',
  waitingWallet: 'Waiting for your wallet…',
  saving: 'Saving…'
};

const PILL_PRIMARY =
  'rounded-full bg-surface-brand-12 px-5 py-2 font-ui text-[14px] font-medium text-ink-27 hover:bg-surface-brand-16 disabled:opacity-50';
const PILL_SECONDARY =
  'rounded-full bg-surface-11 px-4 py-2 font-ui text-[14px] font-medium text-ink-4 hover:bg-surface-16 disabled:opacity-50';

/**
 * The reblog popup when reblog comments are on (spec v2 3.1), in Lumen's modal style
 * (the Meritum share sheet's header, close button and pills). ONE Reblog button, an
 * optional comment, and the post as a small card. Empty: a plain reblog, exactly as
 * before. Once reblogged, the same popup edits or removes the comment or undoes the
 * reblog (the comment always goes with it). The text survives a cancelled approval.
 */
export function QuoteReblogPanel({
  open,
  target,
  isReblogged,
  checking,
  onPlainReblog,
  onClose
}: {
  open: boolean;
  target: QuoteTargetInfo;
  isReblogged: boolean;
  checking: boolean;
  onPlainReblog: () => void;
  onClose: () => void;
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
  // Read even when not reblogged: a reblog undone on another site (PeakD) leaves the
  // comment on Hive, and only its writer is told (decision D8).
  const mine = useMyQuote(ref, open);
  const existing = mine.data ?? null;
  const orphan = !isReblogged && !!existing;
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
      onClose();
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
    <div className="p-6" data-testid="quote-reblog-panel">
      <div className="flex items-center gap-3">
        <h3 className="font-ui text-[20px] font-medium leading-[28px] text-ink-2">{COPY.title}</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto flex h-8 w-8 items-center justify-center rounded-control bg-surface-11 font-ui text-[16px] text-ink-7 hover:bg-surface-16"
          data-testid="reblog-dialog-close"
        >
          ×
        </button>
      </div>
      <p className="mt-1 font-ui text-caption text-ink-14" data-testid="reblog-dialog-description">
        {orphan ? COPY.hintOrphan : isReblogged ? COPY.hintReblogged : COPY.hint}
      </p>

      <div className="mt-4 flex gap-3">
        <UserAvatarImg
          username={user.username}
          src={user.avatarUrl || undefined}
          pixelSize={32}
          radiusClassName="rounded-full"
          className="mt-1 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <label htmlFor={boxId} className="sr-only">
            {COPY.placeholder}
          </label>
          <textarea
            id={boxId}
            value={caption}
            onChange={(e) => {
              setTouched(true);
              setCaption(e.target.value);
            }}
            placeholder={COPY.placeholder}
            rows={3}
            disabled={busy}
            className="block w-full resize-none rounded-control bg-surface-11 px-3.5 py-3 font-lora text-[16px] leading-[25px] text-ink-2 placeholder:text-ink-14 focus:outline-none focus:ring-1 focus:ring-line-9 disabled:opacity-60"
            data-testid="quote-reblog-comment"
          />
          <div className="mt-1 flex items-center justify-between font-ui text-caption text-ink-14">
            <span>{existing?.state === 'pending' ? COPY.publishing : ''}</span>
            <span className={cn(tooLong && 'text-destructive')} data-testid="quote-reblog-count">
              {text.length} / {QUOTE_MAX_CHARS}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-3">
        <MiniPostCard entry={target.entry} title={target.title} displayAuthor={target.displayAuthor} />
      </div>

      {error ? (
        <p className="mt-3 font-ui text-caption text-destructive" role="alert" data-testid="quote-reblog-error">
          {error}
        </p>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
        {busy ? (
          <span className="mr-auto font-ui text-caption text-ink-14">{lite ? COPY.saving : COPY.waitingWallet}</span>
        ) : isReblogged ? (
          <button
            type="button"
            onClick={undoReblog}
            className="mr-auto font-ui text-[14px] text-ink-14 underline-offset-4 hover:text-ink-2 hover:underline"
            data-testid="quote-reblog-undo"
          >
            {COPY.undo}
          </button>
        ) : null}
        {isReblogged ? (
          <>
            {existing ? (
              <button type="button" disabled={busy} onClick={removeComment} className={PILL_SECONDARY} data-testid="quote-reblog-remove">
                {COPY.remove}
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy || !text || tooLong || text === existing?.body}
              onClick={saveComment}
              className={PILL_PRIMARY}
              data-testid="quote-reblog-save"
            >
              {COPY.save}
            </button>
          </>
        ) : orphan ? (
          <>
            <button type="button" disabled={busy} onClick={removeComment} className={PILL_SECONDARY} data-testid="quote-reblog-remove">
              {COPY.remove}
            </button>
            <button
              type="button"
              disabled={busy || !text || tooLong}
              onClick={() => run(() => save.mutateAsync({ target, caption: text, alreadyReblogged: false }), 'Reblogged with your comment')}
              className={PILL_PRIMARY}
              data-testid="quote-reblog-again"
            >
              {COPY.reblogAgain}
            </button>
          </>
        ) : (
          <button type="button" disabled={busy || tooLong} onClick={reblog} className={PILL_PRIMARY} data-testid="reblog-dialog-ok">
            {COPY.reblog}
          </button>
        )}
      </div>
    </div>
  );
}
