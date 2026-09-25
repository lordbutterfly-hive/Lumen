'use client';

import { FC, useEffect, useRef, useState } from 'react';
import {
  dmRecipientActor,
  useDmThreadWith,
  useDmThreads,
  useOwnDmRegistration
} from '../live/use-direct-messages';
import DmComposeModal from './dm-compose-modal';
import DmThreadView from './dm-thread-view';

/**
 * The DM inbox. Mounted on /inbox for every signed-in account, and inside the Studio's
 * Inbox section alongside (never merged with) the paid-ask escrow cards. Asks carry
 * money and deadlines; DMs do not, so they stay visually and structurally separate.
 *
 * `to` (from /inbox?to=, which the Meritum order popup links to) names one person:
 * their existing conversation opens, or, when there is none yet, the compose dialog
 * opens to them and the conversation opens once the first message is sent.
 *
 * Mounting this is what registers the creator's own public key (so senders can
 * encrypt to them) and decrypts every preview locally. The server stores only
 * ciphertext, so these strings exist only in this component.
 */

// TODO i18n - staged copy.
const COPY = {
  loading: 'Loading your messages…',
  failed: "Your messages couldn't be loaded just now. This is not an empty inbox.",
  retry: 'Try again',
  empty: 'No messages yet. When someone messages you, it lands here.',
  request: 'Request',
  you: 'You: ',
  undecryptable: "Couldn't decrypt on this device",
  noPreview: 'No messages yet',
  registering: 'Setting up your private messaging…',
  otherDevice:
    'Your messages are set up on another device or browser. Your key stays on the device that made it, so this one cannot read them. ' +
    'Open your inbox there once to turn on your messages for all your devices. We have not created a new key here, because doing that would make your existing messages unreadable everywhere, permanently.',
  keystoreBlocked:
    "Private messaging couldn't be set up in this browser. If it blocks site storage, messaging can't work here; otherwise reload to try again.",
  locked: (via: string) =>
    `Your messages are locked on this device. Unlock them once with ${via} and they stay readable here.`,
  unlock: 'Unlock messages',
  backUp: (via: string) =>
    `Your messages are only on this device for now. Turn them on for your other devices with one approval from ${via}.`,
  backUpWallet:
    'Your messages are only on this device for now. Turn them on for your other devices: your wallet asks you to sign twice, and the second signature checks that it signs the same way each time.',
  turnOn: 'Turn on',
  waiting: (via: string) => `Waiting for ${via}…`,
  deviceOnly: 'Your wallet signs differently each time, so your messages stay on this device only.',
  signedOut: 'Sign in to read your messages.'
};

function labelForActor(actorKey: string, name: string | null): string {
  // The server resolves each side's Lumen handle; the old fallbacks stay for an account
  // it cannot find.
  if (name) return `@${name}`;
  if (actorKey.startsWith('h:')) return `@${actorKey.slice(2)}`;
  return 'a Lumen member';
}

const DmInboxPanel: FC<{ to?: string | null }> = ({ to = null }) => {
  const registration = useOwnDmRegistration();
  const { threads, isLoading, isError, loggedIn, refetch } = useDmThreads();
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [composeTo, setComposeTo] = useState<string | null>(null);
  const withThread = useDmThreadWith(to ? dmRecipientActor(to) : null);
  // What has been done for `to` so far, so each step happens once: open the existing
  // thread, or open compose once and then the thread the first message created (the
  // send invalidates the lookup, which then finds it). Closing compose without
  // sending leaves the list, and nothing reopens it.
  const handled = useRef<'thread' | 'compose' | null>(null);
  useEffect(() => {
    if (!to) return;
    if (withThread.threadId && handled.current !== 'thread') {
      handled.current = 'thread';
      setOpenThreadId(withThread.threadId);
    } else if ((withThread.status === 'none' || withThread.status === 'error') && handled.current === null) {
      // A failed lookup still composes: the server files the message into the
      // existing thread by pair either way, so nothing is split.
      handled.current = 'compose';
      setComposeTo(to);
    }
  }, [to, withThread.threadId, withThread.status]);

  // Register this creator's public key on mount (idempotent). Without it, other
  // users see "hasn't set up messaging yet" on this creator's Message button.
  useEffect(() => {
    if (
      loggedIn &&
      !registration.ready &&
      !registration.registering &&
      !registration.orphaned &&
      !registration.locked
    )
      void registration.ensure();
    // ensure is stable per loggedIn; intentionally not re-run on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn]);

  if (!loggedIn) {
    return <p className="py-6 text-center font-ui text-caption text-ink-10">{COPY.signedOut}</p>;
  }

  // Where this device stands with the account's key, above the list AND above a thread
  // opened straight from a link, since both need it to read anything.
  const via = registration.approvalLabel ?? '';
  const button = (label: string, onClick: () => void, testid: string) => (
    <button
      type="button"
      onClick={onClick}
      disabled={registration.working}
      className="mt-2 rounded-control bg-surface-brand-12 px-3 py-1.5 font-ui text-caption font-medium text-ink-27 hover:bg-surface-brand-16 disabled:opacity-50"
      data-testid={testid}
    >
      {registration.working ? COPY.waiting(via) : label}
    </button>
  );
  const actionError = registration.actionError ? (
    <p className="mt-2 font-ui text-caption font-medium text-ink-warn-3" data-testid="dm-key-action-error">
      {registration.actionError}
    </p>
  ) : null;
  const status = registration.locked ? (
    <div
      className="rounded-panel border border-line-9 bg-surface-1 px-5 py-3 font-ui text-caption text-ink-2"
      data-testid="dm-locked"
    >
      {COPY.locked(via)}
      <div>{button(COPY.unlock, () => void registration.unlock(), 'dm-unlock')}</div>
      {actionError}
    </div>
  ) : registration.orphaned ? (
    // ★ NOT an error, and deliberately ranked above one: nothing failed. This
    // browser simply does not hold the key, and the honest thing is to say so
    // rather than mint a new one and silently end the existing conversations.
    <div className="rounded-panel border border-line-warn-1 bg-surface-warn-2 px-5 py-3 font-ui text-caption font-medium text-ink-warn-3">
      {COPY.otherDevice}
    </div>
  ) : registration.error ? (
    <div className="rounded-panel border border-line-warn-1 bg-surface-warn-2 px-5 py-3 font-ui text-caption font-medium text-ink-warn-3">
      {COPY.keystoreBlocked}
    </div>
  ) : registration.registering ? (
    <div className="rounded-panel border border-line-9 bg-surface-1 px-5 py-3 font-ui text-caption text-ink-10">
      {COPY.registering}
    </div>
  ) : registration.deviceOnly ? (
    <div
      className="rounded-panel border border-line-9 bg-surface-1 px-5 py-3 font-ui text-caption text-ink-10"
      data-testid="dm-device-only"
    >
      {COPY.deviceOnly}
    </div>
  ) : registration.canBackUp ? (
    <div
      className="rounded-panel border border-line-9 bg-surface-1 px-5 py-3 font-ui text-caption text-ink-10"
      data-testid="dm-backup-offer"
    >
      {registration.viaWallet ? COPY.backUpWallet : COPY.backUp(via)}
      <div>{button(COPY.turnOn, () => void registration.backUp(), 'dm-backup-turn-on')}</div>
      {actionError}
    </div>
  ) : null;

  // The compose dialog must keep its place in the tree: the thread its first message
  // created opens behind it while it still says "Message sent" (see the return below).
  const compose = composeTo ? (
    <DmComposeModal recipientHandle={composeTo} onClose={() => setComposeTo(null)} />
  ) : null;

  // ONE return, the same three slots in the same order for both views, so the dialog
  // is never remounted when the view underneath it changes (a second return with its
  // own sibling list did exactly that once the status line was added to the thread view).
  return (
    <>
      {openThreadId && status ? <div className="mb-2.5">{status}</div> : null}
      {openThreadId ? (
        <div key="thread" className="rounded-panel border border-line-9 bg-surface-1 p-5">
          <DmThreadView threadId={openThreadId} onBack={() => setOpenThreadId(null)} />
        </div>
      ) : (
        <div key="list" className="flex flex-col gap-2.5" data-testid="dm-inbox-panel">
          {status}

          {isLoading ? (
            <div className="rounded-panel border border-line-9 bg-surface-1 py-6 text-center font-ui text-caption text-ink-10">
              {COPY.loading}
            </div>
          ) : isError ? (
            <div className="rounded-panel border border-line-9 bg-surface-1 py-6 text-center">
              <p className="font-ui text-caption text-ink-brand-2">{COPY.failed}</p>
              <button
                type="button"
                onClick={() => void refetch()}
                className="mt-2 rounded-control border border-line-12 bg-surface-1 px-3 py-1.5 font-ui text-caption font-medium text-ink-2 hover:border-line-28"
              >
                {COPY.retry}
              </button>
            </div>
          ) : threads.length === 0 ? (
            <div className="rounded-panel border border-line-9 bg-surface-1 py-6 text-center">
              <p className="font-serif text-sm italic text-ink-14">{COPY.empty}</p>
            </div>
          ) : (
            threads.map((t) => (
              <button
                key={t.threadId}
                type="button"
                onClick={() => setOpenThreadId(t.threadId)}
                className="w-full rounded-panel border border-line-9 bg-surface-1 p-4 text-left transition-colors hover:border-line-28"
                data-testid="dm-thread-row"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-ui text-[15px] font-medium leading-[24px] text-ink-2">
                    {labelForActor(t.otherActorKey, t.otherName)}
                  </span>
                  {t.status === 'request' ? (
                    <span className="rounded-full bg-surface-warn-2 px-2.5 py-0.5 font-ui text-caption font-medium text-ink-warn-3">
                      {COPY.request}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 truncate font-ui text-caption text-ink-10">
                  {t.previewUndecryptable ? (
                    <span className="italic text-ink-14">{COPY.undecryptable}</span>
                  ) : t.preview ? (
                    <>
                      {t.lastFromMe ? COPY.you : ''}
                      {t.preview}
                    </>
                  ) : (
                    <span className="text-ink-14">{COPY.noPreview}</span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      )}
      {compose}
    </>
  );
};

export default DmInboxPanel;
