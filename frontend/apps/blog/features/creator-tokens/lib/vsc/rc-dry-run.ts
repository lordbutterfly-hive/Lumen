/**
 * Size a creator-tokens write's `rc_limit` from a dry run of that exact call,
 * just before it is signed (2026-10-05).
 *
 * A transfer's cost grows with the lots it moves and with the recipient's
 * identity, and mainnet charges 19x for every new byte while the contract sits
 * at its state high-water mark (rc-budget.ts, the 10-05 note). A fixed row
 * therefore failed at gas for a real holder. The node will run the call for us
 * and report what it used, through the same-origin proxy the swap flow already
 * uses (lib/lite/wallet/magi-simulate.ts), so the declared limit is checked
 * against that number. sizeRcLimitFromDryRun (rc-budget.ts) makes the decision.
 *
 * Never blocks a write it cannot measure: if the proxy is down, rate limited or
 * the dry run fails for a reason other than gas, the op goes out exactly as
 * built, and the caller's own execution check reports the outcome as before.
 * The one case it stops is an account that cannot cover the call at all, which
 * would otherwise lose the whole budget to an out-of-gas run.
 */
import { readAccountRcViaProxy, simulateCallViaProxy, type SimulateCall } from '@/blog/lib/lite/wallet/magi-simulate';
import type { CustomJsonOp } from './op-builders';
import { RC_SAFETY_MARGIN, describeRcBudget, sizeRcLimitFromDryRun } from './rc-budget';

/** The proxy's own ceiling for a dry run's rc_limit (app/api/creator-tokens/gql/route.ts MAX_SIMULATE_RC_LIMIT). */
const DRY_RUN_MAX_RC_LIMIT = 100_000;

/** The one refusal this module raises itself; everything else falls back to sending the op as built. */
class RcShortError extends Error {}

function short(action: string, rcLimit: number, addBaseUnits: number): RcShortError {
  return new RcShortError(
    describeRcBudget({ ok: false, rcLimit, blocker: 'not-enough-rc', addBaseUnits }, action) ?? 'Not enough transaction credit for this.'
  );
}

async function availableRcOrNull(caller: string): Promise<number | null> {
  try {
    return Number(await readAccountRcViaProxy(caller));
  } catch {
    return null;
  }
}

/** `caller` is the identity the chain sees: `hive:<name>` or a wallet DID. */
export async function sizeOpByDryRun(op: CustomJsonOp, caller: string): Promise<CustomJsonOp> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(op.json) as Record<string, unknown>;
  } catch {
    return op;
  }
  const declared = Number(body.rc_limit);
  const action = typeof body.action === 'string' ? body.action : '';
  if (!Number.isFinite(declared) || declared <= 0 || typeof body.contract_id !== 'string' || action === '') return op;
  const call: SimulateCall = {
    contract_id: body.contract_id,
    action,
    payload: typeof body.payload === 'string' ? body.payload : JSON.stringify(body.payload ?? {}),
    rc_limit: declared,
    intents: Array.isArray(body.intents) ? (body.intents as SimulateCall['intents']) : []
  };

  let available: number | null = null;
  let rcUsed: number;
  try {
    let sim = await simulateCallViaProxy(caller, call, declared);
    if (!sim.success && sim.err === 'gas_limit_hit') {
      available = await availableRcOrNull(caller);
      const probe = Math.min(available ?? DRY_RUN_MAX_RC_LIMIT, DRY_RUN_MAX_RC_LIMIT);
      if (probe > declared) sim = await simulateCallViaProxy(caller, call, probe);
      if (!sim.success) {
        // Out of gas even with everything the account has: it cannot send this.
        // A failed run's rc_used is a lower bound, so the amount named is too.
        if (sim.err === 'gas_limit_hit' && available !== null && probe >= available) {
          const want = Math.ceil(Math.max(Number(sim.rcUsed), probe) * RC_SAFETY_MARGIN);
          throw short(action, want, want - available);
        }
        return op;
      }
    } else if (!sim.success) {
      return op;
    }
    rcUsed = Number(sim.rcUsed);
  } catch (err) {
    if (err instanceof RcShortError) throw err;
    return op;
  }

  let sizing = sizeRcLimitFromDryRun({ declared, rcUsed, availableRc: available });
  if (sizing.kind === 'raise' && available === null) {
    available = await availableRcOrNull(caller);
    sizing = sizeRcLimitFromDryRun({ declared, rcUsed, availableRc: available });
  }
  if (sizing.kind === 'keep') return op;
  if (sizing.kind === 'short') {
    throw short(action, sizing.rcLimit, sizing.addBaseUnits);
  }
  return { ...op, json: JSON.stringify({ ...body, rc_limit: sizing.rcLimit }) };
}
