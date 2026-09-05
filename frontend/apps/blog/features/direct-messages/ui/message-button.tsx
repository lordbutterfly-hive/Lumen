'use client';

import { FC, useState } from 'react';
import DmComposeModal from './dm-compose-modal';

/**
 * A self-contained "Message" button + its compose modal. Used where the surface has
 * no dialog machinery of its own (the profile token card). On the token page the
 * button is drawn inline and routed through the shared TokenModals instead, so this
 * component is not used there.
 *
 * The button is intentionally dumb: it opens the modal, and the modal owns every
 * honest state (signed out, recipient not set up, blocked). Rendering the button is
 * the caller's decision - the profile card only mounts it for a launched creator on
 * someone else's profile.
 */

const DEFAULT_CLASS =
  'shrink-0 rounded-xl border border-line-11 bg-surface-1 px-7 py-3 font-ui text-[15px] leading-[24px] font-medium text-ink-7 transition-colors hover:bg-surface-16';

const MessageButton: FC<{ handle: string; className?: string; label?: string }> = ({
  handle,
  className,
  label = 'Message'
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={className ?? DEFAULT_CLASS}
        data-testid="dm-message-button"
      >
        {label}
      </button>
      {open ? <DmComposeModal recipientHandle={handle} onClose={() => setOpen(false)} /> : null}
    </>
  );
};

export default MessageButton;
