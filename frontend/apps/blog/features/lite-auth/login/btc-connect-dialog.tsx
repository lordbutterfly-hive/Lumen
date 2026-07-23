'use client';

import { FC, useState } from 'react';
import { useLiteLogin, type BtcChallenge } from './use-lite-login';

// TODO i18n — staged copy while the redesign lands (mirrors app-header's LABELS
// precedent); move to locales/*/common_blog.json once final.
const COPY = {
  title: 'Continue with a Bitcoin wallet',
  addrLabel: 'Your Bitcoin address',
  addrPlaceholder: 'bc1q… or 1…',
  getMessage: 'Get sign-in message',
  signHeading: 'Sign to prove ownership',
  signHelp: 'Sign this message in your wallet — it’s free and moves no funds. Then paste the signature below.',
  sigPlaceholder: 'Paste the signature from your wallet',
  verify: 'Verify & sign in',
  working: 'Working…',
  cancel: 'Cancel',
  taproot:
    'Taproot addresses aren’t supported yet — use a SegWit (bc1q…) or legacy (1…) address.'
};

const isTaproot = (a: string) => /^(bc1p|tb1p)/i.test(a.trim());

interface Props {
  onClose: () => void;
  onAuthenticated: () => void;
  onNeedsName: () => void;
}

/**
 * Bitcoin sign-in sub-flow: enter address → fetch a single-use challenge from
 * /api/lite/auth/btc/challenge → sign the exact message in any BTC wallet →
 * verify at /api/lite/auth/btc/verify. Uses the real backend end-to-end.
 *
 * The signature is entered manually (BIP-137/322 signed message, no funds
 * moved). A one-click wallet connector (window.btc / WalletConnect) is a later
 * enhancement that would fill the address + signature fields automatically —
 * seamed here so the flow already works without an extension.
 */
const BtcConnectDialog: FC<Props> = ({ onClose, onAuthenticated, onNeedsName }) => {
  const { btcChallenge, btcVerify } = useLiteLogin();
  const [address, setAddress] = useState('');
  const [challenge, setChallenge] = useState<BtcChallenge | null>(null);
  const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taproot = isTaproot(address);

  const requestMessage = async () => {
    setError(null);
    setBusy(true);
    const res = await btcChallenge(address.trim());
    setBusy(false);
    if ('status' in res) setError(res.message);
    else setChallenge(res);
  };

  const verify = async () => {
    if (!challenge) return;
    setError(null);
    setBusy(true);
    const outcome = await btcVerify(address.trim(), signature.trim(), challenge.nonce);
    setBusy(false);
    if (outcome.status === 'authenticated') onAuthenticated();
    else if (outcome.status === 'needs_name') onNeedsName();
    else setError(outcome.message);
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(20,18,10,0.4)] p-5 backdrop-blur-[2px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[420px] max-w-full rounded-[20px] bg-white p-6 shadow-[0_20px_60px_rgba(20,18,10,0.25)]"
      >
        <div className="mb-[18px] flex items-center justify-between">
          <div className="font-serif text-xl font-semibold text-[#161511]">{COPY.title}</div>
          <button onClick={onClose} className="cursor-pointer border-0 bg-transparent text-[22px] leading-none text-[#9ca3af]">
            ×
          </button>
        </div>

        {/* Address */}
        <label className="mb-1.5 block text-[13px] font-semibold text-[#4b5563]">{COPY.addrLabel}</label>
        <div className="mb-3.5 flex items-center gap-2.5 rounded-xl border border-[#e4e6e9] px-[15px] py-3">
          <span className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full bg-[#f7931a] font-extrabold text-white">
            ₿
          </span>
          <input
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setChallenge(null);
            }}
            placeholder={COPY.addrPlaceholder}
            className="min-w-0 flex-1 border-0 font-sans text-sm font-semibold tabular-nums text-[#161511] outline-none placeholder:text-[#9ca3af]"
          />
        </div>

        {taproot ? (
          <div className="mb-4 flex gap-2.5 rounded-[11px] border border-[#f6e2c4] bg-[#fdf6ec] px-3.5 py-3">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#b45309" strokeWidth="2" className="mt-px flex-shrink-0">
              <path d="M12 9v4M12 17h.01M10.3 3.9l-8 14A2 2 0 004 21h16a2 2 0 001.7-3l-8-14a2 2 0 00-3.4 0z" />
            </svg>
            <p className="text-[12.5px] leading-[1.5] text-[#b45309]">{COPY.taproot}</p>
          </div>
        ) : !challenge ? (
          <button
            onClick={requestMessage}
            disabled={busy || address.trim().length < 8}
            className="h-12 w-full cursor-pointer rounded-xl bg-[#161511] text-[15px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? COPY.working : COPY.getMessage}
          </button>
        ) : (
          <div className="rounded-xl border border-[#ebebeb] bg-[#faf9f6] p-4">
            <div className="mb-2 text-sm font-semibold text-[#161511]">{COPY.signHeading}</div>
            <p className="mb-3 text-[13px] leading-[1.5] text-[#6b7280]">{COPY.signHelp}</p>
            <div className="mb-3 break-all rounded-[9px] border border-[#e4e6e9] bg-white px-3 py-2.5 font-mono text-[13px] text-[#161511]">
              {challenge.message}
            </div>
            <textarea
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              placeholder={COPY.sigPlaceholder}
              rows={3}
              className="w-full resize-none rounded-[9px] border border-[#e4e6e9] bg-white px-3 py-2.5 font-mono text-[12px] text-[#161511] outline-none placeholder:text-[#9ca3af] focus-visible:outline-2 focus-visible:outline-[#c0392b]"
            />
            <button
              onClick={verify}
              disabled={busy || signature.trim().length < 8}
              className="mt-3 h-12 w-full cursor-pointer rounded-xl bg-[#c0392b] text-[15px] font-semibold text-white hover:bg-[#a5301f] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? COPY.working : COPY.verify}
            </button>
          </div>
        )}

        {error ? <p className="mt-3 text-[13px] leading-[1.5] text-[#b45309]">{error}</p> : null}

        <button onClick={onClose} className="mt-2 h-10 w-full cursor-pointer border-0 bg-transparent text-[13.5px] font-semibold text-[#6b7280]">
          {COPY.cancel}
        </button>
      </div>
    </div>
  );
};

export default BtcConnectDialog;
