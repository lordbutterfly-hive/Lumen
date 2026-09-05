'use client';

import { FC, useEffect, useMemo, useState } from 'react';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import ModalShell from '@/blog/features/creator-tokens/ui/modal-shell';
import {
  MAX_MESSAGE_CHARS,
  useOwnDmRegistration,
  useRecipientKey,
  useSendMessage
} from '../live/use-direct-messages';

/**
 * Compose a first message to a creator. Everything typed here is encrypted on this
 * device before it is sent (`../live/use-direct-messages` -> `../lib/dm-crypto`); the
 * server only ever receives ciphertext. The copy says so, and it is true by
 * construction, not by promise.
 *
 * The recipient is named by a display handle. The server is the authority on turning
 * that into an actor, so this only strips the `hive:` prefix the token page carries
 * and hands the rest through unchanged.
 */

// TODO i18n - staged copy, same precedent as the creator-tokens feature.
const COPY = {
  title: (h: string) => `Message @${h}`,
  placeholder: (h: string) => `Write to @${h}…`,
  privacy: "Encrypted on your device. Lumen and the server can't read it.",
  signIn: 'Sign in to send a message.',
  checking: 'Checking whether this creator can receive messages…',
  notSetUp: "This creator hasn't set up messaging yet, so you can't message them right now.",
  keyError: "We couldn't check this creator's messaging right now. Try again in a moment.",
  selfMessage: "This is you, so there's no one to message here.",
  noKeystore: 'Private messaging needs local storage this browser has turned off, so it is unavailable here.',
  send: 'Send message',
  sending: 'Sending…',
  sentTitle: 'Message sent',
  sentBody: (h: string) => `@${h} will see it in their Lumen inbox. Their reply lands in yours.`,
  done: 'Done',
  tooLong: 'That message is too long.'
};

const DmComposeModal: FC<{ recipientHandle: string; onClose: () => void }> = ({ recipientHandle, onClose }) => {
  const { user, isHydrated } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;

  // Strip only the `hive:` prefix; leave bare handles and DIDs for the server to
  // resolve. Used identically for the key lookup and the send, so the two never drift.
  const recipientActor = useMemo(
    () => (recipientHandle.startsWith('hive:') ? recipientHandle.slice('hive:'.length) : recipientHandle),
    [recipientHandle]
  );
  const displayName = recipientActor;

  const isSelf = loggedIn && !!user.username && user.username.toLowerCase() === recipientActor.toLowerCase();

  const registration = useOwnDmRegistration();
  const recipient = useRecipientKey(loggedIn && !isSelf ? recipientActor : null);
  const send = useSendMessage();

  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A registration that failed because there is no local keystore is a distinct,
  // honest state - the send would never succeed, so say why.
  const keystoreBlocked = registration.error;

  useEffect(() => {
    // Reset transient state if the modal is reused for a different recipient.
    setText('');
    setSent(false);
    setError(null);
  }, [recipientActor]);

  const trimmed = text.trim();
  const tooLong = text.length > MAX_MESSAGE_CHARS;
  const canSend =
    loggedIn &&
    !isSelf &&
    !keystoreBlocked &&
    recipient.status === 'ready' &&
    !!recipient.publicKey &&
    trimmed.length > 0 &&
    !tooLong &&
    !send.isLoading;

  const submit = async () => {
    if (!canSend || !recipient.publicKey) return;
    setError(null);
    try {
      // Make sure this browser's own public key is registered, so the creator can
      // reply. Best-effort: a failure here does not block the outgoing message.
      if (!registration.ready) await registration.ensure();
      await send.mutateAsync({
        recipientActor,
        recipientPublicKey: recipient.publicKey,
        recipientKeyVersion: recipient.keyVersion,
        plaintext: trimmed
      });
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That message did not go through.');
    }
  };

  return (
    <ModalShell width={500} onClose={onClose} title={COPY.title(displayName)}>
      <div className="flex items-center justify-between px-6 pt-[22px]">
        <div className="font-ui text-[22px] leading-[32px] font-medium text-ink-2">{COPY.title(displayName)}</div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="-my-2 -mx-4 cursor-pointer rounded-lg border-0 bg-transparent px-4 py-2 text-[22px] leading-[34px] text-ink-14 hover:bg-surface-16"
        >
          ×
        </button>
      </div>

      <div className="px-6 pb-6 pt-[18px]">
        {sent ? (
          <div data-testid="dm-compose-sent">
            <div className="font-ui text-[15px] leading-[24px] font-medium text-ink-2">{COPY.sentTitle}</div>
            <p className="mt-1 font-ui text-caption text-ink-12">{COPY.sentBody(displayName)}</p>
            <button
              onClick={onClose}
              className="mt-4 w-full rounded-card bg-surface-brand-12 py-[13px] font-ui text-[15px] leading-[24px] font-medium text-ink-27 hover:bg-surface-brand-16"
            >
              {COPY.done}
            </button>
          </div>
        ) : !loggedIn ? (
          <p className="py-2 font-ui text-[15px] leading-[24px] text-ink-10">{COPY.signIn}</p>
        ) : isSelf ? (
          <p className="py-2 font-ui text-[15px] leading-[24px] text-ink-10">{COPY.selfMessage}</p>
        ) : keystoreBlocked ? (
          <p className="py-2 font-ui text-[15px] leading-[24px] text-ink-warn-3">{COPY.noKeystore}</p>
        ) : recipient.status === 'loading' || recipient.status === 'idle' ? (
          <p className="py-2 font-ui text-[15px] leading-[24px] text-ink-10">{COPY.checking}</p>
        ) : recipient.status === 'unregistered' ? (
          <p className="py-2 font-ui text-[15px] leading-[24px] text-ink-10" data-testid="dm-recipient-unregistered">
            {COPY.notSetUp}
          </p>
        ) : recipient.status === 'error' ? (
          <p className="py-2 font-ui text-[15px] leading-[24px] text-ink-warn-3">{COPY.keyError}</p>
        ) : (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={MAX_MESSAGE_CHARS + 1}
              placeholder={COPY.placeholder(displayName)}
              className="h-[140px] w-full resize-y rounded-xl border border-line-11 px-4 py-3.5 font-ui text-[15px] leading-[24px] text-ink-2 outline-none focus-visible:outline-none focus:border-line-brand-10"
              data-testid="dm-compose-textarea"
            />
            <div className="my-2 mb-3.5 flex items-center justify-between gap-3">
              <span className="text-caption text-ink-12 font-ui">🔒 {COPY.privacy}</span>
              {tooLong ? <span className="text-caption font-medium text-ink-warn-3 font-ui">{COPY.tooLong}</span> : null}
            </div>
            {error ? (
              <div className="mb-3.5 rounded-xl border border-line-warn-2 bg-surface-warn-4 px-4 py-3 text-[14px] leading-[22px] font-medium text-ink-warn-3 font-ui">
                {error}
              </div>
            ) : null}
            <button
              onClick={() => void submit()}
              disabled={!canSend}
              className="w-full rounded-card bg-surface-brand-12 py-[15px] font-ui text-[15px] leading-[24px] font-medium text-ink-27 hover:bg-surface-brand-16 disabled:opacity-50"
              data-testid="dm-compose-send"
            >
              {send.isLoading ? COPY.sending : COPY.send}
            </button>
          </>
        )}
      </div>
    </ModalShell>
  );
};

export default DmComposeModal;
