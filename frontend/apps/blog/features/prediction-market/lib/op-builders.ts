import { humanToBaseUnits, humanToDecimalString, ASSET_DECIMALS } from './vsc-money';

// Pure builders for the two on-chain actions this frontend can trigger: `bet`
// and `claim`. A VSC contract call is a Hive `custom_json` op with id
// "vsc.call"; the JSON body is the TxVscCallContract shape parsed by
// go-vsc-node (modules/state-processing/transactions.go:42-52):
//   { net_id, contract_id, action, payload, rc_limit, intents }
// The op's required_auths / required_posting_auths carry the Hive account whose
// key signs it — the runtime derives the contract `caller` from
// required_auths[0] (or required_posting_auths[0]); we do NOT set a `caller`
// field in the JSON (transactions.go:105-113).
//
// WIRING-VERIFY (deploy): no existing vsc.call encoder was found in the repo
// (grep of apps/blog + packages), so this envelope is built fresh against the
// go-vsc-node source. Confirm on devnet: (1) the custom_json id string
// "vsc.call"; (2) that a broadcaster wrapping this as
// { custom_json_operation: <CustomJsonOp> } is what @hiveio/wax expects
// (matches packages/transaction/index.ts:799 and signer-wif.ts:167);
// (3) the transfer.allow intent arg names limit/token/decimals
// (execution-context.go:98-124); (4) DEFAULT_RC_LIMIT is large enough for a
// real bet/claim (calibrate against devnet gas_used).

export type ContractAsset = 'hive' | 'hbd';

/** A Hive custom_json operation, ready for a broadcaster to sign+push. */
export interface CustomJsonOp {
  id: string;
  json: string;
  required_auths: string[];
  required_posting_auths: string[];
}

export const VSC_CALL_ID = 'vsc.call';

// WIRING-VERIFY (deploy): placeholder rc_limit; override via
// REACT_APP_VSC_MARKET_RC_LIMIT once a devnet bet/claim reports real gas_used.
//
// ★ WHEN YOU CALIBRATE THIS, READ features/creator-tokens/lib/vsc/rc-budget.ts
// FIRST. Creator-tokens carried this same 30,000 placeholder and it was a real
// defect, for a reason that is not obvious: `rc_limit` is RESERVED AGAINST THE
// CALLER'S HBD, so the ceiling declared here is a minimum balance imposed on
// every user. At 30,000 a bettor had to hold 30 HBD before they could place a
// 1 HBD bet, and the node's refusal reads `insufficient balance`, which points
// at the user's wallet rather than at this line. Measured costs for the
// creator-tokens contract came out between 142 and 3,460 RC, roughly a tenth of
// this.
//
// Do not calibrate by broadcasting and seeing what survives: that only ever
// finds a value that WORKS, never the value that is RIGHT, and it ratchets
// upward because success never argues for a smaller number. The node exposes
// `simulateContractCalls`, which dry-runs the real WASM and returns true
// `rc_used` and `gas_used`. Use it, and record the numbers next to the constant.
export const DEFAULT_RC_LIMIT = 30_000;

export interface BuildBetOpParams {
  contractId: string;
  netId: string;
  username: string; // bare Hive account name (e.g. "alice"), NOT "hive:alice"
  roundId: number;
  asset: ContractAsset;
  outcome: number; // contract bucket index (0-based)
  amount: number; // human units (e.g. 5 = 5.000)
  rcLimit?: number;
}

export interface BuildClaimOpParams {
  contractId: string;
  netId: string;
  username: string;
  roundId: number;
  rcLimit?: number;
}

function assertUint(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`op-builders: ${name} must be a non-negative integer, got ${value}`);
  }
}

function assertUsername(username: string): void {
  if (!username) {
    throw new Error('op-builders: username is required');
  }
}

/**
 * bet — draws `amount` of the round's native asset from the caller (needs the
 * ACTIVE key) via a transfer.allow intent, then stakes it on `outcome`.
 * payload.amount is a base-unit INTEGER string; intent limit is the matching
 * human DECIMAL string (see vsc-money.ts for why they differ).
 */
export function buildBetOp(params: BuildBetOpParams): CustomJsonOp {
  assertUsername(params.username);
  assertUint('roundId', params.roundId);
  assertUint('outcome', params.outcome);
  if (params.asset !== 'hive' && params.asset !== 'hbd') {
    throw new Error(`op-builders: asset must be hive or hbd, got ${params.asset}`);
  }

  const amountBaseUnits = humanToBaseUnits(params.amount);
  const limitDecimal = humanToDecimalString(params.amount);

  const body = {
    net_id: params.netId,
    contract_id: params.contractId,
    action: 'bet',
    payload: {
      roundId: params.roundId,
      asset: params.asset,
      outcome: params.outcome,
      amount: amountBaseUnits
    },
    rc_limit: params.rcLimit ?? DEFAULT_RC_LIMIT,
    intents: [
      {
        type: 'transfer.allow',
        args: {
          limit: limitDecimal,
          token: params.asset,
          decimals: String(ASSET_DECIMALS)
        }
      }
    ]
  };

  return {
    id: VSC_CALL_ID,
    json: JSON.stringify(body),
    required_auths: [params.username], // active auth: the contract does sdk.HiveDraw
    required_posting_auths: []
  };
}

/**
 * claim — resolves a caller's entitlement for a SETTLED/VOID round. No asset
 * draw, so posting authority is sufficient and no intents are attached.
 */
export function buildClaimOp(params: BuildClaimOpParams): CustomJsonOp {
  assertUsername(params.username);
  assertUint('roundId', params.roundId);

  const body = {
    net_id: params.netId,
    contract_id: params.contractId,
    action: 'claim',
    payload: {
      roundId: params.roundId
    },
    rc_limit: params.rcLimit ?? DEFAULT_RC_LIMIT,
    intents: []
  };

  return {
    id: VSC_CALL_ID,
    json: JSON.stringify(body),
    required_auths: [],
    required_posting_auths: [params.username] // posting auth is enough for claim
  };
}

/**
 * reclaim — the FAIL-SAFE. Once a round is past its hard deadline
 * (settleBlock + SettleWindowBlocks + grace) and still OPEN, any staker forces it
 * to VOID and pulls their own full stake back in ONE call. No oracle, no keeper,
 * no owner.
 *
 * Same auth shape as claim: no asset draw, so posting authority is enough and no
 * intents are attached. The contract pays the CALLER their own stake and nobody
 * else's, so there is no payee parameter to get wrong.
 */
export function buildReclaimOp(params: BuildClaimOpParams): CustomJsonOp {
  assertUsername(params.username);
  assertUint('roundId', params.roundId);

  const body = {
    net_id: params.netId,
    contract_id: params.contractId,
    action: 'reclaim',
    payload: {
      roundId: params.roundId
    },
    rc_limit: params.rcLimit ?? DEFAULT_RC_LIMIT,
    intents: []
  };

  return {
    id: VSC_CALL_ID,
    json: JSON.stringify(body),
    required_auths: [],
    required_posting_auths: [params.username]
  };
}
