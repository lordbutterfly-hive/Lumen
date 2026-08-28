'use client';

import { FC, useState } from 'react';
import { Dialog, DialogContentBare, DialogDescription, DialogTitle } from '@ui/components/dialog';
import { useLiteLogin, type WalletChain } from './use-lite-login';
import {
  connectWallet,
  signMessageWith,
  walletConnectAvailable,
  walletErrorMessage,
} from '../wallet/appkit';

/**
 * Wallet sign-in sub-flow for BOTH chains (Bitcoin `bip122`, EVM `eip155`).
 *
 * Primary path — Reown AppKit, one click:
 *   connect -> address -> /api/lite/auth/{chain}/challenge -> sign the exact
 *   message in the wallet -> /api/lite/auth/{chain}/verify
 * The address must be known before the challenge is requested: the server binds
 * every nonce to one address (SEQ-1).
 *
 * THERE IS NO FALLBACK PATH, and this comment used to say there was.
 *
 * A manual BTC route once lived here: paste an address, get the message, sign it
 * somewhere else, paste the signature back. It was removed on 2026-08-20 and this
 * header was not updated with it, so the file went on describing an
 * implementation that no longer existed below it. Altera, the reference client,
 * has no such path either: its login is three controls and nothing else
 * (`routes/login/+page.svelte:216-251`).
 *
 * The reason it had to go is not tidiness. A manual sign-in authenticates the
 * account and establishes NO SIGNER, so the session works and then every buy,
 * sell, send and ask fails at signing time with nothing on screen to explain it.
 * An account that can log in but can never transact is worse than one that
 * cannot log in.
 *
 * Do not reintroduce it. If a wallet is unsupported or the connector is
 * unconfigured, the honest answer is to say so, not to mint a session that
 * cannot sign.
 */

// TODO i18n — staged copy while the redesign lands (mirrors app-header's LABELS
// precedent); move to locales/*/common_blog.json once final.
const COPY = {
  btc: {
    title: 'Continue with a Bitcoin wallet',
    connect: 'Connect a Bitcoin wallet'
  },
  evm: {
    title: 'Continue with an Ethereum wallet',
    connect: 'Connect an Ethereum wallet'
  },
  shared: {
    connectHelp: 'You’ll approve a signature. It’s free, moves no funds and authorizes no transaction.',
    // ★ SAY THE LIMIT BEFORE THEY RELY ON IT (QA, 2026-08-20). Signing in this
    // way authenticates perfectly and establishes NO signer, because every money
    // action goes through a connected wallet provider. So a reader who chose
    // this path could browse, hold and be paid, and then hit a hard refusal the
    // first time they tried to buy — at the till, with no warning. The
    // limitation is real and structural; the surprise was avoidable.
    working: 'Working…',
    connecting: 'Waiting for your wallet…',
    cancel: 'Cancel',
    taproot: 'Taproot addresses aren’t supported yet. Use a SegWit (bc1q…) or legacy (1…) address.',
    unconfigured: 'One-click wallet connect isn’t set up on this deployment yet.'
  }
};

interface Props {
  chain: WalletChain;
  onClose: () => void;
  onAuthenticated: () => void;
  onNeedsName: () => void;
}

/**
 * SAME MARK AS THE LOGIN ROW (2026-08-28). This dialog used to draw its own
 * icon: a plain circle with a unicode glyph on it (₿ / ◈), coloured with its
 * own hex values (`#f7931a`, `#627eea`). That made the EVM one in particular
 * read as an unfamiliar "weird blue icon" next to the real Ethereum diamond
 * the row uses one screen away. There is no reason for the two surfaces to
 * disagree about what a Bitcoin or Ethereum mark looks like, so this renders
 * the exact same artwork as `lumen-login.tsx`'s wallet rows — same asset for
 * BTC, same inline Ethereum diamond SVG for EVM — in the same shared 34px /
 * 10px-radius box (`rounded-control`) documented there.
 */
const Icon: FC<{ chain: WalletChain }> = ({ chain }) =>
  chain === 'btc' ? (
    <img
      src="/logos/bitcoin.png"
      alt=""
      aria-hidden
      width={34}
      height={34}
      className="h-[34px] w-[34px] flex-shrink-0 rounded-control"
    />
  ) : (
    <span
      aria-hidden
      className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-control bg-surface-info-3"
    >
      <svg width="20" height="20" viewBox="0 0 256 417" aria-hidden>
        <path fill="#343434" d="M127.96 0l-2.8 9.5v275.7l2.8 2.8 127.96-75.6z" />
        <path fill="#8C8C8C" d="M127.96 0L0 212.4l127.96 75.6V154.2z" />
        <path fill="#3C3C3B" d="M127.96 312.19l-1.58 1.92v98.2l1.58 4.6L256 236.59z" />
        <path fill="#8C8C8C" d="M127.96 416.9v-104.7L0 236.6z" />
        <path fill="#141414" d="M127.96 287.96l127.96-75.6-127.96-58.16z" />
        <path fill="#393939" d="M0 212.36l127.96 75.6V154.2z" />
      </svg>
    </span>
  );

const WalletConnectDialog: FC<Props> = ({ chain, onClose, onAuthenticated, onNeedsName }) => {
  const { walletChallenge, walletVerify } = useLiteLogin();
  const copy = COPY[chain];
  const S = COPY.shared;

  const connectorReady = walletConnectAvailable();
  const [address, setAddress] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // NOTE: the taproot refusal itself lives in `signMessageWith` (appkit.ts),
  // which disconnects and throws `taproot_unsupported`. Nothing computes it here
  // any more now that the manual address field is gone.

  const settle = (outcome: { status: string; message?: string }) => {
    if (outcome.status === 'authenticated') onAuthenticated();
    else if (outcome.status === 'needs_name') onNeedsName();
    else setError(outcome.message || S.taproot);
  };

  /** One-click: connect, challenge, sign, verify. */
  const connectAndVerify = async () => {
    setError(null);
    setConnecting(true);
    try {
      const addr = await connectWallet(chain);
      setAddress(addr);
      const ch = await walletChallenge(chain, addr);
      if ('status' in ch) {
        setError(ch.message);
        return;
      }
      const sig = await signMessageWith(chain, addr, ch.message);
      settle(await walletVerify(chain, addr, sig, ch.nonce));
    } catch (err) {
      setError(walletErrorMessage(err));
    } finally {
      setConnecting(false);
    }
  };

  // Same real Radix `Dialog` treatment as the creator-token money modals
  // (features/creator-tokens/ui/modal-shell.tsx) — role="dialog", aria-modal,
  // a focus trap, Escape-to-close and outside-click-to-close, instead of a
  // hand-rolled backdrop `onClick`/`stopPropagation` pair with none of that.
  // Found during the section-6 accessibility sweep, not on the original
  // list — same pattern, same fix, on a login-flow dialog instead of a
  // money one.
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContentBare
        overlayClassName="bg-[rgba(20,18,10,0.4)] backdrop-blur-[2px]"
        wrapperClassName="p-5 py-12"
        className="w-[420px] max-w-full rounded-panel bg-surface-1 p-6 shadow-[0_20px_60px_rgba(20,18,10,0.25)] focus:outline-none"
      >
        <DialogTitle className="sr-only">{copy.title}</DialogTitle>
        <DialogDescription className="sr-only">{copy.title}</DialogDescription>
        <div className="mb-[18px] flex items-center justify-between">
          <div className="font-serif text-xl font-semibold text-ink-2">{copy.title}</div>
          <button
            onClick={onClose}
            className="cursor-pointer border-0 bg-transparent text-[22px] leading-[34px] leading-none text-ink-14"
          >
            ×
          </button>
        </div>

        <>
            <p className="mb-4 text-caption text-ink-10">{S.connectHelp}</p>
            <button
              onClick={connectAndVerify}
              disabled={connecting || !connectorReady}
              className="flex h-12 w-full cursor-pointer items-center justify-center gap-2.5 rounded-xl bg-surface-43 text-[15px] leading-[24px] font-semibold text-ink-27 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon chain={chain} />
              {connecting ? S.connecting : copy.connect}
            </button>
            {!connectorReady ? (
              <p className="mt-3 text-caption text-ink-warn-3">{S.unconfigured}</p>
            ) : null}
        </>

        {error ? <p className="mt-3 text-caption text-ink-warn-3">{error}</p> : null}

        <button
          onClick={onClose}
          className="mt-2 h-10 w-full cursor-pointer border-0 bg-transparent text-[14px] leading-[22px] font-semibold text-ink-10"
        >
          {S.cancel}
        </button>
      </DialogContentBare>
    </Dialog>
  );
};

export default WalletConnectDialog;
