'use client';

import { useMemo, useState } from 'react';
import { cn } from '@ui/lib/utils';
import { Icons } from '@ui/components/icons';
import { handleError } from '@ui/lib/handle-error';
import { useTranslation } from '@/blog/i18n/client';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useMarket } from './use-market';
import { estimateBetPayout } from './lib/estimate-payout';
import { buildOutcomeColorMap } from './outcome-colors';
import type { RoundState } from './types';

const MIN_BET = 1; // MinBet = 1.000 (contract param)
const AMOUNT_CHIPS = [10, 50, 100, 250];

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// Left "Make your prediction" panel. This is a PARIMUTUEL pool: you pick ONE
// outcome and stake on it — there is no Yes/No fixed-odds contract. The design's
// Yes/No buttons are therefore replaced by a single "backing" strip that shows
// the picked outcome's pool share (¢). The payout is always an ESTIMATE that
// finalizes when betting closes, never a locked fill.
export default function BetForm({ round }: { round: RoundState }) {
  const { t } = useTranslation('common_blog');
  const { placeBet, isPlacingBet, loggedIn } = useMarket();
  const { user } = useUserClient();
  // A lite account has no Hive keys or on-chain funds, so it cannot sign or fund a
  // bet — gate the CTA behind an upgrade instead of letting it error on click.
  const isLite = user.account_tier === 'lite';
  const colors = useMemo(() => buildOutcomeColorMap(round.buckets), [round.buckets]);

  const [selectedId, setSelectedId] = useState<string | null>(round.buckets[0]?.id ?? null);
  const [amount, setAmount] = useState('');
  const [selectorOpen, setSelectorOpen] = useState(false);

  const selected = round.buckets.find((b) => b.id === selectedId) ?? null;
  const numericAmount = Number(amount);
  const hasAmount = Number.isFinite(numericAmount) && numericAmount > 0;
  const isValid = selectedId !== null && Number.isFinite(numericAmount) && numericAmount >= MIN_BET;
  const estimate = selectedId && hasAmount ? estimateBetPayout(round, selectedId, numericAmount) : 0;

  const submit = async () => {
    if (!isValid || !selectedId) return;
    try {
      await placeBet(selectedId, numericAmount);
      setAmount('');
    } catch (error) {
      // A rejected signer prompt, insufficient RC, or network failure must be
      // surfaced — never swallowed as a silent no-op. handleError shows the
      // failure toast (and quietly ignores a user-cancelled signer prompt).
      handleError(error, { method: 'predictionMarketBet', params: { bucketId: selectedId, amount: numericAmount } });
    }
  };

  return (
    <div>
      <h3 className="mb-[18px] font-sans text-[20px] font-semibold text-ink-2">{t('prediction_market.make_prediction')}</h3>

      {/* Outcome selector (dropdown over round.buckets) */}
      <div className="relative mb-4">
        <button
          type="button"
          onClick={() => setSelectorOpen((open) => !open)}
          aria-haspopup="listbox"
          aria-expanded={selectorOpen}
          className="flex w-full items-center justify-between rounded-card border border-line-12 bg-surface-7 px-4 py-3.5 text-left"
        >
          <span className="flex items-center gap-2.5">
            {selected && (
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colors[selected.id] }} aria-hidden="true" />
            )}
            <span className="font-sans text-[15px] leading-[24px] font-semibold text-ink-2">
              {selected ? selected.label : t('prediction_market.pick_outcome')}
            </span>
          </span>
          <Icons.chevronDown className={cn('h-[18px] w-[18px] text-ink-14 transition-transform', selectorOpen && 'rotate-180')} />
        </button>

        {selectorOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setSelectorOpen(false)} aria-hidden="true" />
            <ul
              role="listbox"
              className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-card border border-line-12 bg-surface-1 shadow-[0_6px_20px_rgba(20,18,10,0.10)]"
            >
              {round.buckets.map((bucket) => (
                <li key={bucket.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selectedId === bucket.id}
                    onClick={() => {
                      setSelectedId(bucket.id);
                      setSelectorOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-surface-16',
                      selectedId === bucket.id && 'bg-surface-16'
                    )}
                  >
                    <span className="flex items-center gap-2.5">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colors[bucket.id] }} aria-hidden="true" />
                      <span className="font-sans text-[14px] leading-[22px] text-ink-4">{bucket.label}</span>
                    </span>
                    <span className="font-sans text-caption font-bold tabular-nums text-ink-2">{bucket.oddsPct}¢</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* Backing strip — replaces the fixed-odds Yes/No pair (pool framing) */}
      {selected && (
        <div className="mb-5 flex items-center justify-between rounded-card border border-line-ok-1 bg-surface-13 px-4 py-3">
          <span className="flex items-center gap-2.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colors[selected.id] }} aria-hidden="true" />
            <span className="font-sans text-[14px] leading-[22px] text-ink-7">
              {t('prediction_market.backing')} <span className="font-semibold text-ink-2">{selected.label}</span>
            </span>
          </span>
          <span className="text-right">
            <span className="block font-sans text-[15px] leading-[24px] font-bold tabular-nums text-ink-2">{selected.oddsPct}¢</span>
            <span className="block font-sans text-caption text-ink-14">{t('prediction_market.pool_share')}</span>
          </span>
        </div>
      )}

      {/* Buy in → Est. payout.
          Grid (not flex+justify-between) so the two number columns each own a
          fluid track and the arrow sits in its own auto track: a long amount
          shrinks its own column instead of colliding with the arrow or spilling
          past the card. `items-end` aligns the three cells on the NUMBER line
          (the arrow's mb nudges it onto the digits' optical centre, not the
          block's), and the native number spinners are removed — they overlapped
          the unit suffix on hover. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-3">
        <div className="min-w-0">
          <div className="mb-1 font-sans text-caption font-semibold text-ink-10">{t('prediction_market.buy_in')}</div>
          <div className="flex min-w-0 items-baseline gap-1.5">
            <input
              type="number"
              inputMode="decimal"
              min={MIN_BET}
              step="0.001"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0"
              aria-label={t('prediction_market.buy_in_aria', { asset: round.asset })}
              className="w-full min-w-0 flex-1 appearance-none bg-transparent font-sans text-[30px] leading-[46px] font-bold tracking-[-0.02em] tabular-nums text-ink-2 outline-none placeholder:text-ink-21 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <span className="shrink-0 font-sans text-[14px] font-semibold leading-[22px] text-ink-10">
              {round.asset}
            </span>
          </div>
        </div>

        <Icons.arrowRight className="mb-[7px] h-[22px] w-[22px] shrink-0 text-ink-17" />

        <div className="min-w-0 text-right">
          <div className="mb-1 font-sans text-caption font-semibold text-ink-10">{t('prediction_market.est_payout')}</div>
          <div className="truncate font-sans text-[30px] leading-[46px] font-bold tracking-[-0.02em] tabular-nums text-ink-ok-2">
            {estimate > 0 ? fmt(estimate) : '—'}
          </div>
        </div>
      </div>
      <p className="mt-1.5 text-right font-sans text-caption text-ink-14">{t('prediction_market.est_payout_caption')}</p>

      {/* Amount chips */}
      <div className="mt-4 flex gap-2">
        {AMOUNT_CHIPS.map((chip) => {
          const on = amount !== '' && numericAmount === chip;
          return (
            <button
              key={chip}
              type="button"
              onClick={() => setAmount(String(chip))}
              className={cn(
                'flex-1 rounded-control border py-2.5 font-sans text-[14px] leading-[22px] font-semibold tabular-nums transition-colors',
                on
                  ? 'border-line-27 bg-surface-42 text-ink-27'
                  : 'border-line-12 bg-surface-1 text-ink-7 hover:border-line-28'
              )}
            >
              {chip}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        disabled={!loggedIn || isLite || !isValid || isPlacingBet}
        onClick={submit}
        className="mt-5 w-full rounded-card bg-surface-42 py-[15px] font-sans text-[16px] font-semibold text-ink-27 transition-colors hover:bg-surface-44 disabled:opacity-50"
      >
        {!loggedIn
          ? t('prediction_market.login_to_bet')
          : isLite
            ? t('prediction_market.upgrade_to_bet')
            : isPlacingBet
              ? t('prediction_market.placing')
              : t('prediction_market.place_bet')}
      </button>

      <p className="mt-3 text-center font-sans text-caption text-ink-14">{t('prediction_market.fine_print')}</p>
    </div>
  );
}
