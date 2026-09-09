'use client';

/**
 * The recipient field with an ON-CHAIN identity card under it.
 *
 * Owner, 2026-09-09: "we need the selector finding the recepient onchain and
 * showing their profile pic and it needs to be safe... so they cant make a
 * mistake sending. Altera has that exact same thing." Ported from Altera's
 * ContactSearchBox + RecipientCard + validateAddress
 * (altera-app src/lib/sendswap/contacts/contactSearch.ts:34-49,
 * components/RecipientCard.svelte:27-62, utils/sendUtils.ts validateAddress,
 * auth/hive/getProfilePicUrl.ts) with three deliberate differences:
 *
 *  1. ★ FAILS CLOSED. Altera computes `isValid`, shows "Payment to this address
 *     may result in loss of funds" and lets the stage complete anyway
 *     (QuickSendOptions.svelte:50-56 never reads it). Here nothing is sendable
 *     until the recipient resolves, and the two failure kinds stay DISTINCT:
 *     "no account with this name" is a fact about the chain; "couldn't check"
 *     is a fact about the network. Both block; neither is rendered as the other.
 *  2. Ethereum addresses are EIP-55 checksummed, Bitcoin addresses checksummed
 *     and limited to types the node verifies (lib/magi-ops.ts parseMagiRecipient).
 *  3. No external identicon service (Altera: effigy.im). An address has no face;
 *     it gets a chain badge and its own truncated, monospace text. A fake avatar
 *     would be a claim the app cannot back.
 *
 * Suggestions come from the chain by prefix, as Altera's get_account_reputations
 * lookup does, through the app's existing /api/search/people. Look-alike names
 * are not guarded (Altera has no guard either); the resolved card, picture,
 * display name and @name before Send, is the honest mitigation.
 *
 * The form (react-hook-form + zod) still owns validation and the submit gate:
 * the schema refuses both failure kinds (recipient-schema.ts). This component
 * reports its resolution through `onResolved` so a dialog can also disable
 * Submit until the card says "Ready to send".
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { Input } from '@ui/components/input';
import { Icons } from '@ui/components/icons';
import { UserAvatarImg } from '@ui/components/user-avatar-img';
import { useTranslation } from '@/blog/i18n/client';
import { fetchAccountExists } from '@/blog/lib/chain-fetch';
import { bareHiveName, isPayableBtcAddress, parseMagiRecipient, recipientShapeHint, shortenRecipient } from '../../../lib/magi-ops';
import { FieldError } from './field-error';
import { INPUT_CLASS, LABEL_CLASS } from './field-classes';

export type RecipientMode = 'hive' | 'magi' | 'btc';

export type RecipientResolution =
  | { status: 'idle' }
  | { status: 'checking'; name: string }
  | { status: 'ok'; kind: 'hive'; id: string; name: string; displayName: string | null }
  | { status: 'ok'; kind: 'evm' | 'btc'; id: string; short: string }
  | { status: 'not_found'; name: string }
  | { status: 'check_failed'; name: string }
  | { status: 'self' }
  | { status: 'invalid'; shape: 'evm' | 'btc' | 'hive' | 'unknown' };

interface Suggestion {
  name: string;
  displayName: string;
  kind: 'hive' | 'lite';
}

const HIVE_NAME = /^[a-z][a-z0-9.-]{2,15}$/;
const DEBOUNCE_MS = 350;

function displayNameOf(account: { posting_json_metadata?: string } | undefined): string | null {
  try {
    const meta = JSON.parse(account?.posting_json_metadata || '{}') as { profile?: { name?: unknown } };
    const name = meta.profile?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

export default function RecipientPicker({
  label,
  mode,
  register,
  value,
  error,
  self,
  onPick,
  onResolved,
  disabled,
  testId
}: {
  label: string;
  /** hive: Hive names only. magi: names, Ethereum and Bitcoin addresses, qualified ids. btc: a raw Bitcoin address. */
  mode: RecipientMode;
  register: UseFormRegisterReturn;
  /** The watched field value. */
  value: string | undefined;
  error?: string;
  /** The sender: a bare Hive name (hive mode) or a Magi ledger id (magi mode). A match is refused. */
  self?: string;
  /** Called when a suggestion is chosen; the dialog writes it into the form. */
  onPick?: (name: string) => void;
  onResolved?: (resolution: RecipientResolution) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const { t } = useTranslation('common_blog');
  const [resolution, setResolution] = useState<RecipientResolution>({ status: 'idle' });
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);
  const raw = (value ?? '').trim();

  // Which kind of thing was typed, before any network call.
  const parsed = useMemo(() => {
    if (!raw) return null;
    if (mode === 'btc') return isPayableBtcAddress(raw) ? { kind: 'btc' as const, id: raw, hiveName: undefined } : null;
    if (mode === 'hive') {
      const name = raw.replace(/^@/, '').toLowerCase();
      return HIVE_NAME.test(name) ? { kind: 'hive' as const, id: `hive:${name}`, hiveName: name } : null;
    }
    return parseMagiRecipient(raw);
  }, [raw, mode]);

  useEffect(() => {
    const mine = ++seq.current;
    const report = (r: RecipientResolution) => {
      if (seq.current !== mine) return;
      setResolution(r);
      onResolved?.(r);
    };
    if (!raw) {
      report({ status: 'idle' });
      setSuggestions([]);
      return;
    }
    if (!parsed) {
      report({ status: 'invalid', shape: mode === 'btc' ? 'btc' : recipientShapeHint(raw) });
      setSuggestions([]);
      return;
    }
    const selfHit =
      self !== undefined &&
      (parsed.kind === 'hive' ? parsed.hiveName === self.toLowerCase().replace(/^hive:/, '') : parsed.id === self);
    if (selfHit) {
      report({ status: 'self' });
      setSuggestions([]);
      return;
    }
    if (parsed.kind !== 'hive') {
      report({ status: 'ok', kind: parsed.kind, id: parsed.id, short: shortenRecipient(parsed.id) });
      setSuggestions([]);
      return;
    }
    const name = parsed.hiveName ?? bareHiveName(parsed.id);
    report({ status: 'checking', name });
    const timer = window.setTimeout(async () => {
      // Suggestions and the existence check run together; the check is what gates.
      void (async () => {
        try {
          const res = await fetch(`/api/search/people?q=${encodeURIComponent(name)}`, { cache: 'no-store' });
          if (!res.ok) return;
          const people = (await res.json()) as Suggestion[];
          if (seq.current === mine && Array.isArray(people)) {
            setSuggestions(people.filter((p) => p.name !== name).slice(0, 5));
          }
        } catch {
          /* suggestions are a convenience; the existence check below is the gate */
        }
      })();
      try {
        const result = await fetchAccountExists(name);
        if (result.status === 'exists') {
          report({ status: 'ok', kind: 'hive', id: `hive:${name}`, name, displayName: displayNameOf(result.data as { posting_json_metadata?: string }) });
        } else if (result.status === 'api_error') {
          report({ status: 'check_failed', name });
        } else {
          report({ status: 'not_found', name });
        }
      } catch {
        report({ status: 'check_failed', name });
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // onResolved is a stable callback from the dialog; `self` and `mode` change with the dialog, not per keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, mode, self]);

  const looksLikeAddress = mode === 'btc' || (mode === 'magi' && recipientShapeHint(raw) !== 'hive' && raw.length > 16);
  const showAt = mode === 'hive' || (mode === 'magi' && !looksLikeAddress);
  const placeholder = mode === 'hive' ? 'username' : mode === 'btc' ? 'bc1q…' : '@name, 0x… or bc1q…';

  const stateChip = (ok: boolean, text: string) => (
    <span
      className={`shrink-0 rounded-control px-2 py-[2px] text-caption font-medium ${ok ? 'bg-surface-ok-5 text-ink-ok-2' : 'bg-surface-warn-4 text-ink-warn-3'}`}
      data-testid={`${testId ?? 'recipient'}-state`}
    >
      {text}
    </span>
  );

  const card = (() => {
    const r = resolution;
    const row = (media: React.ReactNode, title: React.ReactNode, sub: React.ReactNode, chip: React.ReactNode, status: string) => (
      <div className="flex items-center gap-3 rounded-card border border-line-9 bg-surface-1 px-3 py-2.5" data-testid={`${testId ?? 'recipient'}-card`} data-status={status}>
        {media}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] leading-[20px] font-semibold text-ink-2">{title}</div>
          <div className="text-caption text-ink-10">{sub}</div>
        </div>
        {chip}
      </div>
    );
    const initials = (text: string) => (
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-23 text-caption font-semibold text-ink-8">{text}</span>
    );
    switch (r.status) {
      case 'idle':
        return null;
      case 'checking':
        return row(initials('…'), `@${r.name}`, t('wallet.recipient.checking'), stateChip(false, t('wallet.recipient.checking')), 'checking');
      case 'ok':
        if (r.kind === 'hive') {
          return row(
            <UserAvatarImg username={r.name} pixelSize={36} className="h-9 w-9 shrink-0 rounded-full" alt="" />,
            r.displayName ?? `@${r.name}`,
            `@${r.name} · ${t('wallet.recipient.hive_account')}, ${t('wallet.recipient.exists_on_chain')}`,
            stateChip(true, t('wallet.recipient.ready')),
            'ok'
          );
        }
        return row(
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${r.kind === 'evm' ? 'bg-surface-info-9/20 text-ink-info-2' : 'bg-surface-warn-4 text-ink-warn-3'}`}>
            {r.kind === 'evm' ? 'ETH' : 'BTC'}
          </span>,
          <span className="font-mono">{r.short}</span>,
          `${t(r.kind === 'evm' ? 'wallet.recipient.evm_address' : 'wallet.recipient.btc_address')} · ${t('wallet.recipient.checksum_valid')} · ${r.id.startsWith('did:') ? r.id.split(':').slice(0, 3).join(':') : ''}`.replace(/ · $/, ''),
          stateChip(true, t('wallet.recipient.ready')),
          'ok'
        );
      case 'not_found':
        return row(initials('?'), `@${r.name}`, t('wallet.recipient.not_found'), stateChip(false, t('wallet.recipient.not_sendable')), 'not_found');
      case 'check_failed':
        return row(initials('…'), `@${r.name}`, t('wallet.recipient.check_failed'), stateChip(false, t('wallet.recipient.not_sendable')), 'check_failed');
      case 'self':
        return row(initials('you'), raw, t('wallet.recipient.self'), stateChip(false, t('wallet.recipient.not_sendable')), 'self');
      case 'invalid':
        return row(
          initials('?'),
          raw.length > 28 ? `${raw.slice(0, 14)}…${raw.slice(-8)}` : raw,
          t(
            r.shape === 'evm'
              ? 'wallet.dialogs.common.recipient_invalid_evm'
              : r.shape === 'btc'
                ? 'wallet.dialogs.common.recipient_invalid_btc'
                : mode === 'hive'
                  ? 'wallet.dialogs.common.recipient_length'
                  : 'wallet.dialogs.common.recipient_invalid_any'
          ),
          stateChip(false, t('wallet.recipient.not_sendable')),
          'invalid'
        );
    }
  })();

  return (
    <div className="flex flex-col gap-1.5">
      <label className={LABEL_CLASS}>{label}</label>
      <div className="relative">
        {showAt ? <Icons.atSign className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-14" /> : null}
        <Input
          {...register}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          onFocus={() => setOpen(true)}
          onBlur={(e) => {
            register.onBlur(e);
            window.setTimeout(() => setOpen(false), 150);
          }}
          className={`${INPUT_CLASS} ${showAt ? 'pl-9' : ''} ${looksLikeAddress ? 'font-mono text-[13px]' : ''}`}
          data-testid={testId}
          aria-autocomplete="list"
        />
        {open && suggestions.length > 0 && mode !== 'btc' ? (
          <ul className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-card border border-line-9 bg-surface-1 shadow-lg" role="listbox" data-testid={`${testId ?? 'recipient'}-suggestions`}>
            {suggestions.map((sug) => (
              <li key={sug.name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-16"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onPick?.(sug.name);
                    setOpen(false);
                  }}
                >
                  <UserAvatarImg username={sug.name} pixelSize={32} className="h-8 w-8 shrink-0 rounded-full" alt="" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] leading-[20px] font-semibold text-ink-2">{sug.displayName || `@${sug.name}`}</span>
                    <span className="block text-caption text-ink-10">@{sug.name} · {t('wallet.recipient.hive_account')}</span>
                  </span>
                  <span className="rounded-control bg-surface-23 px-2 py-[2px] text-caption font-medium text-ink-8">{t('wallet.recipient.suggested')}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {card}
      {resolution.status === 'idle' && mode !== 'btc' ? <p className="text-caption text-ink-14">{t('wallet.recipient.hint')}</p> : null}
      <FieldError message={error} />
    </div>
  );
}
