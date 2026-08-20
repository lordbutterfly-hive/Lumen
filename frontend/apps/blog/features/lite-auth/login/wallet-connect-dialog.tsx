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
 * Fallback path — manual, BTC only: paste an address, get the message, sign it in
 * any wallet, paste the signature back. Kept because it needs no project id, no
 * WalletConnect relay and no extension, so BTC sign-in still works if the
 * connector is unconfigured or a wallet is unsupported. EVM has no manual path —
 * hand-signing an EIP-191 payload is not a real user flow.
 */

// TODO i18n — staged copy while the redesign lands (mirrors app-header's LABELS
// precedent); move to locales/*/common_blog.json once final.
const COPY = {
  btc: {
    title: 'Continue with a Bitcoin wallet',
    connect: 'Connect a Bitcoin wallet',
    symbol: '₿',
    symbolBg: '#f7931a'
  },
  evm: {
    title: 'Continue with an Ethereum wallet',
    connect: 'Connect an Ethereum wallet',
    symbol: '◈',
    symbolBg: '#627eea'
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
              <span
                className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-full text-caption font-bold text-ink-27"
                style={{ backgroundColor: copy.symbolBg }}
              >
                {copy.symbol}
              </span>
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
