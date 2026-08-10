'use client';

import { FC, useState } from 'react';
import { Dialog, DialogContentBare, DialogDescription, DialogTitle } from '@ui/components/dialog';
import { useLiteLogin, type WalletChallenge, type WalletChain } from './use-lite-login';
import {
  connectWallet,
  signMessageWith,
  walletConnectAvailable,
  walletErrorMessage,
  isTaprootAddress
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
    addrLabel: 'Your Bitcoin address',
    addrPlaceholder: 'bc1q… or 1…',
    symbol: '₿',
    symbolBg: '#f7931a'
  },
  evm: {
    title: 'Continue with an Ethereum wallet',
    connect: 'Connect an Ethereum wallet',
    addrLabel: 'Your wallet address',
    addrPlaceholder: '0x…',
    symbol: '◈',
    symbolBg: '#627eea'
  },
  shared: {
    connectHelp: 'You’ll approve a signature. It’s free, moves no funds and authorizes no transaction.',
    manualToggle: 'Sign manually instead',
    connectToggle: 'Use a connected wallet instead',
    getMessage: 'Get sign-in message',
    signHeading: 'Sign to prove ownership',
    signHelp:
      'Sign this message in your wallet. It’s free and moves no funds. Then paste the signature below.',
    sigPlaceholder: 'Paste the signature from your wallet',
    verify: 'Verify & sign in',
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
  // EVM has no manual path, so an unconfigured connector leaves nothing to do.
  const [manual, setManual] = useState(chain === 'btc' && !connectorReady);
  const [address, setAddress] = useState('');
  const [challenge, setChallenge] = useState<WalletChallenge | null>(null);
  const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taproot = chain === 'btc' && isTaprootAddress(address);

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

  const requestMessage = async () => {
    setError(null);
    setBusy(true);
    const res = await walletChallenge(chain, address.trim());
    setBusy(false);
    if ('status' in res) setError(res.message);
    else setChallenge(res);
  };

  const verifyManual = async () => {
    if (!challenge) return;
    setError(null);
    setBusy(true);
    const outcome = await walletVerify(chain, address.trim(), signature.trim(), challenge.nonce);
    setBusy(false);
    settle(outcome);
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
        className="w-[420px] max-w-full rounded-[20px] bg-white p-6 shadow-[0_20px_60px_rgba(20,18,10,0.25)] focus:outline-none"
      >
        <DialogTitle className="sr-only">{copy.title}</DialogTitle>
        <DialogDescription className="sr-only">{copy.title}</DialogDescription>
        <div className="mb-[18px] flex items-center justify-between">
          <div className="font-serif text-xl font-semibold text-[#161511]">{copy.title}</div>
          <button
            onClick={onClose}
            className="cursor-pointer border-0 bg-transparent text-[22px] leading-none text-[#9ca3af]"
          >
            ×
          </button>
        </div>

        {!manual ? (
          <>
            <p className="mb-4 text-[13px] leading-[1.5] text-[#6b7280]">{S.connectHelp}</p>
            <button
              onClick={connectAndVerify}
              disabled={connecting || !connectorReady}
              className="flex h-12 w-full cursor-pointer items-center justify-center gap-2.5 rounded-xl bg-[#161511] text-[15px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span
                className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-full text-[13px] font-extrabold text-white"
                style={{ backgroundColor: copy.symbolBg }}
              >
                {copy.symbol}
              </span>
              {connecting ? S.connecting : copy.connect}
            </button>
            {!connectorReady ? (
              <p className="mt-3 text-[12.5px] leading-[1.5] text-[#b45309]">{S.unconfigured}</p>
            ) : null}
            {chain === 'btc' ? (
              <button
                onClick={() => setManual(true)}
                className="mt-3 h-10 w-full cursor-pointer border-0 bg-transparent text-[13.5px] font-semibold text-[#6b7280]"
              >
                {S.manualToggle}
              </button>
            ) : null}
          </>
        ) : (
          <>
            <label className="mb-1.5 block text-[13px] font-semibold text-[#4b5563]">{copy.addrLabel}</label>
            <div className="mb-3.5 flex items-center gap-2.5 rounded-xl border border-[#e4e6e9] px-[15px] py-3">
              <span
                className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full font-extrabold text-white"
                style={{ backgroundColor: copy.symbolBg }}
              >
                {copy.symbol}
              </span>
              <input
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  setChallenge(null);
                }}
                placeholder={copy.addrPlaceholder}
                className="min-w-0 flex-1 border-0 font-sans text-sm font-semibold tabular-nums text-[#161511] outline-none placeholder:text-[#9ca3af]"
              />
            </div>

            {taproot ? (
              <div className="mb-4 flex gap-2.5 rounded-[11px] border border-[#f6e2c4] bg-[#fdf6ec] px-3.5 py-3">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#b45309"
                  strokeWidth="2"
                  className="mt-px flex-shrink-0"
                >
                  <path d="M12 9v4M12 17h.01M10.3 3.9l-8 14A2 2 0 004 21h16a2 2 0 001.7-3l-8-14a2 2 0 00-3.4 0z" />
                </svg>
                <p className="text-[12.5px] leading-[1.5] text-[#b45309]">{S.taproot}</p>
              </div>
            ) : !challenge ? (
              <button
                onClick={requestMessage}
                disabled={busy || address.trim().length < 8}
                className="h-12 w-full cursor-pointer rounded-xl bg-[#161511] text-[15px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? S.working : S.getMessage}
              </button>
            ) : (
              <div className="rounded-xl border border-[#ebebeb] bg-[#faf9f6] p-4">
                <div className="mb-2 text-sm font-semibold text-[#161511]">{S.signHeading}</div>
                <p className="mb-3 text-[13px] leading-[1.5] text-[#6b7280]">{S.signHelp}</p>
                <div className="mb-3 whitespace-pre-wrap break-all rounded-[9px] border border-[#e4e6e9] bg-white px-3 py-2.5 font-mono text-[13px] text-[#161511]">
                  {challenge.message}
                </div>
                <textarea
                  value={signature}
                  onChange={(e) => setSignature(e.target.value)}
                  placeholder={S.sigPlaceholder}
                  rows={3}
                  className="w-full resize-none rounded-[9px] border border-[#e4e6e9] bg-white px-3 py-2.5 font-mono text-[12px] text-[#161511] outline-none placeholder:text-[#9ca3af] focus-visible:outline-2 focus-visible:outline-[#c0392b]"
                />
                <button
                  onClick={verifyManual}
                  disabled={busy || signature.trim().length < 8}
                  className="mt-3 h-12 w-full cursor-pointer rounded-xl bg-[#c0392b] text-[15px] font-semibold text-white hover:bg-[#a5301f] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? S.working : S.verify}
                </button>
              </div>
            )}

            {connectorReady ? (
              <button
                onClick={() => {
                  setManual(false);
                  setChallenge(null);
                  setError(null);
                }}
                className="mt-3 h-10 w-full cursor-pointer border-0 bg-transparent text-[13.5px] font-semibold text-[#6b7280]"
              >
                {S.connectToggle}
              </button>
            ) : null}
          </>
        )}

        {error ? <p className="mt-3 text-[13px] leading-[1.5] text-[#b45309]">{error}</p> : null}

        <button
          onClick={onClose}
          className="mt-2 h-10 w-full cursor-pointer border-0 bg-transparent text-[13.5px] font-semibold text-[#6b7280]"
        >
          {S.cancel}
        </button>
      </DialogContentBare>
    </Dialog>
  );
};

export default WalletConnectDialog;
