'use client';

import { FC, useEffect, useState } from 'react';
import DialogLogin from '@/blog/components/dialog-login';

// TODO i18n — staged copy; move to locales/*/common_blog.json once final.
const COPY = {
  toggle: 'Already have a Hive account?',
  sub: 'Sign in with a Hive key method — your keys never leave your device.',
  detected: 'Detected',
  install: 'Not detected — install',
  coming: 'Coming'
};

type MethodTag = 'none' | 'detected' | 'install' | 'coming';

interface Method {
  name: string;
  hint: string;
  glyph: string;
  bg: string;
  tag?: MethodTag;
}

// Order matches prompts/LOGIN.md. Google Drive is deliberately labelled as
// key-BACKUP restore, NEVER identity — the "two Googles" trap the login guards.
const METHODS: Method[] = [
  { name: 'Hive Keychain', hint: 'Browser extension', glyph: 'K', bg: '#c0392b' },
  { name: 'HiveAuth', hint: 'Approve on your phone', glyph: 'H', bg: '#3182ce' },
  { name: 'PeakVault', hint: 'Browser extension', glyph: 'P', bg: '#805ad5' },
  { name: 'MetaMask', hint: 'Sign with your MetaMask-held Hive keys', glyph: 'M', bg: '#e07b3e' },
  { name: 'Google Drive', hint: 'Restore a Hive key you backed up — not a Lumen login', glyph: 'D', bg: '#2f7d4f' },
  { name: 'Private key (WIF)', hint: 'Type your posting key', glyph: 'W', bg: '#4a5568' },
  { name: 'HiveSigner', hint: 'Coming soon', glyph: 'S', bg: '#9ca3af', tag: 'coming' }
];

interface RowProps {
  method: Method;
  keychainDetected: boolean;
}

const MethodRow: FC<RowProps> = ({ method, keychainDetected }) => {
  const tag: MethodTag =
    method.name === 'Hive Keychain' ? (keychainDetected ? 'detected' : 'install') : method.tag ?? 'none';
  const disabled = tag === 'coming';

  const inner = (
    <div
      className={`flex w-full items-center gap-3 rounded-xl border border-[#e4e6e9] bg-white px-4 py-3 text-left ${
        disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer hover:border-[#c0392b] hover:bg-[#fefaf9]'
      }`}
    >
      <span
        className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-[9px] text-[15px] font-extrabold text-white"
        style={{ background: method.bg }}
      >
        {method.glyph}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-[#161511]">{method.name}</span>
        <span className="block text-xs text-[#6b7280]">{method.hint}</span>
      </span>
      {tag === 'detected' ? (
        <span className="flex flex-shrink-0 items-center gap-1.5 rounded-full bg-[#e9f5ee] px-2.5 py-[3px] text-[11px] font-bold text-[#2f7d4f]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#2f7d4f]" />
          {COPY.detected}
        </span>
      ) : tag === 'install' ? (
        <span className="flex-shrink-0 rounded-full bg-[#fdf6ec] px-2.5 py-[3px] text-[11px] font-semibold text-[#b45309]">
          {COPY.install}
        </span>
      ) : tag === 'coming' ? (
        <span className="flex-shrink-0 rounded-full bg-[#f1f3f5] px-2.5 py-[3px] text-[11px] font-bold text-[#9ca3af]">
          {COPY.coming}
        </span>
      ) : null}
    </div>
  );

  if (disabled) return inner;
  // Reuse the app's existing, fully-wired login dialog for the real key auth
  // (Keychain/HiveAuth/WIF/… via smart-signer) rather than duplicating it.
  return <DialogLogin redirectTo="/">{inner}</DialogLogin>;
};

/** Collapsible Tier-2 section: full Hive-account sign-in, secondary to Lite. */
const HiveSigninPanel: FC = () => {
  const [open, setOpen] = useState(false);
  const [keychainDetected, setKeychainDetected] = useState(false);

  useEffect(() => {
    setKeychainDetected(typeof window !== 'undefined' && 'hive_keychain' in window);
  }, []);

  return (
    <div className="rounded-[18px] border border-[#ebebeb] bg-white shadow-[0_1px_2px_rgba(20,18,10,0.03)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-6 py-[18px] text-left"
      >
        <span className="text-[15px] font-semibold text-[#161511]">{COPY.toggle}</span>
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#6b7280"
          strokeWidth="2"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <div className="border-t border-[#f1f3f5] px-6 pb-6 pt-4">
          <p className="mb-4 text-[13px] leading-[1.5] text-[#6b7280]">{COPY.sub}</p>
          <div className="flex flex-col gap-2.5">
            {METHODS.map((m) => (
              <MethodRow key={m.name} method={m} keychainDetected={keychainDetected} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default HiveSigninPanel;
