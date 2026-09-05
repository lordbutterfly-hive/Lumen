'use client';

import { FC, useEffect, useRef, useState } from 'react';
import { MAX_MESSAGE_CHARS, useDmThread } from '../live/use-direct-messages';

/**
 * One conversation, decrypted in the browser. Every bubble here was ciphertext until
 * this component ran `decrypt` on it; the server never had the text. A message that
 * cannot be decrypted (the other side rotated or never registered a key) is shown as
 * an honest placeholder rather than blank or garbled.
 *
 * Direction ("you" vs them) is drawn ONLY when the server tags a message with its
 * sender; when it does not, the message is shown without a false left/right claim.
 */

// TODO i18n - staged copy.
const COPY = {
  back: '‹ All messages',
  request: 'Message request',
  loading: 'Decrypting this conversation…',
  failed: "This conversation couldn't be loaded. It is not necessarily empty.",
  empty: 'No messages in this conversation yet.',
  undecryptable: "This message couldn't be decrypted on this device.",
  placeholder: 'Write a reply…',
  send: 'Send',
  sending: 'Sending…',
  privacy: "Encrypted on your device. Lumen can't read it."
};

function labelForActor(actorKey: string | null): string {
  if (!actorKey) return 'this person';
  if (actorKey.startsWith('h:')) return `@${actorKey.slice(2)}`;
  // A lite (`u:<id>`) counterparty has no handle to show; name them by role, not id.
  return 'a Lumen member';
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const DmThreadView: FC<{ threadId: string; onBack?: () => void }> = ({ threadId, onBack }) => {
  const thread = useDmThread(threadId);
  const [reply, setReply] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  // Newest message sits at the bottom (normal DM order); keep it in view by pinning
  // the scroll to the bottom whenever the message set changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.messages.length, thread.isLoading]);

  const trimmed = reply.trim();
  const tooLong = reply.length > MAX_MESSAGE_CHARS;
  const canSend = trimmed.length > 0 && !tooLong && !thread.sending && !!thread.otherActorKey;

  const submit = async () => {
    if (!canSend) return;
    const ok = await thread.reply(trimmed);
    if (ok) setReply('');
  };

  return (
    <div className="flex flex-col" data-testid="dm-thread-view">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="rounded-control border-0 bg-transparent px-1 py-1 font-ui text-caption font-medium text-ink-10 hover:text-ink-2"
            >
              {COPY.back}
            </button>
          ) : null}
          <span className="font-ui text-[15px] leading-[24px] font-medium text-ink-2">
            {labelForActor(thread.otherActorKey)}
          </span>
        </div>
        {thread.status === 'request' ? (
          <span className="rounded-full bg-surface-warn-2 px-2.5 py-0.5 font-ui text-caption font-medium text-ink-warn-3">
            {COPY.request}
          </span>
        ) : null}
      </div>

      <div ref={scrollRef} className="flex max-h-[420px] min-h-[120px] flex-col gap-2 overflow-y-auto py-1">
        {thread.isLoading ? (
          <p className="py-6 text-center font-ui text-caption text-ink-10">{COPY.loading}</p>
        ) : thread.isError ? (
          <p className="py-6 text-center font-ui text-caption text-ink-warn-3">{COPY.failed}</p>
        ) : thread.messages.length === 0 ? (
          <p className="py-6 text-center font-serif text-sm italic text-ink-14">{COPY.empty}</p>
        ) : (
          thread.messages.map((m) => {
            const mine = m.fromMe === true;
            return (
              <div
                key={m.messageId}
                className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
                  mine ? 'ml-auto bg-surface-brand-12 text-ink-27' : 'mr-auto bg-surface-16 text-ink-2'
                }`}
              >
                {m.undecryptable ? (
                  <span className={`font-ui text-caption italic ${mine ? 'text-ink-27' : 'text-ink-10'}`}>
                    {COPY.undecryptable}
                  </span>
                ) : (
                  <span className="whitespace-pre-wrap break-words font-ui text-[15px] leading-[22px]">{m.text}</span>
                )}
                <div className={`mt-1 font-ui text-[11px] leading-none ${mine ? 'text-ink-27/70' : 'text-ink-12'}`}>
                  {shortTime(m.createdAt)}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="mt-3 border-t border-line-9 pt-3">
        <textarea
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          maxLength={MAX_MESSAGE_CHARS + 1}
          placeholder={COPY.placeholder}
          className="h-[72px] w-full resize-y rounded-xl border border-line-11 px-4 py-2.5 font-ui text-[15px] leading-[22px] text-ink-2 outline-none focus-visible:outline-none focus:border-line-brand-10"
          data-testid="dm-reply-textarea"
        />
        {thread.sendError ? (
          <div className="mt-2 rounded-lg border border-line-warn-2 bg-surface-warn-4 px-3 py-2 font-ui text-caption font-medium text-ink-warn-3">
            {thread.sendError}
          </div>
        ) : null}
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="font-ui text-caption text-ink-12">🔒 {COPY.privacy}</span>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend}
            className="rounded-card bg-surface-brand-12 px-5 py-2 font-ui text-[14px] leading-[22px] font-medium text-ink-27 hover:bg-surface-brand-16 disabled:opacity-50"
            data-testid="dm-reply-send"
          >
            {thread.sending ? COPY.sending : COPY.send}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DmThreadView;
