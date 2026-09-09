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
 * ★ NO SUGGESTIONS ON A SEND FORM (security scrutiny S-2, 2026-09-09). The first
 * cut offered a prefix dropdown like Altera's; the review showed it is the
 * attack, not the mitigation: it filtered the exact typed name OUT, ranked the
 * rest by follower count, and rendered each row's self-chosen profile name and
 * avatar as bold identity, so a look-alike account could be volunteered while
 * the real one was guaranteed absent. On a form that moves money, autocomplete
 * can only move a person away from what they typed. Removed, not tuned.
 *
 * ★ THE @NAME IS THE ONLY AUTHORITATIVE FIELD. The display name and the avatar
 * are whatever the account's owner wrote into its own profile; they are shown,
 * because the owner asked for the picture, but demoted and labelled as the
 * account's own claim, never as the headline. Look-alike names are not guarded
 * (Altera has no guard either); that limitation is stated to the owner, not
 * papered over by a bolder picture.
 *
 * ★ THE LOOKUP IS THROTTLED ON BOTH ENDS (S-3): 500 ms after the last
 * keystroke, only for a syntactically valid Hive name, one in flight at a time
 * (the previous request is aborted), against a route that now rate-limits and
 * length-bounds before it does any work.
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
  | { status: 'ok'; kind: 'evm' | 'btc'; id: string; short: string; checksummed: boolean }
  | { status: 'not_found'; name: string }
  | { status: 'check_failed'; name: string }
  | { status: 'self' }
  | { status: 'invalid'; shape: 'evm' | 'btc' | 'hive' | 'unknown' };

const HIVE_NAME = /^[a-z][a-z0-9.-]{2,15}$/;
const DEBOUNCE_MS = 500;

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
  onResolved?: (resolution: RecipientResolution) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const { t } = useTranslation('common_blog');
  const [resolution, setResolution] = useState<RecipientResolution>({ status: 'idle' });
  const seq = useRef(0);
  const inflight = useRef<AbortController | null>(null);
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
    inflight.current?.abort();
    inflight.current = null;
    if (!raw) {
      report({ status: 'idle' });
      return;
    }
    if (!parsed) {
      report({ status: 'invalid', shape: mode === 'btc' ? 'btc' : recipientShapeHint(raw) });
      return;
    }
    const selfHit =
      self !== undefined &&
      (parsed.kind === 'hive' ? parsed.hiveName === self.toLowerCase().replace(/^hive:/, '') : parsed.id === self);
    if (selfHit) {
      report({ status: 'self' });
      return;
    }
    if (parsed.kind !== 'hive') {
      report({ status: 'ok', kind: parsed.kind, id: parsed.id, short: shortenRecipient(parsed.id), checksummed: parsed.checksummed === true });
      return;
    }
    const name = parsed.hiveName ?? bareHiveName(parsed.id);
    report({ status: 'checking', name });
    const timer = window.setTimeout(async () => {
      const controller = new AbortController();
      inflight.current = controller;
      try {
        const result = await fetchAccountExists(name, { signal: controller.signal, cache: 'no-store' });
        if (result.status === 'exists') {
          report({ status: 'ok', kind: 'hive', id: `hive:${name}`, name, displayName: displayNameOf(result.data as { posting_json_metadata?: string }) });
        } else if (result.status === 'api_error') {
          report({ status: 'check_failed', name });
        } else {
          report({ status: 'not_found', name });
        }
      } catch (error) {
        if ((error as { name?: string })?.name === 'AbortError') return; // superseded by a newer keystroke
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
            `@${r.name}`,
            `${t('wallet.recipient.hive_account')}, ${t('wallet.recipient.exists_on_chain')}${r.displayName ? ` · ${t('wallet.recipient.calls_itself', { name: r.displayName })}` : ''}`,
            stateChip(true, t('wallet.recipient.ready')),
            'ok'
          );
        }
        return row(
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${r.kind === 'evm' ? 'bg-surface-info-9/20 text-ink-info-2' : 'bg-surface-warn-4 text-ink-warn-3'}`}>
            {r.kind === 'evm' ? 'ETH' : 'BTC'}
          </span>,
          <span className="font-mono">{r.short}</span>,
          `${t(r.kind === 'evm' ? 'wallet.recipient.evm_address' : 'wallet.recipient.btc_address')} · ${r.id.split(':').slice(0, 4).join(':')} · ${r.checksummed ? t('wallet.recipient.checksum_valid') : t('wallet.recipient.no_checksum_form')}`,
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
          className={`${INPUT_CLASS} ${showAt ? 'pl-9' : ''} ${looksLikeAddress ? 'font-mono text-[13px]' : ''}`}
          data-testid={testId}
        />
      </div>
      {card}
      {resolution.status === 'idle' && mode !== 'btc' ? <p className="text-caption text-ink-14">{t('wallet.recipient.hint')}</p> : null}
      <FieldError message={error} />
    </div>
  );
}
