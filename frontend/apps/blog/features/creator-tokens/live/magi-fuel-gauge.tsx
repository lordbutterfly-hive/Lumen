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
 * threshold is `MAGI_MIN_RC_FOR_A_CALL` — which, since 2026-08-09, is a MEASURED
 * number and no longer the op builder's declared `rc_limit`. The two were one
 * constant, and raising the declared ceiling to clear a real `gas_limit_hit`
 * silently moved this gauge's "minimum to transact" from 1 HBD to 100.
 *
 * Reuses `ManabarRing` — the same ring the header uses for Hive resource credits,
 * which is the right visual language: on Magi, HBD *is* your mana.
 */

import { useState } from 'react';
import env from '@beam-australia/react-env';
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
  kind,
  className = ''
}: {
  state: MagiSpendingPowerState;
  costBaseUnits?: number;
  /** Identity kind, so the blocked state can tell the truth — a Hive account
   *  starts with a 10,000 RC baseline, a BTC/EVM identity starts with zero. */
  kind?: 'hive' | 'btc' | 'evm';
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
        <span className="text-caption text-ink-10">Checking your Magi balance…</span>
      </div>
    );
  }

  // A failed read is NOT a zero balance, and this is the one place that distinction
  // could do real harm: a user told they hold nothing might go and deposit again.
  if (state.failed || state.power === null) {
    return (
      <div className={`flex items-center gap-3 ${className}`} data-testid="magi-fuel-failed">
        {ring(0, UNKNOWN)}
        <span className="text-caption text-ink-10">
          Couldn’t check your Magi balance just now. Nothing is wrong with your funds.
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
        <div className="text-caption ">
          <div className="font-semibold text-ink-warn-3">Not enough on Magi to send a transaction</div>
          <div className="text-ink-10">
            {/* Two genuinely different situations, measured on chain: a Hive
                account is granted a small RC baseline and merely runs out,
                while a wallet identity is granted none and has never been able
                to send anything. Telling a wallet user they "ran low" would be
                a lie about why they are stuck. */}
            {/* ★ SAY HOW TO FIX IT, AND SAY IT IN THE SAME BREATH (2026-08-21).
                This used to stop at "you cannot send anything", which is a dead
                end: the reader has no way to know that transaction credit on
                Magi is simply their HBD balance, that spending it is normal and
                not a penalty, or that topping up works INSTANTLY rather than
                after a wait. All three facts are needed before the sentence
                becomes an instruction instead of a rejection. The figure is the
                measured cost of a real buy, not a guess — see rc-budget.ts.

                ★ "and no fee" REMOVED 2026-08-28 (false-text audit, sibling of
                F1). The clause was true of SENDING and false of what the reader
                is here to do: this gauge appears when someone cannot afford
                their first PURCHASE, and that purchase pays a 10% trade fee
                (core/params.go TradeFeeBps) plus an early-exit fee if sold
                soon. "No separate gas token" carries the whole point of the
                sentence — HBD is the gas — without the reader concluding the
                trade is free. The fee itself is disclosed where it is charged,
                in ../ui/token-page/disclosure-copy.ts. */}
            {kind === 'btc' || kind === 'evm'
              ? `On Magi, the HBD you hold is also what pays for sending. There is no separate gas token. A wallet account starts with none, so add at least ${hbd(MAGI_MIN_RC_FOR_A_CALL)} HBD to make your first purchase. Every 1 HBD gives you 1,000 credits, and it counts the moment it arrives.`
              : `You hold ${hbd(balance.hbdBaseUnits)} HBD. On Magi that balance is also what pays for sending, and about ${hbd(MAGI_MIN_RC_FOR_A_CALL)} HBD is what one purchase needs. Credit you have already spent comes back on its own over about five days, or you can add HBD to top it up straight away.`}
          </div>
        </div>
      </div>
    );
  }

  const short = costBaseUnits !== undefined && costBaseUnits > balance.hbdBaseUnits;

  return (
    <div className={`flex items-start gap-3 ${className}`} data-testid="magi-fuel-ok">
      {ring(readiness, short ? SHORT : READY)}
      <div className="text-caption ">
        <div className="font-semibold tabular-nums text-ink-2">{hbd(balance.hbdBaseUnits)} HBD on Magi</div>
        {short ? (
          <div className="text-ink-warn-3">
            {/* M-03: state the COST only, not a second shortfall number. The gauge used to
                compute its own `cost - balance`, which omits the transaction-credit reserve,
                so it disagreed with the remedy line below (which includes it). One shortfall
                number, and it is the remedy's RC-inclusive one. */}
            This purchase needs {hbd(costBaseUnits)} HBD, more than you hold.
          </div>
        ) : (
          <div className="text-ink-10">Available to spend on Meritum.</div>
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
 *
 * ★★ MADE ACTIONABLE, 2026-08-09 (owner: "they need to be given a button"). This
 * was two sentences of prose. It named no gateway account, gave no memo, and
 * offered nothing to click — so a reader who could not transact was told a
 * deposit exists and left to find it themselves.
 *
 * That mattered more than it looks, because on Magi HBD *is* the resource
 * credit — and how much you start with depends on WHO you are. Measured live:
 * a `hive:` account gets a flat 10,000 RC baseline on top of its HBD
 * (`max_rcs - hbd == 10_000`, three accounts), but a BTC/EVM identity gets
 * NOTHING (`hbd=0, max_rcs=0` on a real `did:pkh:eip155:` account). So a Hive
 * user with no HBD has about one call in hand, and a wallet user has none at
 * all — for them this panel is the only way into the product.
 *
 * THE DEPOSIT ROUTE IS VERIFIED, not guessed. Reading `vsc.gateway`'s real
 * account history on testnet: an ordinary Hive `transfer` to `vsc.gateway`
 * with an EMPTY memo credits the sender's own Magi account, and a memo of
 * `to=<account-or-0xaddress>` credits someone else. Both shapes observed in
 * live transfers (`milo-hpr` → `to=milo-hpr` and `to=0x0EA4…`).
 *
 * Links are rendered ONLY when they have somewhere real to go — the same rule
 * the Block Explorer and market-stats links now follow, after both shipped as
 * `href="undefined/@user"` and `href="#"`.
 */

/** The Magi gateway account. Verified to exist on both testnet and mainnet. */
const MAGI_GATEWAY = env('MAGI_GATEWAY_ACCOUNT') || 'vsc.gateway';

/**
 * Where a BTC/ETH holder goes to swap into HBD. Altera is the Magi-native
 * market; it is a separate app, so its URL is configuration, and when it is
 * missing we say so plainly rather than render a dead button.
 */
const ALTERA_URL = env('ALTERA_MARKET_URL') || '';

/**
 * The Magi account a deposit credits. Matches Altera's getHiveDepositOp memo,
 * `to=<toDid.split(':').at(-1)>`: the Hive name for a `hive:` account, the wallet
 * address for a `did:pkh:` one. A deposit to the gateway carrying this memo lands
 * in the chosen Magi account and never needs a Magi signature.
 */
function depositMemoTarget(account: string | undefined): string | null {
  if (!account) return null;
  const seg = account.split(':').at(-1);
  return seg && seg.trim() !== '' ? seg : null;
}

/**
 * A labelled, copyable value: the two things a depositor must get exactly right,
 * the gateway account and the memo. Copy is best-effort (clipboard access can be
 * blocked); the value is always on screen to copy by hand.
 */
function CopyRow({ label, value, testId }: { label: string; value: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    try {
      void navigator.clipboard?.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable; the value is visible to copy by hand */
    }
  };
  return (
    <div className="mt-2 flex items-center gap-2" data-testid={testId}>
      <span className="w-[5.5rem] flex-none font-semibold">{label}</span>
      <code className="min-w-0 flex-1 break-all rounded bg-surface-warn-14 px-2 py-1 text-ink-27">{value}</code>
      <button
        type="button"
        onClick={onCopy}
        aria-label={`Copy ${label.toLowerCase()}`}
        className="lm-press flex-none rounded-control px-2.5 py-1 font-semibold text-ink-warn-1 hover:bg-surface-warn-15"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/**
 * How to get HBD onto Magi, the SAME way Altera deposits: send HBD to the VSC
 * gateway account with a `to=<your account>` memo. The gateway is a real Hive
 * account run by consensus, so a deposit is an ordinary Hive transfer from any
 * wallet or exchange and never needs a Magi signature, which is what makes a
 * zero-balance account escapable rather than a deadlock.
 *
 * `account` is the payer's own identifier (`hive:<name>` or `did:pkh:...`); when
 * known we show the exact memo, copyable, so nothing is fat-fingered. A wallet
 * holder with no HBD yet is also pointed at Altera to swap BTC/ETH into HBD.
 */
export function MagiFundingHelp({
  kind,
  account,
  className = ''
}: {
  kind: 'hive' | 'btc' | 'evm';
  /** The payer's Magi account id (`hive:<name>` or `did:pkh:...`), for the deposit memo. */
  account?: string;
  className?: string;
}) {
  const memoTarget = depositMemoTarget(account);

  return (
    <div
      className={`rounded-control border border-line-warn-2 bg-surface-warn-4 px-4 py-3 text-caption text-ink-warn-1 ${className}`}
      data-testid="magi-funding-help"
    >
      <div className="mb-1 font-semibold">Add HBD to Magi</div>
      <p>
        Send HBD to <strong>@{MAGI_GATEWAY}</strong> from any Hive wallet or exchange. That is a dedicated
        account run by the VSC consensus, so your funds stay in your own Magi wallet. Get the memo exactly
        right, or the HBD will not reach your account.
      </p>

      <CopyRow label="Send HBD to" value={MAGI_GATEWAY} testId="magi-deposit-gateway" />
      {memoTarget ? (
        <CopyRow label="Memo" value={`to=${memoTarget}`} testId="magi-deposit-memo" />
      ) : kind === 'hive' ? (
        <p className="mt-2 italic">Leave the memo empty; an empty memo credits your own Magi account.</p>
      ) : (
        <p className="mt-2 italic">Sign in to see the memo that credits your account.</p>
      )}

      {kind !== 'hive' ? (
        <p className="mt-2.5">
          No HBD yet? Trade your {kind === 'btc' ? 'BTC' : 'ETH'} for HBD on Altera, the market on Magi
          itself, and it lands in this same account.
          {ALTERA_URL ? (
            <>
              {' '}
              <a
                href={ALTERA_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold underline hover:text-ink-warn-3"
                data-testid="magi-deposit-altera"
              >
                Open the Altera market
              </a>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
