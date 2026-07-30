'use client';

/**
 * The Magi fuel gauge: how much HBD this account has, and whether it can send a
 * transaction at all.
 *
 * ★ WHY IT MEASURES READINESS, NOT UTILISATION.
 *
 * The obvious gauge is available RC over maximum RC. That gauge is useless here: for
 * an account with nothing frozen the two are equal, so it reads 100% permanently,
 * and at a zero balance it is 0/0. Verified against the live testnet —
 * `hive:milo.magi` returns amount 113,297 and max_rcs 113,297, identical.
 *
 * So this measures something that actually moves and actually matters: **available
 * resource credits against what one creator-token call needs.** Full means "you can
 * transact"; short means "you cannot, and here is how much is missing". The
 * threshold is read from the op builder's declared `rc_limit`, so it tracks the real
 * requirement rather than a number copied into a component.
 *
 * Reuses `ManabarRing` — the same ring the header uses for Hive resource credits,
 * which is the right visual language: on Magi, HBD *is* your mana.
 */

import { ManabarRing } from '@/blog/features/layouts/site-header/manabar-ring';
import { MAGI_MIN_RC_FOR_A_CALL, type MagiSpendingPowerState } from './use-magi-spending-power';

/** HBD is a 3-decimal base-unit integer. Formatted here, never floated through maths. */
function hbd(baseUnits: number): string {
  return (baseUnits / 1000).toFixed(3);
}

const READY = '#2f7d4f';
const SHORT = '#b45309';
const UNKNOWN = '#9ca3af';

/**
 * @param state    from useMagiSpendingPower
 * @param costBaseUnits optional cost of the action being contemplated, so the gauge
 *                 can say "this specific purchase is more than you hold" as
 *                 distinct from "you cannot transact at all"
 */
export function MagiFuelGauge({
  state,
  costBaseUnits,
  className = ''
}: {
  state: MagiSpendingPowerState;
  costBaseUnits?: number;
  className?: string;
}) {
  // No endpoint configured: say nothing rather than imply a zero balance. Rendering
  // an empty gauge here would read as "you have no money" when the truth is that we
  // are not connected to a chain at all.
  if (state.unavailable) return null;

  const ring = (percentage: number, color: string) => (
    <ManabarRing percentage={percentage} color={color} size={34} thickness={3} className="flex-shrink-0" />
  );

  if (state.isLoading) {
    return (
      <div className={`flex items-center gap-3 ${className}`} data-testid="magi-fuel-loading">
        {ring(0, UNKNOWN)}
        <span className="text-[12.5px] text-[#6b7280]">Checking your Magi balance…</span>
      </div>
    );
  }

  // A failed read is NOT a zero balance, and this is the one place that distinction
  // could do real harm: a user told they hold nothing might go and deposit again.
  if (state.failed || state.power === null) {
    return (
      <div className={`flex items-center gap-3 ${className}`} data-testid="magi-fuel-failed">
        {ring(0, UNKNOWN)}
        <span className="text-[12.5px] text-[#6b7280]">
          Couldn’t check your Magi balance just now — nothing is wrong with your funds.
        </span>
      </div>
    );
  }

  const { balance, rc } = state.power;
  const readiness = Math.min(100, (rc.amount / MAGI_MIN_RC_FOR_A_CALL) * 100);

  // Cannot send anything. Named separately from "can't afford this" because the fix
  // is different: any amount of HBD unblocks transacting, whereas affording a
  // specific purchase needs a specific amount.
  if (state.cannotTransact) {
    return (
      <div className={`flex items-start gap-3 ${className}`} data-testid="magi-fuel-blocked">
        {ring(readiness, SHORT)}
        <div className="text-[12.5px] leading-[1.5]">
          <div className="font-semibold text-[#b45309]">Not enough on Magi to send a transaction</div>
          <div className="text-[#6b7280]">
            You hold {hbd(balance.hbdBaseUnits)} HBD. On Magi your HBD is also what pays for sending, and
            about {hbd(MAGI_MIN_RC_FOR_A_CALL)} HBD is the minimum for one purchase.
          </div>
        </div>
      </div>
    );
  }

  const short = costBaseUnits !== undefined && costBaseUnits > balance.hbdBaseUnits;

  return (
    <div className={`flex items-start gap-3 ${className}`} data-testid="magi-fuel-ok">
      {ring(readiness, short ? SHORT : READY)}
      <div className="text-[12.5px] leading-[1.5]">
        <div className="font-semibold text-[#161511]">{hbd(balance.hbdBaseUnits)} HBD on Magi</div>
        {short ? (
          <div className="text-[#b45309]">
            This purchase needs {hbd(costBaseUnits)} HBD — {hbd(costBaseUnits - balance.hbdBaseUnits)} more
            than you hold.
          </div>
        ) : (
          <div className="text-[#6b7280]">Available to spend on creator tokens.</div>
        )}
      </div>
    </div>
  );
}

/**
 * How to get HBD onto Magi. Shown when an account cannot transact or cannot afford
 * what it is trying to buy.
 *
 * ★ Neither route needs a Magi signature, which is what makes the zero-balance state
 * escapable rather than a deadlock: a deposit is an ordinary transaction on the
 * chain the user already controls, so they can always fund themselves out of it.
 */
export function MagiFundingHelp({
  kind,
  className = ''
}: {
  kind: 'hive' | 'btc' | 'evm';
  className?: string;
}) {
  return (
    <div
      className={`rounded-[12px] border border-[#f6e2c4] bg-[#fdf6ec] px-4 py-3 text-[12.5px] leading-[1.55] text-[#7c4a08] ${className}`}
      data-testid="magi-funding-help"
    >
      <div className="mb-1 font-semibold">Adding HBD to Magi</div>
      {kind === 'hive' ? (
        <p>
          Send HBD from your Hive wallet to the Magi gateway. It arrives as spendable Magi HBD — an ordinary
          Hive transfer, no extra signing.
        </p>
      ) : (
        <p>
          Deposit from your {kind === 'btc' ? 'Bitcoin' : 'Ethereum'} wallet to the Magi gateway and ask for
          HBD on arrival. You sign it on {kind === 'btc' ? 'Bitcoin' : 'Ethereum'} as normal — it does not
          need a Magi signature, which is why an empty account can always fund itself.
        </p>
      )}
    </div>
  );
}
