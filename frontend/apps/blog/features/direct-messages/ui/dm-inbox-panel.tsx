'use client';

import { FC, useEffect, useState } from 'react';
import { useDmThreads, useOwnDmRegistration } from '../live/use-direct-messages';
import DmThreadView from './dm-thread-view';

/**
 * The creator's DM inbox, mounted inside the Studio's Inbox section alongside (never
 * merged with) the paid-ask escrow cards. Asks carry money and deadlines; DMs do not,
 * so they stay visually and structurally separate.
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
  keystoreBlocked:
    "Private messaging needs local storage this browser has turned off, so you can't receive messages here.",
  signedOut: 'Sign in to read your messages.'
};

function labelForActor(actorKey: string): string {
  if (actorKey.startsWith('h:')) return `@${actorKey.slice(2)}`;
  return 'a Lumen member';
}

const DmInboxPanel: FC = () => {
  const registration = useOwnDmRegistration();
  const { threads, isLoading, isError, loggedIn, refetch } = useDmThreads();
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);

  // Register this creator's public key on mount (idempotent). Without it, other
  // users see "hasn't set up messaging yet" on this creator's Message button.
  useEffect(() => {
    if (loggedIn && !registration.ready && !registration.registering) void registration.ensure();
    // ensure is stable per loggedIn; intentionally not re-run on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn]);

  if (!loggedIn) {
    return <p className="py-6 text-center font-ui text-caption text-ink-10">{COPY.signedOut}</p>;
  }

  if (openThreadId) {
    return (
      <div className="rounded-panel border border-line-9 bg-surface-1 p-5">
        <DmThreadView threadId={openThreadId} onBack={() => setOpenThreadId(null)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5" data-testid="dm-inbox-panel">
      {registration.error ? (
        <div className="rounded-panel border border-line-warn-1 bg-surface-warn-2 px-5 py-3 font-ui text-caption font-medium text-ink-warn-3">
          {COPY.keystoreBlocked}
        </div>
      ) : registration.registering ? (
        <div className="rounded-panel border border-line-9 bg-surface-1 px-5 py-3 font-ui text-caption text-ink-10">
          {COPY.registering}
        </div>
      ) : null}

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
              <span className="font-ui text-[15px] leading-[24px] font-medium text-ink-2">
                {labelForActor(t.otherActorKey)}
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
  );
};

export default DmInboxPanel;
