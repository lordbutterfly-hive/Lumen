import type {
  Ask,
  AskInput,
  AnswerInput,
  BuyInput,
  BuyQuote,
  ClaimTradeFeesInput,
  CloseIfDrainedInput,
  CreateOfferingInput,
  DeclineInput,
  DeleteOfferingInput,
  DeliveryRecord,
  CreatorSummary,
  LaunchMarketInput,
  LaunchOfferingResult,
  LaunchResult,
  Offering,
  PricePoint,
  RateInput,
  SetOfferingPriceInput,
  SetOfferingTitleInput,
  HolderPosition,
  Market,
  MyAsksResult,
  Quote,
  ReclaimInput,
  RefundHolderInput,
  RefundInput,
  RegisterMarketInput,
  RenewSubscriptionInput,
  RetireInput,
  SellInput,
  SellQuote,
  SetCapInput,
  SetFaceInput,
  TransferTokensInput,
  WalletPositionsResult,
  WithdrawTreasuryInput,
  MarketPrice,
  IndexerHealth,
} from '../types';
import type { ContractRules, CreatorAsksResult, RenewRefusal } from '../types';
import type { CreatorTokensConfig, CreatorTokensDataSource } from './creator-tokens-data-source';
import {
  MAX_ASK_DEADLINE_BLOCKS,
  MAX_CAP_CREDITS_BASE_UNITS,
  MAX_FACE_BASE_UNITS,
  MAX_PREPAID_PERIODS,
  MIN_ASK_DEADLINE_BLOCKS,
  MIN_CAP_CREDITS_BASE_UNITS,
  MIN_FACE_BASE_UNITS,
  OBS_WINDOW,
  RECLAIM_GRACE_BLOCKS,
  SUBSCRIPTION_FEE_BASE_UNITS,
  SUBSCRIPTION_PERIOD_BLOCKS,
  askRateFromObservations,
  LONG_RING_CFG,
  baseUnitsToHuman,
  blockToEpochMs,
  canInflowOpen,
  commissionOwedForBaseUnits,
  creditsForAskBaseUnits,
  decodeObservationRing,
  deriveFaceBandBaseUnits,
  deriveGraceExpiresAtBlock,
  derivePhase,
  floorPricePerTokenBaseUnits,
  humanToBaseUnits,
  quoteBuyBaseUnits,
  quoteSellBaseUnits,
  refundNetBaseUnits,
  reserveCoverageRatio,
  settlementRateBaseUnits,
  settleSpendStatus,
  BLOCKS_PER_DAY,
  EXIT_TAX_DECAY_BLOCKS,
  displayPricePerTokenBaseUnits,
  splitFaceBaseUnits,
  type AskRateEstimate
} from './contract-math';
import {
  type CustomJsonOp,
  answerPayload,
  askPayload,
  assertValidOfferTitle,
  buildOp,
  buyPayload,
  claimTradeFeesPayload,
  closeIfDrainedPayload,
  createOfferingPayload,
  declinePayload,
  deleteOfferingPayload,
  ratePayload,
  reclaimPayload,
  refundHolderPayload,
  refundPayload,
  registerPayload,
  renewPayload,
  retirePayload,
  sellPayload,
  setCapPayload,
  setFacePayload,
  setOfferingPricePayload,
  setOfferingTitlePayload,
  transferTokensPayload,
  withdrawTreasuryPayload
} from './vsc/op-builders';
// The pure launch op-list builder (register + N offerings, in order). Its
// output is EXACTLY what launchMarket broadcasts; see launch-ops.ts.
import { buildLaunchOps } from './vsc/launch-ops';
// Side-effect-only import: runs the payload-contract self-test in
// development (see that file's own doc for why it lives here rather than in
// op-builders.ts — importing it FROM op-builders.ts would be circular, since
// this file imports the payload builders FROM op-builders.ts).
import './vsc/payload-contract.selftest';
// ★ The ONE hash validator (see answer()): the contract's rules live here, and
// nothing in this file re-implements them.
import { assertHashField } from './vsc/payload-contract';
import './vsc/price-display.selftest';
// Same side-effect wiring, for the same reason: the spender-shape guard and
// its tripwire (audit anomaly A5-07) must run at app startup in development,
// not only when somebody happens to import them.
import './vsc/spender-shape.selftest';
import { MagiIndexerClient } from './vsc/hasura';
import {
  CreatorTokensGqlClient,
  buildAskFromParsed,
  isWellFormedDid,
  kAcqBlock,
  kBal,
  kMatured,
  decodeMaturedLeHex,
  kCap,
  kEscrow,
  kFace,
  kFaceAnchor,
  kFaceAnchorAt,
  kFaceSetAt,
  kFeeBal,
  kObs,
  kObsIdx,
  kObsLong,
  kObsLongIdx,
  kOfferEpoch,
  kOfferIds,
  kOfferPrice,
  kOfferTitle,
  parseOfferIds,
  kDelinquentUntil,
  kPaidUntil,
  kPaused,
  kRegisteredAt,
  kReserve,
  kRetiredAt,
  kSeq,
  kState,
  kSupply,
  decodeRetiredAt,
  parseEscrow,
  type ParsedEscrow,
  toDid,
  toU64,
  unknownMarket,
  STATE_CLOSED, assertTransferDestination } from './vsc/reads';
import { displayPriceUsd } from '../market/curve';
import { marketHealthOf, windingDownOf } from '../market/market-health';
import { RULES_RETRY_MS, RULES_TTL_MS, closesIfDrainedUnder, renewGateUnder, rulesForCode, windingDownUnder } from '../market/contract-rules';
// ★ EXECUTION CONFIRMATION (2026-08-31, seventeen-unconfirmed-writes finding).
// The money-moving writes confirm by polling the tx's own terminal status
// through the SAME findTransaction query the wallet rail already runs
// (operations.ts TX_STATUS_OPERATION) via the SAME same-origin write proxy
// (submit.ts SUBMIT_PROXY_PATH) — so no new node surface, and the query cannot
// drift from the wallet rail's. See awaitExecution() below.
import { SUBMIT_PROXY_PATH } from '@/blog/lib/lite/wallet/vsc-tx/submit';
import { TX_STATUS_OPERATION } from '@/blog/app/api/creator-tokens/submit/operations';

/**
 * ★★★ HOW LONG WE WAIT FOR THE CHAIN TO CONFIRM A REGISTER, AND WHY IT IS
 * EXPORTED (2026-08-31, found by clauderfly-43 reviewing my own change).
 *
 * THE BUG THIS CLOSES. Adding execution confirmation to `registerMarket` made
 * the call take up to its whole timeout AFTER the broadcast. The launch flow's
 * cross-tab guard (`LAUNCH_CLAIM_TTL_MS` in use-meritum-launch.ts) was also
 * 90 s, taken BEFORE the write — so the guard expired at the same instant the
 * operation gave up, and the creator read "it may still land, refresh before
 * launching again" with both tabs unguarded. The register op carries the first
 * buy's HBD on the SAME broadcast (`hbdLegBaseUnits` below), so a second
 * attempt moves real money whatever the contract does with the duplicate.
 *
 * THE ASYMMETRY THAT SETS THE NUMBER. A false UNCONFIRMED costs nothing on
 * answer/decline/reclaim — nothing has moved, the user re-checks. On REGISTER
 * it can cost a second first-buy. The cost of waiting longer is a spinner; the
 * cost of giving up early is a charge. So register waits twice as long as the
 * escrow actions, deliberately.
 *
 * EXPORTED so `LAUNCH_CLAIM_TTL_MS` can be DERIVED from it rather than
 * hand-matched. Two independent 90 000s that must stay ordered is exactly how
 * this drifted in the first place; a claim that outlives its operation is an
 * invariant, not a coincidence.
 */
export const REGISTER_CONFIRM_TIMEOUT_MS = 180_000;

/** The escrow actions' confirmation window. A false UNCONFIRMED here moves no money. */
export const ESCROW_CONFIRM_TIMEOUT_MS = 90_000;

/**
 * Renew's confirmation window (S4). Named rather than inline so all three
 * confirmation polls are visible together — an operation's duration is a
 * contract with whatever guards it, and F1 happened because one of these was a
 * loose literal that nothing pointed at.
 *
 * ★ KNOWN LIMIT, recorded not fixed: the studio's only concurrency guard is an
 * in-memory `inFlight` ref (use-live-studio.ts:451), which is per-TAB. It holds
 * for the whole await, so a same-tab double-click is safe for the full window —
 * but a SECOND TAB is unguarded, and adding this poll widened that window from
 * ~2 s (broadcast-accept) to 90 s. The cost is bounded and is NOT a loss: two
 * renews buy two periods, so the creator gets what they paid for, unlike the
 * launch case where a duplicate register is refused while its first-buy HBD
 * still moves. A cross-tab claim (or a server-side lock) would close it; that is
 * a follow-up, not a silent risk.
 */
export const RENEW_CONFIRM_TIMEOUT_MS = 90_000;

/**
 * The money-moving writes' execution-confirmation window (2026-08-31, the
 * seventeen-unconfirmed-writes finding, clauderfly-57).
 *
 * WHY 180s AND NOT THE ESCROW 90s. Broadcast -> terminal CONFIRMED was MEASURED
 * at ~72s on testnet (57: a real setFace, with the tx reaching CONFIRMED and
 * its state key appearing in the SAME poll sample — n=1, so treat it as "about
 * a minute and a bit, and 90s leaves no margin", not a constant).
 * ★ THE TWO RAILS DIFFER ~3.5x (57, 2026-09-01): hive-rail broadcast->CONFIRMED
 * measured ~20s, wallet-rail ~72s. 180s is generous for hive and correctly
 * sized for wallet; the WALLET rail is the binding constraint, so never
 * re-derive this number from the faster hive rail. Block-time
 * variance on top of ~72s would push a normal success past a 90s window and
 * fire *_UNCONFIRMED on transactions that in fact worked — the exact bad UX
 * this confirmation exists to prevent. So it matches REGISTER_CONFIRM_TIMEOUT_MS
 * for the same asymmetry register faces: a false UNCONFIRMED is cheap (its copy
 * says CHECK, never retry), an early timeout on a real success is not.
 */
export const EXECUTION_CONFIRM_TIMEOUT_MS = 180_000;

// Real, on-chain implementation. Reads live contract state via GraphQL
// getStateByKeys (plumbing + decoding in ./vsc/reads.ts); builds custom_json
// ops for writes (./vsc/op-builders.ts) and signs+broadcasts them through
// whatever `broadcaster` this instance was constructed with. Mirrors
// features/prediction-market/lib/vsc-market-data-source.ts's shape and its
// "no broadcaster wired -> reads work, writes throw" FALLBACK contract
// (assertBroadcaster()/broadcast() below) — but finding C-B fixed the actual
// production wiring: creator-tokens-data-source.ts's
// getCreatorTokensDataSource() now always supplies a real broadcaster
// (./vsc/broadcaster.ts's hiveTransactionBroadcaster) on a provisioned
// build, so this fallback only fires for a caller that constructs
// VscCreatorTokensDataSource directly without one (e.g. a future test).
//
// ★ CURVE-PIVOT REWRITE (2026-07-24): the contract moved from a PAR
// "access credit" model (core/prepay.go — DELETED) to a bonding curve
// (core/curve.go/buy.go/sell.go/refund.go). See types.ts's own file-level
// doc for THE 1000x UNIT TRAP this rewrite is built around: TOKENS (supply,
// cap, balances) are whole INTEGERS now, never run through
// baseUnitsToHuman()/humanToBaseUnits() — only HBD amounts get that
// conversion. Every method below that touches a token quantity is commented
// at the exact point the trap would bite.
//
// No shared vsc-gql.ts/op-builders.ts exists for this feature to import at
// the top level (this task owns only the files listed in the brief) — a
// minimal, self-contained GQL client and op builder live under ./vsc/ rather
// than reaching into prediction-market's own lib, which is a different
// feature's own file.

export type Broadcaster = (op: CustomJsonOp) => Promise<string>;

/**
 * Broadcasts SEVERAL custom_json ops as ONE Hive transaction (one signature),
 * returning that transaction's id. The one-signature Meritum launch (register +
 * N offerings) is its only caller today. Injectable exactly like `broadcaster`:
 * production supplies hiveTransactionBundleBroadcaster (./vsc/broadcaster.ts); a
 * test injects its own. See `launchMarket` for how the returned tx id is
 * confirmed, and broadcaster.ts for why bundling is a pure assembly change that
 * leaves the signer/key path untouched.
 */
export type BundleBroadcaster = (ops: CustomJsonOp[]) => Promise<string>;

/**
 * Reads a transaction's status by id. Injectable (VscCreatorTokensDataSourceDeps)
 * exactly like `broadcaster`: production leaves it unset and awaitExecution uses
 * the browser default below; a Node caller (a selftest) injects one. That is what
 * keeps the real money-math paths (sell/refund exit tax) end-to-end testable
 * without a browser, AND makes the *_REFUSED branch testable at all (43 + 57,
 * 2026-09-01, after the browser-only guard turned a real selftest red). Returns
 * the raw status string (CONFIRMED / FAILED / INCLUDED / PENDING / node
 * UNCONFIRMED) or null.
 */
export type TxStatusReader = (txId: string) => Promise<string | null>;

/**
 * The default (browser) tx-status reader: a same-origin POST to the /submit
 * proxy's findTransaction op — the SAME query the wallet rail runs, so no new
 * node surface and no drift. Returns the status string or null. It is
 * relative-path and browser-only; awaitExecution guards that once, up front, and
 * only for this default (an injected reader is exempt).
 */
async function defaultTxStatusReader(txId: string): Promise<string | null> {
  const res = await fetch(SUBMIT_PROXY_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: TX_STATUS_OPERATION, variables: { id: txId } }),
    cache: 'no-store'
  });
  const parsed = JSON.parse(await res.text()) as {
    data?: { findTransaction?: Array<{ id: string; status: string }> | null } | null;
  };
  return parsed.data?.findTransaction?.[0]?.status ?? null;
}

export interface VscCreatorTokensDataSourceDeps {
  config: CreatorTokensConfig;
  gql?: CreatorTokensGqlClient;
  broadcaster?: Broadcaster;
  /** Broadcasts a multi-op bundle as one Hive transaction (the one-signature launch). See BundleBroadcaster. */
  bundleBroadcaster?: BundleBroadcaster;
  /** Optional tx-status reader; unset in production (uses defaultTxStatusReader). See TxStatusReader. */
  txStatusReader?: TxStatusReader;
}

const NO_BROADCASTER_MSG = 'VscCreatorTokensDataSource: no broadcaster wired — inject the transaction service';
const NO_BUNDLE_BROADCASTER_MSG =
  'VscCreatorTokensDataSource: no bundle broadcaster wired: the one-signature launch needs bundleBroadcaster injected';

/** Shared "n is a positive whole token count" guard — every buy/sell/refund/transfer amount on the curve is an integer (curve.go indexes price by the token ordinal; there is no fractional token). */
function assertPositiveTokenCount(n: number, label: string): void {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`VscCreatorTokensDataSource: ${label} must be a positive whole number (tokens are integers on the curve)`);
  }
}

/**
 * holdclock.go heldBlocksAt, replicated client-side: unset (0) OR >= block both
 * read as 0 held — MAXIMALLY FRESH, i.e. MAXIMUM exit tax, never as ancient. See
 * holdclock.go's own "zero-value convention" doc — getting this backwards would
 * preview a 0% tax on a position the chain taxes at 20%.
 *
 * ★ THE ONE EXCEPTION IS A GRADUATED POSITION (holdclock.go:205-232, dated
 * 2026-07-30, ported here 2026-08-27 with the F1 both-buckets fix). graduate()
 * DELETES kAcqBlock together with kBal (core/matured.go:406-407), so a holder who
 * held for the whole window and then matured has no clock left at all — and the
 * zero-value convention above then reports them at the FULL 20% rate.
 * holdclock.go:208-224 names that inversion and names its victims: "the tax gate,
 * the permissionless-push consent gate, the emitted event, and the quote UI that
 * RULING F makes mandatory before signing". This IS that quote UI.
 *
 * "If nothing is maturing but a matured balance exists, the honest answer is the
 * full window — that is precisely what 'matured' means." Fixed in the one helper
 * rather than at each reader, for holdclock.go's own stated reason: "the
 * alternative is a shortcut at every call site, and the one that gets forgotten
 * reports the maximum tax on a holder who owes nothing."
 *
 * NOT ported: holdclock.go:228-230's cap of a live clock at ExitTaxDecayBlocks.
 * It changes no money here (exitTaxBpsAt already returns 0 at and past the
 * window) and it would change the `heldBlocks` figure types.ts documents as the
 * holding time; left alone deliberately rather than folded into a funds fix.
 */
function heldBlocksFromAcq(acqBlock: number, block: number, maturingTokens: number, maturedTokens: number): number {
  if (acqBlock === 0 || acqBlock >= block) {
    return maturingTokens === 0 && maturedTokens > 0 ? EXIT_TAX_DECAY_BLOCKS : 0;
  }
  return block - acqBlock;
}

interface BuildMarketState {
  faceBaseUnits: number;
  faceSetAtBlock: number;
  faceAnchorBaseUnits: number;
  faceAnchorAtBlock: number;
  capTokens: number;
  supplyTokens: number;
  reserveBaseUnits: number;
  paidUntilBlock: number;
  closedStored: boolean;
  globalInflowPaused: boolean;
  registeredAtBlock: number;
  retiredAtBlock: number | null;
  /** kDelinquentUntil — the delivery gate's inflow-refusal deadline. 0 = clear. */
  delinquentUntilBlock: number;
}

/**
 * The pre-signature refusal for renewSubscription, one sentence per reason
 * (types.ts RenewRefusal), each carrying a stable code the Studio can match
 * on the way CREATOR_TOKENS_RENEW_UNCONFIRMED is matched. The creator-facing
 * wording lives in market/lapse.ts; these are the data source's own errors.
 */
function renewRefusalMessage(reason: RenewRefusal | null): string {
  switch (reason) {
    case 'lapsed-terminal':
      return 'CREATOR_TOKENS_RENEW_REFUSED_LAPSED: this market lapsed past its grace, and the deployed contract does not accept a renewal for it';
    case 'surplus':
      return 'CREATOR_TOKENS_RENEW_REFUSED_SURPLUS: this market cannot be relisted; it carries a surplus from refunds made under the previous rules. Retire it, then register again';
    case 'deficit':
      return 'CREATOR_TOKENS_RENEW_REFUSED_DEFICIT: this market cannot be relisted; its reserve is below the curve';
    case 'retired':
      return 'CREATOR_TOKENS_RENEW_REFUSED_RETIRED: this market is retiring and cannot be renewed';
    case 'paused':
      return 'CREATOR_TOKENS_RENEW_REFUSED_PAUSED: payments into markets are paused right now';
    case 'closed':
    default:
      return 'CREATOR_TOKENS_RENEW_REFUSED_CLOSED: this market is closed; register again instead';
  }
}

export class VscCreatorTokensDataSource implements CreatorTokensDataSource {
  private readonly config: CreatorTokensConfig;
  private readonly gql: CreatorTokensGqlClient;
  private readonly broadcaster?: Broadcaster;
  private readonly bundleBroadcaster?: BundleBroadcaster;
  private readonly txStatusReader: TxStatusReader | null;
  private readonly indexer: MagiIndexerClient | null;

  constructor(deps: VscCreatorTokensDataSourceDeps) {
    this.config = deps.config;
    this.gql = deps.gql ?? new CreatorTokensGqlClient(deps.config.gqlUrl);
    // The Magi indexer (magi-mongo-indexer via Hasura) serves the three reads
    // contract state structurally cannot: holder->creators, asker->asks, and
    // the delivery history. Null when unconfigured — those reads then report
    // `unavailable`, which is honest, rather than empty, which is a lie.
    this.indexer = deps.config.indexerUrl ? new MagiIndexerClient(deps.config.indexerUrl, deps.config.contractId) : null;
    this.broadcaster = deps.broadcaster;
    this.bundleBroadcaster = deps.bundleBroadcaster;
    // Unset in production -> awaitExecution uses defaultTxStatusReader (browser
    // fetch). A Node caller injects one; see TxStatusReader.
    this.txStatusReader = deps.txStatusReader ?? null;
  }

  // ---- reads ----

  /**
   * ★★★ WHICH CONTRACT RULES ARE DEPLOYED, from the chain (A5, 2026-08-31).
   * market/contract-rules.ts has the deploy order and the reason this is a
   * chain read and not a build flag. One `findContract` per RULES_TTL_MS per
   * data source, shared by every market read in flight; a failed read is
   * 'v1' for RULES_RETRY_MS and then asked again. NEVER REJECTS: a market read
   * must not fail because the code read did, and 'v1' is the safe answer.
   * Date.now() here is a cache TTL, not chain timing; no phase or block is
   * ever derived from it.
   */
  private rulesCache: { rules: ContractRules; until: number } | null = null;
  private rulesInFlight: Promise<ContractRules> | null = null;

  async readRules(): Promise<ContractRules> {
    if (this.rulesCache && Date.now() < this.rulesCache.until) return this.rulesCache.rules;
    if (this.rulesInFlight) return this.rulesInFlight;
    this.rulesInFlight = (async (): Promise<ContractRules> => {
      try {
        const code = await this.gql.getContractCode(this.config.contractId);
        const rules = rulesForCode(code);
        this.rulesCache = { rules, until: Date.now() + RULES_TTL_MS };
        return rules;
      } catch {
        this.rulesCache = { rules: 'v1', until: Date.now() + RULES_RETRY_MS };
        return 'v1';
      } finally {
        this.rulesInFlight = null;
      }
    })();
    return this.rulesInFlight;
  }

  /**
   * condenser_api.get_accounts on the configured Hive node. true if the account
   * is registered, false if not, null when it cannot be checked (no hiveApi, or
   * the request failed). Guards the irreversible token transfer against a typo
   * into a well-formed but nonexistent hive account, which the contract would
   * otherwise CREDIT and strand (57 confirmed against core, 2026-09-01).
   */
  async hiveAccountExists(name: string): Promise<boolean | null> {
    const api = this.config.hiveApi;
    const clean = name.replace(/^@/, '').replace(/^hive:/, '').trim().toLowerCase();
    if (!api || clean === '') return null;
    try {
      const res = await fetch(api, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'condenser_api.get_accounts', params: [[clean]], id: 1 })
      });
      if (!res.ok) return null;
      const json: unknown = await res.json();
      const arr = (json as { result?: unknown } | null)?.result;
      if (!Array.isArray(arr)) return null;
      return arr.some((a) => (a as { name?: string } | null)?.name === clean);
    } catch {
      return null;
    }
  }

  /**
   * The spot price for MANY creators in as few requests as possible.
   *
   * ★ WHY THIS EXISTS SEPARATELY FROM `readMarket`. A price chip on every feed
   * card is N creators per page. Calling `readMarket` per creator is the N+1
   * this codebase has already paid for twice, and the existing chip only avoids
   * it by making almost every card ineligible for a read — which stops being
   * true the moment creators actually have markets. This batches instead, so the
   * cost does not grow when the feature succeeds.
   *
   * ★ IT ASKS FOR THREE KEYS, NOT THE FIFTEEN `readMarket` NEEDS. A spot price
   * is a function of SUPPLY alone (`spotPriceUsd`, curve.go SpotRate), so the
   * rest of a Market would be fetched and thrown away. `state` and `registeredAt`
   * come along only to tell "no market" apart from "market with zero supply",
   * which a price of 0 cannot express.
   *
   * ★ CHUNKING LIVES HERE. `MAX_STATE_KEYS` is 100 per request and the caller
   * must not have to know that — a feed page is 20 today but profile and topic
   * feeds paginate. Callers pass whatever they have.
   *
   * The returned map has an entry for EVERY handle asked for, so a caller can
   * always tell "no market" from "not answered yet" without tracking which
   * handles it sent.
   */
  /** Mirrors app/api/creator-tokens/gql/route.ts MAX_STATE_KEYS, and the node's own bound. */
  private static readonly MAX_STATE_KEYS_PER_REQUEST = 100;

  async readMarketPrices(creators: readonly string[]): Promise<Map<string, MarketPrice>> {
    const out = new Map<string, MarketPrice>();
    const unique = [...new Set(creators.map((c) => c.trim()).filter((c) => c.length > 0))];
    if (unique.length === 0) return out;

    // ★★ SIX KEYS, NOT THREE (2026-08-30, B4). This read used to fetch supply,
    // state and registeredAt only, so it could price a market but could not
    // tell whether that market was FROZEN, retired or delinquent, and every
    // feed card drew "$1.41 · Buy" on markets buy.go would refuse. The three
    // extra keys are exactly the inputs readMarket()/buildMarket() below use
    // for `phase` and `canBuy`, plus the one global kPaused key per request,
    // and the head block for the same reason readMarket needs it: phase is
    // paidUntil COMPARED TO NOW, and a head we do not have is a phase we must
    // not guess. 100 keys per call (schema.graphql:813) / 6 = 16 creators per
    // request, and the 1 global key on top keeps it at 97.
    const KEYS_PER_CREATOR = 6;
    const perRequest = Math.floor((VscCreatorTokensDataSource.MAX_STATE_KEYS_PER_REQUEST - 1) / KEYS_PER_CREATOR);

    // ★ BATCHES IN PARALLEL, not one after another. The old loop awaited each
    // batch in turn, which was free while a feed page fit in ONE batch (33
    // creators at 3 keys). At 16 per batch a 30-author feed is two batches,
    // and two sequential round trips against a testnet node measured at
    // 4.2-4.5s each (token-author-chip.tsx's own doc) would have doubled the
    // feed's wait. `Promise.all` keeps the wall clock at one round trip; the
    // node sees the same number of requests either way.
    const batches: string[][] = [];
    for (let i = 0; i < unique.length; i += perRequest) batches.push(unique.slice(i, i + perRequest));
    await Promise.all(batches.map((batch) => this.readMarketPricesBatch(batch, out)));
    return out;
  }

  /** One batch of readMarketPrices: at most `perRequest` creators, one state read + one head read, results written into `out`. */
  private async readMarketPricesBatch(batch: readonly string[], out: Map<string, MarketPrice>): Promise<void> {
    {
      const keys = [
        kPaused(),
        ...batch.flatMap((c) => {
          const did = toDid(c);
          return [kSupply(did), kState(did), kRegisteredAt(did), kPaidUntil(did), kRetiredAt(did), kDelinquentUntil(did)];
        })
      ];
      let state: Record<string, string | null>;
      let head: number | null;
      let rules: ContractRules;
      try {
        [state, head, rules] = await Promise.all([this.gql.getStateByKeys(this.config.contractId, keys), this.gql.getHeadBlock(), this.readRules()]);
      } catch {
        // A failed read is NOT "no market" — saying so would tell a creator with
        // a live market that they have none. Report it as unanswered.
        for (const c of batch) out.set(c, { status: 'unknown', priceUsd: null, health: null });
        return;
      }
      const globalInflowPaused = state[kPaused()] === '1';

      for (const c of batch) {
        const did = toDid(c);
        const registered = state[kRegisteredAt(did)];
        const marketState = state[kState(did)];
        if (!registered && !marketState) {
          out.set(c, { status: 'none', priceUsd: null, health: null });
          continue;
        }
        // ★ F (2026-09-04): the strict toU64 every other reader uses, not a bare
        // Number(... ?? '0'). Both give 0 for a missing key today, but toU64 is
        // the one place the "u64 base-units string -> number" rule lives (it
        // returns 0 for null/blank/malformed rather than NaN), so this stays
        // consistent with buildMarket/readMarketPricesBatch's other reads and
        // cannot drift. The finite/non-negative guard below is now defensive
        // (toU64 already returns a non-negative finite number) but kept.
        const supply = toU64(state[kSupply(did)]);
        if (!Number.isFinite(supply) || supply < 0) {
          out.set(c, { status: 'unknown', priceUsd: null, health: null });
          continue;
        }
        // Same rule as readMarket(): a market whose phase cannot be judged is
        // an unanswered read, not a healthy one. Without this a head-block
        // outage would put the Buy word back on frozen markets, which is the
        // exact fault this read was widened to remove.
        if (head === null) {
          out.set(c, { status: 'unknown', priceUsd: null, health: null });
          continue;
        }
        // The SAME derivation buildMarket() uses, term for term: market.go
        // Phase() via derivePhase (retired folded in), then RequireInflowOpen =
        // canInflowOpen AND not retired AND not delinquent. Do not simplify
        // either AND away; see Market.canBuy's doc in types.ts for which race
        // each one closes.
        const retiredAtBlock = decodeRetiredAt(state[kRetiredAt(did)]);
        const phase = derivePhase(marketState === STATE_CLOSED, toU64(state[kPaidUntil(did)]), head, retiredAtBlock);
        const delinquent = toU64(state[kDelinquentUntil(did)]) > head;
        const canBuy = canInflowOpen(phase, globalInflowPaused) && retiredAtBlock === null && !delinquent;
        const health = marketHealthOf({ phase, canBuy, windingDown: windingDownOf({ phase, retiredAtBlock, rules }) });
        // ★ displayPriceUsd, NOT spotPriceUsd. `spotRateBaseUnits` is the contract's
        // ORACLE rate and is 0 by design at supply 0, so a brand-new market would
        // render "$0.00" — the token advertised as free on the screen that sells it.
        // The display price is Area(S+1) - Area(S): what the next buyer is charged,
        // which is what a price next to a Buy control has to mean.
        out.set(c, { status: 'ready', priceUsd: displayPriceUsd(supply), health });
      }
    }
  }

  async readMarket(creator: string): Promise<Market | null> {
    const keys = [
      kFace(creator),
      kFaceSetAt(creator),
      kFaceAnchor(creator),
      kFaceAnchorAt(creator),
      kCap(creator),
      kSupply(creator),
      kReserve(creator),
      kPaidUntil(creator),
      kState(creator),
      kRegisteredAt(creator),
      kPaused(),
      kRetiredAt(creator),
      kDelinquentUntil(creator)
    ];
    let state: Record<string, string | null>;
    let head: number | null;
    let rules: ContractRules;
    try {
      [state, head, rules] = await Promise.all([this.gql.getStateByKeys(this.config.contractId, keys), this.gql.getHeadBlock(), this.readRules()]);
    } catch (e) {
      // A rate limit is a distinct, honest UI state, not the generic UNKNOWN read
      // failure -- re-throw the coded error so use-live-token-market can surface it.
      if (e instanceof Error && e.message.startsWith('CREATOR_TOKENS_RATE_LIMITED')) throw e;
      return unknownMarket(creator);
    }

    const registeredAtBlock = toU64(state[kRegisteredAt(creator)]);
    if (registeredAtBlock === 0) return null; // never registered — market.go's own kRegisteredAt==0 convention

    // Phase is meaningless without a head block to compare paidUntil against
    // — never guess. The read technically "worked" but is unusable, so this
    // is UNKNOWN too, not a silently-wrong phase.
    if (head === null) return unknownMarket(creator);

    return this.buildMarket(
      creator,
      {
        faceBaseUnits: toU64(state[kFace(creator)]),
        faceSetAtBlock: toU64(state[kFaceSetAt(creator)]),
        faceAnchorBaseUnits: toU64(state[kFaceAnchor(creator)]),
        faceAnchorAtBlock: toU64(state[kFaceAnchorAt(creator)]),
        // ★ 1000x TRAP: capTokens/supplyTokens are raw integer TOKEN counts
        // (core/curve.go — a token is a whole unit). toU64 reads the exact
        // on-chain integer; NEVER wrap these in baseUnitsToHuman().
        capTokens: toU64(state[kCap(creator)]),
        supplyTokens: toU64(state[kSupply(creator)]),
        reserveBaseUnits: toU64(state[kReserve(creator)]),
        paidUntilBlock: toU64(state[kPaidUntil(creator)]),
        closedStored: state[kState(creator)] === STATE_CLOSED,
        globalInflowPaused: state[kPaused()] === '1',
        registeredAtBlock,
        retiredAtBlock: decodeRetiredAt(state[kRetiredAt(creator)]),
        delinquentUntilBlock: toU64(state[kDelinquentUntil(creator)])
      },
      head,
      rules
    );
  }

  // Shared Market construction, used both by readMarket (from live chain
  // state) and by registerMarket's/retire's optimistic PENDING results (from
  // the caller's inputs) so the two can never derive Market fields
  // differently. Pure — no I/O; every argument is already a resolved
  // base-unit/token value + a real head.
  private buildMarket(creator: string, s: BuildMarketState, head: number, rules: ContractRules): Market {
    // market.go Phase(): MAX(naturalPhase, retiredPhase). contract-math.ts's
    // derivePhase takes retiredAtBlock as its 4th arg and reproduces the fold
    // exactly — a retired market can never display as ACTIVE even during its
    // still-technically-OVERDUE 5-day notice window.
    const phase = derivePhase(s.closedStored, s.paidUntilBlock, head, s.retiredAtBlock);
    const graceExpiresAtBlock = deriveGraceExpiresAtBlock(s.paidUntilBlock);
    const faceBandRaw = deriveFaceBandBaseUnits(s.faceBaseUnits, s.faceSetAtBlock, s.faceAnchorBaseUnits, s.faceAnchorAtBlock, head);

    // market.go RequireInflowOpen (the shared gate buy.go's Buy and ask.go's
    // Ask both call): phase in {ACTIVE, OVERDUE} AND !globalInflowPaused AND
    // NOT marketRetired. contract-math.ts's canInflowOpen() only knows
    // {phase, globalInflowPaused} — it predates RULING K3, under which a
    // RETIRED market refuses ALL new inflows for its ENTIRE wind-down,
    // INCLUDING the OVERDUE notice window (where phase alone would still
    // read OVERDUE and canInflowOpen() would say "open"). The
    // `retiredAtBlock === null` AND below restores the full on-chain gate
    // without editing that already-verified building block — see
    // Market.canBuy's own doc in types.ts.
    //
    // ★ THE DELIVERY GATE (2026-07-27), the second condition canInflowOpen()
    // does not know about. RequireInflowOpen also refuses while the creator is
    // DELINQUENT — they ignored too many paying customers — and that refusal
    // is invisible in phase, in the pause flag and in retiredAtBlock. Without
    // this term the UI renders a live Buy button on a market that reverts every
    // single attempt, and the buyer pays RC to find out. INFLOWS ONLY: sell,
    // refund, reclaim and claim all stay open while delinquent, by design.
    const delinquent = s.delinquentUntilBlock > head;
    // ★★★ TWO GATES, NOT ONE (2026-08-30, adversarial review).
    // `acceptsMoney` mirrors core's requireMarketAcceptsMoney (market.go:402-419):
    // paused, retired, phase — and NO delivery term. `canFlow` adds the delivery
    // gate on top, which is core's RequireInflowOpen (market.go:361-379) and is
    // right for PURCHASES only. Renew has a THIRD gate (below); see canRenew's
    // doc in types.ts for the permanent-market-destruction path that gating
    // renew on canBuy re-opened after the contract had already fixed it.
    const acceptsMoney = canInflowOpen(phase, s.globalInflowPaused) && s.retiredAtBlock === null;
    const canFlow = acceptsMoney && !delinquent;
    // ★★★ THE LOCKSTEP (A5, 2026-08-31). Three derivations depend on WHICH
    // contract is deployed, and the PRUNED phase-ladder twin measured all
    // three disagreeing with the v2 contract on a natural FROZEN market:
    // wind-down (the Sell/Redeem rail switch), the renew gate (v2 admits
    // FROZEN behind the reserve check) and, downstream, the health word. All
    // three come from market/contract-rules.ts under `rules`, which readRules
    // took from the chain's own report of the deployed bytecode. Under 'v1'
    // every one of these is byte-for-byte what this function computed before.
    const windingDown = windingDownOf({ phase, retiredAtBlock: s.retiredAtBlock, rules });
    const renewGate = renewGateUnder(rules, {
      phase,
      retiredAtBlock: s.retiredAtBlock,
      globalInflowPaused: s.globalInflowPaused,
      supplyTokens: s.supplyTokens,
      reserveBaseUnits: s.reserveBaseUnits
    });

    return {
      creator,
      faceHbd: baseUnitsToHuman(s.faceBaseUnits),
      faceSetAtBlock: s.faceSetAtBlock,
      faceBand: {
        minHbd: baseUnitsToHuman(faceBandRaw.minHbd),
        maxHbd: baseUnitsToHuman(faceBandRaw.maxHbd),
        bandActive: faceBandRaw.bandActive,
        windowEndsAtBlock: faceBandRaw.windowEndsAtBlock
      },
      // ★ 1000x TRAP: raw integer token counts, NOT baseUnitsToHuman'd.
      capTokens: s.capTokens,
      supplyTokens: s.supplyTokens,
      reserveHbd: baseUnitsToHuman(s.reserveBaseUnits),
      paidUntilBlock: s.paidUntilBlock,
      paidUntilAt: blockToEpochMs(s.paidUntilBlock, head),
      registeredAtBlock: s.registeredAtBlock,
      phase,
      graceExpiresAtBlock,
      graceExpiresAt: blockToEpochMs(graceExpiresAtBlock, head),
      globalInflowPaused: s.globalInflowPaused,
      rules,
      headBlock: head,
      canBuy: canFlow,
      canAsk: canFlow,
      canRenew: renewGate.canRenew,
      renewRefusal: renewGate.renewRefusal,
      delinquentUntilBlock: delinquent ? s.delinquentUntilBlock : null,
      retiredAtBlock: s.retiredAtBlock,
      windingDown,
      floorPriceHbd: baseUnitsToHuman(floorPricePerTokenBaseUnits(s.reserveBaseUnits, s.supplyTokens)),
      spotPriceHbd: baseUnitsToHuman(displayPricePerTokenBaseUnits(s.supplyTokens)),
      reserveCoverage: reserveCoverageRatio(s.reserveBaseUnits, s.supplyTokens)
    };
  }

  async readHolderPosition(creator: string, holder: string): Promise<HolderPosition | null> {
    const keys = [kRegisteredAt(creator), kSupply(creator), kReserve(creator), kBal(creator, holder), kAcqBlock(creator, holder)];
    // rejects on failure — see interface doc. heldBlocks (below) needs a real
    // chain head (the exit tax RATE is time-dependent, holdclock.go), so this
    // read is genuinely incomplete without one — reject rather than guess.
    // F-C5 — the MATURED bucket is a separate key family AND a separate wire
    // encoding, so it needs its own hex-encoded read (see decodeMaturedLeHex).
    // core/matured.go totalBalance: "EVERY guard that used to read kBal alone
    // must read this instead, or a holder is refused access to tokens they
    // demonstrably own." Reading kBal alone here understated a holder's whole
    // position by exactly their matured tokens.
    const [state, maturedState, head] = await Promise.all([
      this.gql.getStateByKeys(this.config.contractId, keys),
      this.gql.getStateByKeysHex(this.config.contractId, [kMatured(creator, holder)]),
      this.gql.getHeadBlock()
    ]);
    if (toU64(state[kRegisteredAt(creator)]) === 0) return null;
    if (head === null) {
      throw new Error('VscCreatorTokensDataSource: cannot compute the exit tax (chain head unavailable)');
    }
    const tokensMatured = decodeMaturedLeHex(maturedState[kMatured(creator, holder)]);
    if (tokensMatured === null) {
      // Undecodable ≠ zero. Reporting 0 here would tell a holder they own
      // nothing in the matured bucket and understate their exit value — the
      // same class of lie F-L19 is about. Refuse the read instead.
      throw new Error('VscCreatorTokensDataSource: matured balance unreadable (unexpected wire encoding)');
    }

    // ★ 1000x TRAP: tokensHeld/supplyTokens are raw integer token counts.
    const tokensMaturing = toU64(state[kBal(creator, holder)]);
    const tokensHeld = tokensMaturing + tokensMatured;
    const supplyTokens = toU64(state[kSupply(creator)]);
    const reserveBaseUnits = toU64(state[kReserve(creator)]);
    const acqBlock = toU64(state[kAcqBlock(creator, holder)]);
    const heldBlocks = heldBlocksFromAcq(acqBlock, head, tokensMaturing, tokensMatured);

    // refund.go refundPayout + the K2 exit tax carve (contract-math.ts
    // refundNetBaseUnits): the TAXED NET, not the untaxed gross — see
    // HolderPosition.floorValueHbd's own doc in types.ts for why showing the
    // gross would overstate a fresh holder's payout by up to 20%.
    const { netBaseUnits, taxBps } = refundNetBaseUnits(
      reserveBaseUnits,
      tokensHeld,
      supplyTokens,
      heldBlocks,
      tokensMaturing
    );
    return {
      creator,
      holder,
      tokensHeld,
      tokensMaturing,
      floorValueHbd: baseUnitsToHuman(netBaseUnits),
      heldBlocks,
      exitTaxBps: taxBps
    };
  }

  async readWallet(holder: string): Promise<WalletPositionsResult> {
    // No reverse "which creators has this holder touched" index exists
    // on-chain — indexer-backed (spec §2.5), never blocks the read path.
    // WIRING-VERIFY (deploy): endpoint shape assumed, no indexer deployed yet.
    //
    // RULE unavailable ≠ empty: a bare [] used to conflate "the indexer read
    // failed / isn't configured" with "this holder genuinely holds nothing" —
    // for a BALANCE view that is a lie. Resolve a discriminated result so the
    // consumer can render "couldn't load your holdings" distinctly from "you
    // hold nothing yet".
    if (!this.indexer) return { positions: [], unavailable: true };
    try {
      // lumen_ct_balances is the reverse index: it replays every token move and
      // reports which markets this account still holds. The per-market POSITION
      // (taxed floor value, hold clock) is then read from CHAIN STATE, not from
      // the indexer — an exit-tax figure has to be current to the block, and a
      // replayed one would be stale the moment anything moved.
      const rows = await this.indexer.balancesOf(toDid(holder));
      const results = await Promise.all(rows.map((r) => this.readHolderPosition(r.creator, holder).catch(() => null)));
      return { positions: results.filter((p): p is HolderPosition => p !== null && p.tokensHeld > 0), unavailable: false };
    } catch {
      return { positions: [], unavailable: true };
    }
  }

  // The inbox is scanned in chunks from the NEWEST seq downward, not as one
  // newest-50 page (H12, 2026-08-31). INBOX_CHUNK is the getStateByKeys bound;
  // MAX_INBOX_SCAN is the pathological-flood backstop.
  private static readonly INBOX_CHUNK = 100;
  private static readonly MAX_INBOX_SCAN = 3000;

  /**
   * Every ask the creator can still act on, across the FULL escrow range —
   * never just the newest page (H12). This is the creator's ONLY defence
   * against a grief-miss: an undeclined ask becomes a miss on its reclaim
   * (core/delivery.go recordMiss), so an ask that never appears here because 50
   * newer asks buried it is a miss the creator could not have prevented.
   *
   * BOUNDED YET COMPLETE. An `awaiting` ask was opened at most
   * MAX_ASK_DEADLINE_BLOCKS (30 days) ago (ask.go MaxAskDeadline), and seqs rise
   * with the open block, and an escrow's deadline is always AFTER its open. So
   * scanning newest->oldest, the first ask whose deadline is older than
   * head - MAX_ASK_DEADLINE_BLOCKS proves every OLDER ask is past its own
   * deadline too and cannot be `awaiting`: we stop there. The MAX_INBOX_SCAN cap
   * is only a backstop for a flood large enough to make even that unbounded
   * (thousands of asks inside 30 days); if it trips, `scannedAll` is false and
   * the UI says so rather than hiding the gap.
   *
   * Resolved asks (answered/reclaimed/declined) are dropped — the inbox shows
   * only `awaiting` and the dead-zone `expired`; the delivery record carries
   * history.
   */
  async readCreatorAsks(creator: string): Promise<CreatorAsksResult> {
    const seqState = await this.gql.getStateByKeys(this.config.contractId, [kSeq(creator)]);
    const seqCount = toU64(seqState[kSeq(creator)]);
    if (seqCount === 0) return { asks: [], scannedAll: true, olderNotScanned: 0 };

    const head = await this.gql.getHeadBlock();
    const CHUNK = VscCreatorTokensDataSource.INBOX_CHUNK;
    const cap = VscCreatorTokensDataSource.MAX_INBOX_SCAN;
    // The stop line: an ask whose deadline is older than this was opened over
    // MaxAskDeadline ago, so it and everything older cannot be awaiting. Null
    // head disables the early stop (status derivation is already degraded), so
    // the cap alone bounds the scan.
    const staleBefore = head === null ? null : head - MAX_ASK_DEADLINE_BLOCKS;

    const asks: Ask[] = [];
    let hi = seqCount; // exclusive: newest ask is seqCount - 1
    let scanned = 0;
    let earlyStopped = false;
    while (hi > 0 && scanned < cap && !earlyStopped) {
      const lo = Math.max(0, hi - CHUNK);
      const seqs: number[] = [];
      for (let sq = lo; sq < hi; sq++) seqs.push(sq);
      const state = await this.gql.getStateByKeys(this.config.contractId, seqs.map((sq) => kEscrow(creator, sq)));
      for (const sq of seqs) {
        const raw = state[kEscrow(creator, sq)];
        if (!raw) continue;
        const parsed = parseEscrow(raw);
        if (!parsed) continue;
        const ask = buildAskFromParsed(creator, sq, parsed, head);
        if (ask.status === 'awaiting' || ask.status === 'expired') asks.push(ask);
        if (staleBefore !== null && ask.deadlineBlock < staleBefore) earlyStopped = true;
      }
      scanned += seqs.length;
      hi = lo;
    }
    // scannedAll is true when we reached seq 0 OR proved no older ask is
    // actionable (earlyStopped). It is false only when the cap cut the scan off
    // first, leaving `hi` older escrows unread.
    const scannedAll = hi === 0 || earlyStopped;
    return {
      asks: asks.sort((a, b) => a.deadlineBlock - b.deadlineBlock),
      scannedAll,
      olderNotScanned: scannedAll ? 0 : hi
    };
  }

  async readMyAsks(asker: string): Promise<MyAsksResult> {
    // Indexer-backed for the same reason readWallet is: no reverse
    // asker->{creator,seq} index exists on-chain. WIRING-VERIFY (deploy).
    // Same unavailable-vs-empty discriminator as readWallet (RULE: unavailable
    // ≠ empty) — a bare [] can't tell "the indexer is down" from "you've asked
    // no one".
    if (!this.indexer) return { asks: [], unavailable: true };
    try {
      // The indexer supplies the (creator, seq) PAIRS — the part no chain key
      // can answer. Each escrow is then read from chain state, so the status and
      // deadline shown are current rather than a replay that may lag a block.
      const rows = await this.indexer.asksOf(toDid(asker));
      const keys = rows.map((r) => kEscrow(r.creator, r.seq));
      const [state, head] = await Promise.all([this.gql.getStateByKeys(this.config.contractId, keys), this.gql.getHeadBlock()]);
      const asks: Ask[] = [];
      for (const r of rows) {
        const raw = state[kEscrow(r.creator, r.seq)];
        const parsed = raw ? parseEscrow(raw) : null;
        if (parsed) asks.push(buildAskFromParsed(r.creator, r.seq, parsed, head));
      }
      return { asks: asks.sort((a, b) => b.deadlineBlock - a.deadlineBlock), unavailable: false };
    } catch {
      return { asks: [], unavailable: true };
    }
  }

  async readDeliveryRecord(creator: string): Promise<DeliveryRecord> {
    // Never contract state (SPEC §1.7.1) — always indexer, always resolves
    // (never rejects), degrading to source:'unavailable'. WIRING-VERIFY (deploy).
    const empty: DeliveryRecord = {
      creator,
      answeredCount: 0,
      missedCount: 0,
      pendingCount: 0,
      responseBlocks: [],
      distinctAskers: 0,
      selfDealtExcluded: 0,
      declinedCount: 0,
      // ★ null, NEVER 0. 0 is a real rating value, so conflating "nobody has
      // rated" with "rated zero" would libel a creator who has simply not been
      // rated yet — the same class as the indexer's completion_pct NULL rule.
      avgRating: null,
      ratingCount: 0,
      source: 'unavailable'
    };
    if (!this.indexer) return empty;
    try {
      const row = await this.indexer.deliveryOf(toDid(creator));
      // No row = this creator has no indexed history. That is genuinely EMPTY,
      // not unavailable: the query succeeded and the answer is "nothing yet".
      if (!row) return { ...empty, source: 'indexer' };
      return {
        creator,
        answeredCount: row.answeredCount,
        missedCount: row.missedCount,
        // Pending asks are live escrows, which the view does not track (it folds
        // resolutions). The creator's own inbox read covers that; leaving it 0
        // here is a known, bounded gap rather than a wrong number.
        pendingCount: 0,
        // The view returns a MEDIAN, already aggregated in SQL. The old REST
        // shape returned every raw block delta; one median in a list keeps the
        // consumer's own median-of-list logic correct on a single element.
        responseBlocks: row.medianResponseBlocks !== null ? [row.medianResponseBlocks] : [],
        // The view does not produce a distinct-asker count — there is no
        // `distinct_askers` column (verified against creator_tokens_views.yaml
        // 2026-08-31). 0 here is HONEST ("we do not know"), not a dropped
        // field, and nothing should render it as a fact.
        distinctAskers: 0,
        selfDealtExcluded: 0,
        // ★ CARRIED THROUGH (2026-08-31). hasura.ts parsed all three and the
        // data source silently dropped them, so declines were invisible and the
        // rating never reached a surface — the view served them the whole time.
        declinedCount: row.declinedCount,
        avgRating: row.avgRating,
        ratingCount: row.ratingCount,
        source: 'indexer'
      };
    } catch {
      return empty;
    }
  }

  /**
   * offeringId (2026-07-28) selects WHICH posted price this quote prices. It
   * must be the same id the ask will carry, because the ask settles at that
   * offering's own banded price and the commission leg is carved out of THAT
   * number — a quote that priced the generic `face` while the ask charged a
   * $200 service would sign a `transfer.allow` for the wrong HBD amount and
   * revert, or preview a cost the buyer never agreed to.
   *
   * Absent/0 = the creator's legacy single face price, exactly as on-chain.
   */
  async readQuote(creator: string, offeringId?: number): Promise<Quote> {
    const obsKeys = Array.from({ length: OBS_WINDOW }, (_, i) => kObs(creator, i));
    const obsLongKeys = Array.from({ length: OBS_WINDOW }, (_, i) => kObsLong(creator, i));
    const [state, head] = await Promise.all([
      this.gql.getStateByKeys(this.config.contractId, [
        kFace(creator),
        kObsIdx(creator),
        kObsLongIdx(creator),
        kRegisteredAt(creator),
        kSupply(creator),
        ...obsKeys,
        ...obsLongKeys
      ]),
      this.gql.getHeadBlock()
    ]);

    // The posted price this ask will actually settle against. For a named
    // offering that is the offering's own price key, never kFace — and a
    // MISSING or deleted offering resolves 0, which flows into the `face <= 0`
    // refusal below exactly as the contract's own "no such offering" does.
    let faceBaseUnits = toU64(state[kFace(creator)]);
    if (offeringId !== undefined && offeringId > 0) {
      faceBaseUnits = await this.readOfferingPriceBaseUnits(creator, offeringId);
    }
    // ask.go splitFace (USER RULING 2026-07-27): the posted face is the
    // buyer's TOTAL — commission is carved OUT of it, never drawn on top.
    // tokenLegBaseUnits (never the raw face) is what creditsForAsk must
    // price; see splitFaceBaseUnits's own doc (contract-math.ts) for the
    // "posted 200 cost 224" autopsy this closes.
    const { tokenLegBaseUnits, commissionBaseUnits } = splitFaceBaseUnits(faceBaseUnits);
    const commissionHbd = baseUnitsToHuman(commissionBaseUnits);
    const base: Omit<Quote, 'rate' | 'creditsRequired' | 'creditsRequiredBaseUnits' | 'oracleStatus' | 'asOfBlock'> = {
      creator,
      faceHbd: baseUnitsToHuman(faceBaseUnits),
      commissionHbd
    };
    const unpriced = (oracleStatus: Quote['oracleStatus'], asOfBlock: number): Quote => ({
      ...base,
      rate: null,
      creditsRequired: null,
      creditsRequiredBaseUnits: null,
      oracleStatus,
      asOfBlock
    });

    if (head === null) return unpriced('unavailable', 0);

    // ask.go: core.Ask (and this preview's real counterpart, core.SettleSpend's
    // wrapper `quote`) both check `face > 0` BEFORE ever computing a
    // settlement rate ("creator has no face price set").
    // H2 (2026-08-31): a creator with no posted price is told exactly that,
    // not "we couldn't check" (which blames our read for their own market fact).
    if (faceBaseUnits <= 0) return unpriced('no_price_set', head);

    const supplyTokens = toU64(state[kSupply(creator)]);
    const obsIdxCount = toU64(state[kObsIdx(creator)]);
    const points = decodeObservationRing(obsKeys.map((k) => state[k]), obsIdxCount);
    const estimate: AskRateEstimate = points === null ? { rateBaseUnits: null, status: 'unavailable' } : askRateFromObservations(points, head);

    // F-C3: the LONG (7-day) arm of settlement's min(short, long, spot). Same packed ring
    // format, decoded identically, but read with the long constants and DROPPED before the
    // market's current registration epoch — the long counter survives re-registration, so
    // without the epoch filter a re-registered market would price off the dead incarnation
    // (core/twap.go askRateLong). Omitting this arm let the preview exceed execution
    // whenever the long window was the binding constraint.
    const longIdxCount = toU64(state[kObsLongIdx(creator)]);
    const registeredAtBlock = toU64(state[kRegisteredAt(creator)]);
    const longPoints = decodeObservationRing(obsLongKeys.map((k) => state[k]), longIdxCount);
    const longEstimate: AskRateEstimate =
      longPoints === null
        ? { rateBaseUnits: null, status: 'unavailable' }
        : askRateFromObservations(longPoints, head, { ...LONG_RING_CFG, sinceBlock: registeredAtBlock });

    // ★ RULING C REWRITE (2026-07-24) — THE PAR FALLBACK IS DELETED.
    // contract-math.ts's settlementRateBaseUnits now REFUSES (rateBaseUnits:
    // null) instead of inventing PAR whenever the TWAP guards don't pass; see
    // its own doc and Quote.rate's doc (types.ts). When it refuses, this
    // preview reports the refusal and creditsForAskBaseUnits is NEVER called
    // with a null rate — the ask action must read as unavailable, exactly
    // mirroring what a real ask() call would do right now (RequireInflowOpen
    // is a separate gate; this is the settlement-refusal gate).
    const settlement = settlementRateBaseUnits(estimate, longEstimate, supplyTokens);
    if (settlement.rateBaseUnits === null) {
      return unpriced(settlement.status, head);
    }
    const creditsRequiredBaseUnits = creditsForAskBaseUnits(tokenLegBaseUnits, settlement.rateBaseUnits);
    // ★ H1 (2026-08-31): the rate passed above; now run settleSpend's OWN guards
    // (min-price, depth ceiling, spend cap, market-too-small). These fire on
    // healthy markets when the posted face is outside the window that moves with
    // supply, and without this a green quote led to a signed ask the chain
    // refused only at settlement. Same order the contract enforces.
    const spend = settleSpendStatus(tokenLegBaseUnits, settlement.rateBaseUnits, supplyTokens, creditsRequiredBaseUnits);
    if (spend !== 'ok') return unpriced(spend, head);
    return {
      ...base,
      rate: baseUnitsToHuman(settlement.rateBaseUnits),
      // ask.go's escrowed "credits" spend the SAME whole-token balance
      // Buy/Sell operate on (kBal) — NOT a 3-decimal PAR quantity any more,
      // so creditsRequired is the same raw integer as creditsRequiredBaseUnits,
      // never baseUnitsToHuman'd (the pre-pivot version of this file divided
      // by 1000 here — see types.ts's Quote.creditsRequired doc).
      creditsRequired: creditsRequiredBaseUnits,
      creditsRequiredBaseUnits,
      oracleStatus: settlement.status,
      asOfBlock: head
    };
  }

  async readFeeBalance(account: string): Promise<number> {
    const state = await this.gql.getStateByKeys(this.config.contractId, [kFeeBal(account)]);
    return baseUnitsToHuman(toU64(state[kFeeBal(account)]));
  }

  async quoteBuy(creator: string, tokens: number): Promise<BuyQuote> {
    assertPositiveTokenCount(tokens, 'tokens');
    const [state, head] = await Promise.all([
      this.gql.getStateByKeys(this.config.contractId, [kRegisteredAt(creator), kSupply(creator), kCap(creator), kPaidUntil(creator), kState(creator), kPaused(), kRetiredAt(creator)]),
      this.gql.getHeadBlock()
    ]);
    if (toU64(state[kRegisteredAt(creator)]) === 0) {
      throw new Error(`VscCreatorTokensDataSource: no such market ${creator}`);
    }
    if (head === null) {
      throw new Error('VscCreatorTokensDataSource: cannot price this buy (chain head unavailable)');
    }
    // buy.go buyCompute: RequireInflowOpen first (market.go — phase +
    // pause + not-retired), THEN the cap check. Mirrored client-side so a
    // doomed call fails fast rather than spending RC on a guaranteed revert.
    const closedStored = state[kState(creator)] === STATE_CLOSED;
    const paidUntilBlock = toU64(state[kPaidUntil(creator)]);
    const retiredAtBlock = decodeRetiredAt(state[kRetiredAt(creator)]);
    const phase = derivePhase(closedStored, paidUntilBlock, head, retiredAtBlock);
    const globalInflowPaused = state[kPaused()] === '1';
    if (!(canInflowOpen(phase, globalInflowPaused) && retiredAtBlock === null)) {
      throw new Error('VscCreatorTokensDataSource: market inflow is not open (frozen, closed, retiring, or globally paused)');
    }
    const supplyTokens = toU64(state[kSupply(creator)]);
    const capTokens = toU64(state[kCap(creator)]);
    if (supplyTokens + tokens > capTokens) {
      throw new Error('VscCreatorTokensDataSource: buy would exceed the market cap');
    }
    const q = quoteBuyBaseUnits(supplyTokens, tokens);
    return {
      tokens: q.tokens,
      costHbd: baseUnitsToHuman(q.costBaseUnits),
      feeHbd: baseUnitsToHuman(q.feeBaseUnits),
      totalDueHbd: baseUnitsToHuman(q.totalDueBaseUnits),
      rateAfterHbd: baseUnitsToHuman(q.rateAfterBaseUnits)
    };
  }

  async quoteSell(creator: string, seller: string, tokens: number): Promise<SellQuote> {
    assertPositiveTokenCount(tokens, 'tokens');
    // F1 — BOTH BUCKETS (2026-08-27). sell.go:189 gates on
    // `totalBalance(s, creator, caller)`, which core/matured.go:145 defines as
    // maturing + matured. This read used to ask for kBal only, and kBal is the
    // MATURING bucket alone: graduate() DELETES it when a position matures
    // (core/matured.go:406), toU64 returns 0 for a missing key, so a
    // fully-graduated holder read back as owning nothing and EVERY sell was
    // refused — including through sell(), which calls this first and lets the
    // throw propagate, so the broadcast never happened. core/matured.go:143 is
    // the rule this restores: "EVERY guard that used to read kBal alone must
    // read this instead, or a holder is refused access to tokens they
    // demonstrably own."
    //
    // The matured half is a separate key family AND a separate wire encoding, so
    // it needs its own hex-encoded read — the identical shape readHolderPosition
    // above already uses (see decodeMaturedLeHex).
    const [state, maturedState, head, rules] = await Promise.all([
      this.gql.getStateByKeys(this.config.contractId, [
        kRegisteredAt(creator),
        kSupply(creator),
        kBal(creator, seller),
        kAcqBlock(creator, seller),
        kPaidUntil(creator),
        kState(creator),
        kRetiredAt(creator)
      ]),
      this.gql.getStateByKeysHex(this.config.contractId, [kMatured(creator, seller)]),
      this.gql.getHeadBlock(),
      this.readRules()
    ]);
    if (toU64(state[kRegisteredAt(creator)]) === 0) {
      throw new Error(`VscCreatorTokensDataSource: no such market ${creator}`);
    }
    if (head === null) {
      throw new Error('VscCreatorTokensDataSource: cannot price this sell (chain head unavailable)');
    }
    const tokensMatured = decodeMaturedLeHex(maturedState[kMatured(creator, seller)]);
    if (tokensMatured === null) {
      // Undecodable ≠ zero — the same choice readHolderPosition makes, for the
      // same reason, and it matters MORE here: defaulting to 0 on this path does
      // not merely understate a displayed value, it re-creates F1 exactly (the
      // gate below would refuse the sell) and would understate the payout of any
      // sell that did get through. Refuse the quote instead.
      throw new Error('VscCreatorTokensDataSource: matured balance unreadable (unexpected wire encoding)');
    }
    // sell.go sellCompute: balance checked first ("clearer error than the
    // rail for the common mistake") — and against the WHOLE position, not the
    // maturing bucket.
    const tokensMaturing = toU64(state[kBal(creator, seller)]);
    const bal = tokensMaturing + tokensMatured;
    if (bal < tokens) {
      throw new Error('VscCreatorTokensDataSource: insufficient tokens');
    }
    // sell.go's rail switch (market.go inWindDown): the curve rail is CLOSED
    // exactly when the market is winding down. Retired closes the rail from
    // the retire block on — INCLUDING the still-OVERDUE notice window (RULING
    // K3) — so this checks retiredAtBlock directly, never only `phase`. Whether
    // a natural FROZEN closes it depends on the deployed contract (v1 yes, v2
    // no: A1 made a lapse an inflow stop), which is why the predicate is the
    // shared rules-aware one and not the inline v1 shape that used to be here.
    const closedStored = state[kState(creator)] === STATE_CLOSED;
    const paidUntilBlock = toU64(state[kPaidUntil(creator)]);
    const retiredAtBlock = decodeRetiredAt(state[kRetiredAt(creator)]);
    const phase = derivePhase(closedStored, paidUntilBlock, head, retiredAtBlock);
    if (windingDownOf({ phase, retiredAtBlock, rules })) {
      throw new Error('VscCreatorTokensDataSource: curve sell is closed while the market winds down; exit via refund() instead');
    }
    const supplyTokens = toU64(state[kSupply(creator)]);
    const acqBlock = toU64(state[kAcqBlock(creator, seller)]);
    const heldBlocks = heldBlocksFromAcq(acqBlock, head, tokensMaturing, tokensMatured);
    // F2 — sell.go:234-236 taxes ONLY the maturing share of the draw
    // (splitDraw MATURING-FIRST, then maturingGrossShare pro rata). The maturing
    // BALANCE is what goes in: quoteSellBaseUnits performs splitDraw itself,
    // the same shape refundNetBaseUnits already takes.
    const q = quoteSellBaseUnits(supplyTokens, tokens, heldBlocks, tokensMaturing);
    if (q === null) {
      // curve.go SellProceeds errors when k > S — unreachable given the
      // balance check above (bal <= supply, I3), kept as the same
      // defense-in-depth the Go source documents for its own identical check.
      throw new Error('VscCreatorTokensDataSource: sell exceeds supply');
    }
    return {
      tokens: q.tokens,
      grossHbd: baseUnitsToHuman(q.grossBaseUnits),
      taxHbd: baseUnitsToHuman(q.taxBaseUnits),
      feeHbd: baseUnitsToHuman(q.feeBaseUnits),
      netHbd: baseUnitsToHuman(q.netBaseUnits),
      taxBps: q.taxBps,
      heldBlocks: q.heldBlocks
    };
  }

  // ---- writes ----

  async registerMarket(input: RegisterMarketInput): Promise<Market> {
    this.assertBroadcaster();
    const faceBaseUnits = humanToBaseUnits(input.faceHbd);
    // market.go registerCheck (core.Register). Zero-extra-read: fixed
    // protocol constants, no chain read needed (this is a brand-new market —
    // no band exists yet, unlike setFace's guard below).
    if (faceBaseUnits < MIN_FACE_BASE_UNITS || faceBaseUnits > MAX_FACE_BASE_UNITS) {
      throw new Error('VscCreatorTokensDataSource: face out of range [MinFace, MaxFace]');
    }
    // ★ 1000x TRAP: capTokens is ALREADY the raw integer token count
    // (RegisterMarketInput.capTokens) — no humanToBaseUnits() here, unlike
    // faceBaseUnits above. MinCap/MaxCap (params.go) bound the raw integer.
    const capTokens = input.capTokens;
    if (!Number.isInteger(capTokens) || capTokens < MIN_CAP_CREDITS_BASE_UNITS || capTokens > MAX_CAP_CREDITS_BASE_UNITS) {
      throw new Error('VscCreatorTokensDataSource: cap out of range [MinCap, MaxCap]');
    }
    const firstBuyTokens = input.firstBuyTokens ?? 0;
    if (!Number.isFinite(firstBuyTokens) || !Number.isInteger(firstBuyTokens) || firstBuyTokens < 0) {
      throw new Error('VscCreatorTokensDataSource: firstBuyTokens must be a non-negative whole number');
    }
    if (firstBuyTokens > capTokens) {
      throw new Error('VscCreatorTokensDataSource: firstBuyTokens would exceed the market cap');
    }
    // launch.go RegisterWithFirstBuy: the optional first buy is an ORDINARY
    // Buy executed atomically with registration, at supply === 0 (a brand-new
    // market) — same curve math as any other Buy (buy.go), just previewed
    // here via quoteBuyBaseUnits(0, firstBuyTokens) since there is no live
    // market yet to call quoteBuy() against.
    const firstBuyQuote = firstBuyTokens > 0 ? quoteBuyBaseUnits(0, firstBuyTokens) : null;
    const totalDueBaseUnits = firstBuyQuote?.totalDueBaseUnits ?? 0;

    // REGISTRATION IS FREE (LOCKED-MECHANISM "Revenue"): no fee is drawn for
    // the registration itself — hbdLegBaseUnits is set ONLY when a first buy
    // is present, and it is exactly that buy's TotalDue (cost+fee), the
    // buyer's own transfer.allow slippage bound (buy.go's own doc).
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'register',
      payload: registerPayload(faceBaseUnits, capTokens, firstBuyTokens),
      hbdLegBaseUnits: totalDueBaseUnits > 0 ? totalDueBaseUnits : undefined,
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    // ★ M-3 (2026-08-31): read the CURRENT kRegisteredAt before broadcasting, so
    // the confirmation below can tell "it landed" from "it was already there".
    // A relaunch of a CLOSED market (registerCheck admits stored state CLOSED)
    // already carries the DEAD incarnation's registeredAt, so "non-zero" is not
    // evidence of anything — only an ADVANCE past the prior value is.
    let registeredBefore: number | null = null;
    try {
      const pre = await this.gql.getStateByKeys(this.config.contractId, [kRegisteredAt(input.creator)]);
      registeredBefore = toU64(pre[kRegisteredAt(input.creator)]);
    } catch {
      registeredBefore = null; // unreadable: fall back to any-change below
    }
    await this.broadcast(op);
    // ★ CONFIRM EXECUTION (M-3). "Your token is live" used to print at
    // L1-accept, before the contract had run — so a registration the chain
    // refused (a duplicate, a paused registry, an unaffordable first buy) was
    // announced as a success and only un-announced on some later refetch. The
    // owner's bar is that minting cannot not-work, and an unconfirmed mint is
    // indistinguishable from a working one to the person who just paid.
    const confirmed = await this.awaitRegisteredAdvance(input.creator, registeredBefore);
    if (!confirmed) {
      throw new Error(
        'CREATOR_TOKENS_REGISTER_UNCONFIRMED: Hive accepted the launch, but Magi has not recorded your market yet. It may still land in a moment. Refresh before launching again. Launching twice is refused on chain and reverts in full, so you will not be charged twice.'
      );
    }
    // A Hive broadcast resolves at L1-accept — BEFORE the L2 contract executes
    // — so an immediate readMarket() returns PRE-execution state, here `null`
    // ("never registered"). It is NOT true that the market "did not appear":
    // it WILL, once L2 runs. Never throw on that racy read and never present
    // it as the outcome. Return the EXPECTED post-state, flagged `pending`, and
    // let useCreatorToken's poll reconcile it against real chain state (mirrors
    // ask()'s `:pending` Ask and prediction-market's optimistic placeBet).
    const [head, rules] = await Promise.all([this.gql.getHeadBlock(), this.readRules()]);
    if (head === null) return { ...unknownMarket(input.creator), pending: true };
    return {
      ...this.buildMarket(
        input.creator,
        {
          faceBaseUnits,
          faceSetAtBlock: head,
          faceAnchorBaseUnits: faceBaseUnits,
          faceAnchorAtBlock: head,
          capTokens,
          // A market a moment old cannot be delinquent — registerApply zeroes
          // all three delivery keys (core/market.go), which is also the premise
          // launch.go's launchBuyCheck relies on to keep the first Buy
          // infallible. Anything but 0 here would be inventing state.
          delinquentUntilBlock: 0,
          // supply/reserve reflect the optional atomic first buy: the curve
          // leg ONLY enters the reserve (buy.go's own "the fee NEVER enters
          // kReserve" rule) — firstBuyQuote.costBaseUnits, never totalDue.
          supplyTokens: firstBuyTokens,
          reserveBaseUnits: firstBuyQuote?.costBaseUnits ?? 0,
          // core.Register grants the first subscription period (mock parity:
          // paidUntil = head + SubscriptionPeriod).
          paidUntilBlock: head + SUBSCRIPTION_PERIOD_BLOCKS,
          closedStored: false,
          globalInflowPaused: false,
          registeredAtBlock: head,
          retiredAtBlock: null
        },
        head,
        rules
      ),
      pending: true
    };
  }

  /**
   * ★★★ THE ONE-SIGNATURE LAUNCH (2026-09-04, Meritum launch rework — item A).
   *
   * Broadcasts `register` (op 0) plus one `createOffering` per configured service
   * (ops 1..N) as a SINGLE Hive transaction — one wallet prompt instead of 1 + N
   * — then confirms the on-chain outcome.
   *
   * ★ ATOMIC, verified against go-vsc-node (read, not assumed):
   *   - ExecuteBatch runs the ops in ORDER on ONE shared ledger/call session
   *     (state_engine.go:2235-2390): op 1 reads the market op 0 created, no
   *     intervening commit.
   *   - Any op failing does `ledgerSession.Revert(); break`, and
   *     `callSession.Commit()` runs only `if ok` — so a rejected offering discards
   *     register (and its first buy) too: NOTHING lands, nothing is charged for a
   *     market. The whole tx gets ONE result: `TxOutput[tx.TxId] = {Ok: ok}`.
   *   - RC is charged CUMULATIVELY on the shared session; an offering that runs
   *     out of RC reverts the whole tx. use-meritum-launch's checkLaunchRcBudget
   *     gates on the full sum so this cannot happen for an in-budget creator.
   *
   * ★ CONFIRMATION — the correction to the build map's literal instruction, made
   * after reading the node (global rule 1: read the code before theorizing).
   * The map said to confirm each offering by a per-op `(txId, opIndex)` L2 id via
   * findTransaction. THAT ID DOES NOT RESOLVE for a `vsc.call` op: go-vsc-node
   * ingests the WHOLE Hive transaction as ONE tx-status record keyed by the Hive
   * tx id (state_engine.go:1764 `Id: self.TxId`) and writes ONE terminal
   * CONFIRMED/FAILED for it (blockProducer.go MakeOplog + transactions.go
   * ExecuteOplog SetOutput, both keyed by the Hive tx id). `MakeTxId(txId, opIdx)`
   * yields `txId` / `txId-1` / … used only for CONTRACT-OUTPUT records, and the
   * DagCbor `ContractId` is only for contract DEPLOYMENT — neither is a
   * findTransaction status. So per-op awaitExecution would time out on EVERY real
   * success and falsely report UNCONFIRMED (a false negative on a money path).
   *
   * Because the bundle is atomic, the correct confirm is the WHOLE-TX terminal
   * status — which is exactly what awaitExecution(hiveTxId) already reads, the
   * same proven mechanism the single-op Hive writes use:
   *   confirmed -> register live AND every offering live (all-or-nothing)
   *   failed    -> reverted atomically: nothing created, nothing charged
   *   timeout   -> unknown; the first-buy HBD rides register, so a blind re-launch
   *                could double-charge it — surface REGISTER_UNCONFIRMED, never
   *                "nothing was charged".
   *
   * ★ ONE confirmation window, NOT two. This uses awaitExecution's
   * EXECUTION_CONFIRM_TIMEOUT_MS (180s) and nothing more, deliberately: the
   * launch flow's cross-tab claim is LAUNCH_CLAIM_TTL_MS = REGISTER_CONFIRM_TIMEOUT_MS
   * + 30s (210s), and F1's invariant is that the claim must OUTLIVE the operation.
   * Chaining a second state poll after a timeout could run to ~360s and expire
   * the claim mid-flight, reopening the double-launch window. awaitExecution alone
   * already yields the confirmed/failed/timeout the UI needs, so there is no
   * second poll.
   *
   * SECURITY: the broadcast op list is EXACTLY buildLaunchOps' output (one
   * register with the disclosed face/cap/first-buy + exactly the configured
   * offerings, in order); the first-buy HBD leg rides ONLY register; each op keeps
   * its own rc_limit; the signer/key path is unchanged (one active-key signature
   * over the whole tx). See launch-ops.ts and broadcaster.ts.
   *
   * Resolves a LaunchResult on success; REJECTS (with a coded message the launch
   * flow already keys on) on a definitive revert or an unconfirmed timeout — the
   * same throw-based contract registerMarket uses, so writeFailureMessage and the
   * cross-tab claim logic work unchanged.
   */
  async launchMarket(input: LaunchMarketInput): Promise<LaunchResult> {
    this.assertBundleBroadcaster();

    // Build the EXACT op list to broadcast. buildLaunchOps validates EVERY op
    // (range checks on register, validOfferTitle + positive price on each
    // offering, one-signer) so a doomed op throws HERE, before anything is signed
    // — never after, where it would revert the whole atomic launch.
    const ops = buildLaunchOps({
      netId: this.config.netId,
      contractId: this.config.contractId,
      rcLimit: this.config.rcLimit,
      register: input.register,
      offerings: input.offerings
    });

    // ONE signature, one broadcast, all ops in order.
    const txId = await this.bundleBroadcast(ops);

    // The signature is done and Hive has accepted the transaction; the UI may now
    // move from "approve in your wallet" to "confirming on-chain".
    input.onBroadcast?.();

    // Confirm the ATOMIC outcome by the whole-tx terminal status (see the doc
    // above for why this is the correct — and the map's per-op id the incorrect —
    // confirmation for a bundled vsc.call), in ONE window.
    const outcome = await this.awaitExecution(txId);

    if (outcome !== 'confirmed') {
      // The launch did not verifiably land. Throw the coded shape the launch flow
      // keys on so the correct copy is chosen (item E):
      //  - FAILED  -> atomic revert, so "nothing was charged" is ACCURATE.
      //  - timeout -> may still have landed; register carries the first-buy HBD,
      //    so a blind re-launch would re-charge it — never say "nothing charged".
      if (outcome === 'failed') {
        throw new Error(
          'CREATOR_TOKENS_LAUNCH_REVERTED: the chain refused this launch, so no market or offering was created and nothing was charged.'
        );
      }
      throw new Error(
        'CREATOR_TOKENS_REGISTER_UNCONFIRMED: Hive accepted the launch, but Magi has not recorded your market yet. It may still land in a moment. Check your token before launching again. Launching twice is refused on chain and reverts in full, so you will not be charged twice.'
      );
    }

    // Confirmed live. Under atomicity every configured offering is live too.
    const offerings: LaunchOfferingResult[] = input.offerings.map((o, i) => ({
      index: i,
      title: o.title,
      ok: true
    }));
    return { txId, registered: true, offerings };
  }

  async renewSubscription(input: RenewSubscriptionInput): Promise<Market> {
    this.assertBroadcaster();
    // market.go Renew: periods bounded before any arithmetic, exactly
    // mirroring core's own ordering (this check runs before core computes
    // newPaidUntil).
    if (input.periods < 1 || input.periods > MAX_PREPAID_PERIODS) {
      throw new Error('VscCreatorTokensDataSource: periods out of range [1, MaxPrepaidPeriods]');
    }
    // market.go Renew -> RequireInflowOpen — the SAME phase+pause+not-retired
    // gate Buy/Ask already read the market for. Renew is permissionless (any
    // fan may pay), but the MARKET must still be able to accept inflows — a
    // lapsed-past-grace, CLOSED, or RETIRING market cannot be "renewed" back
    // to life (market.go Renew's own marketRetired guard; SPEC §1.7.5 routes
    // a genuine lapse through Register instead). Skipped — never blocked —
    // when the market can't be read or was never registered, same "band
    // check only, not an existence check" reasoning as every other guard in
    // this file that reads a fresh Market.
    //
    // ★★★ CORRECTED 2026-08-30 — THIS COMMENT AND THIS GUARD WERE BOTH WRONG.
    // The claim above that "Renew -> RequireInflowOpen" is false. core.Renew
    // calls requireMarketAcceptsMoney (market.go:795-800), and the contract
    // says why in its own words, having found this exact defect on 2026-07-27
    // and called it fatal: the delivery penalty runs 7 days while the grace
    // runs 5, so a penalty near a renewal date outlives the grace, the market
    // hits FROZEN where Renew is illegal forever, and a self-clearing penalty
    // becomes PERMANENT destruction of the market with every holder dumped on
    // the pro-rata rail. "An attacker only had to time three junk asks."
    // The contract fixed it; this client had re-introduced it by gating on
    // canBuy, which carries the delivery term. Blocking a debtor from paying
    // you is not a penalty, it is a trap. Gate on canRenew, never canBuy.
    const [market, head] = await Promise.all([this.readMarket(input.creator), this.gql.getHeadBlock()]);
    if (market && market.phase !== 'UNKNOWN') {
      if (!market.canRenew) {
        throw new Error(renewRefusalMessage(market.renewRefusal));
      }
      if (head !== null) {
        const base = Math.max(market.paidUntilBlock, head);
        const newPaidUntil = base + input.periods * SUBSCRIPTION_PERIOD_BLOCKS;
        const maxAllowed = head + MAX_PREPAID_PERIODS * SUBSCRIPTION_PERIOD_BLOCKS;
        if (newPaidUntil > maxAllowed) {
          throw new Error('VscCreatorTokensDataSource: extension exceeds MaxPrepaidPeriods ahead of now');
        }
      }
    }
    const paidBaseUnits = SUBSCRIPTION_FEE_BASE_UNITS * input.periods;
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'renew',
      payload: renewPayload(toDid(input.creator), input.periods, paidBaseUnits),
      hbdLegBaseUnits: paidBaseUnits,
      activeAuth: input.caller,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    // ★★★ S4 (studio checklist, 2026-08-30): "PAID" MUST MEAN THE CHAIN MOVED.
    // The Hive rail (lib/vsc/broadcaster.ts) resolves the moment Hive accepts
    // the custom_json ENVELOPE, before Magi has executed it, so this used to
    // return "paid" for a payment the contract had not yet seen and might
    // still refuse (paused, retired, a stale nonce) — which is literally the
    // "they pay and get delisted anyway" case. The wallet rail never had the
    // hole: it awaits `waitForInclusion` (lib/lite/wallet/vsc-tx/submit.ts).
    // Both rails now converge on ONE proof that does not need a tx id at all:
    // the state itself. kPaidUntil is the single key Renew writes
    // (market.go:843 setU64(kPaidUntil)), so polling it until it moves past
    // the pre-broadcast value is exactly "Magi executed our renew", on either
    // rail. MEASURED, not assumed (57, 2026-08-30, a real signed setCap on a
    // wallet-DID market through this same proxy): INCLUDED at +0 s, state
    // still the OLD value at +6 s, the new value at +21 s. Inclusion is not
    // execution and execution is not immediately readable, which is why the
    // cadence below is 3 s over 90 s and not one read after the receipt.
    // Bounded (same window the wallet rail uses); on timeout this THROWS
    // rather than returning a pending market, because a "paid" that is not
    // paid is the fault being fixed — the message tells the creator to CHECK,
    // never to pay again (Renew stacks from max(paidUntil, block), so a blind
    // retry buys a second month).
    const before = market && market.phase !== 'UNKNOWN' ? market.paidUntilBlock : null;
    const confirmed = await this.awaitPaidUntilAdvance(input.creator, before);
    if (!confirmed) {
      throw new Error(
        'CREATOR_TOKENS_RENEW_UNCONFIRMED: Hive accepted the payment, but Magi has not recorded it yet. It may still land in a moment. Check again rather than paying again, or you could pay for a second month.'
      );
    }
    // Confirmed on chain: return the REAL post-execution market, not a
    // projection. A failed re-read falls through to the projection below with
    // pending: true, which the UI shows as unconfirmed — never a fabricated value.
    const fresh = await this.readMarket(input.creator);
    if (fresh && fresh.phase !== 'UNKNOWN') return fresh;
    // Optimistic PENDING result (see registerMarket): project the extended
    // paidUntil locally from the pre-broadcast read rather than re-reading
    // PRE-execution state. If the pre-read was unusable (null/UNKNOWN/no head)
    // we cannot project it — surface an UNKNOWN pending market so the UI shows
    // "unconfirmed", never a fabricated value.
    if (!market || market.phase === 'UNKNOWN' || head === null) {
      return { ...(market ?? unknownMarket(input.creator)), pending: true };
    }
    const newPaidUntilBlock = Math.max(market.paidUntilBlock, head) + input.periods * SUBSCRIPTION_PERIOD_BLOCKS;
    const renewedPhase = derivePhase(false, newPaidUntilBlock, head, market.retiredAtBlock);
    const graceExpiresAtBlock = deriveGraceExpiresAtBlock(newPaidUntilBlock);
    // ★ The same two-gate split as buildMarket (2026-08-30). This projection had
    // silently DROPPED the delivery term from canBuy, so an optimistic renew
    // re-opened the Buy button for a delinquent creator until the next refetch.
    // canRenew correctly ignores delivery; canBuy correctly keeps it.
    const acceptsMoney = canInflowOpen(renewedPhase, market.globalInflowPaused) && market.retiredAtBlock === null;
    const canFlow = acceptsMoney && market.delinquentUntilBlock === null;
    // Same lockstep as buildMarket, under the rules this market was read with.
    const renewGate = renewGateUnder(market.rules, {
      phase: renewedPhase,
      retiredAtBlock: market.retiredAtBlock,
      globalInflowPaused: market.globalInflowPaused,
      supplyTokens: market.supplyTokens,
      reserveBaseUnits: humanToBaseUnits(market.reserveHbd)
    });
    return {
      ...market,
      paidUntilBlock: newPaidUntilBlock,
      paidUntilAt: blockToEpochMs(newPaidUntilBlock, head),
      graceExpiresAtBlock,
      graceExpiresAt: blockToEpochMs(graceExpiresAtBlock, head),
      phase: renewedPhase,
      headBlock: head,
      windingDown: windingDownOf({ phase: renewedPhase, retiredAtBlock: market.retiredAtBlock, rules: market.rules }),
      canBuy: canFlow,
      canAsk: canFlow,
      canRenew: renewGate.canRenew,
      renewRefusal: renewGate.renewRefusal,
      pending: true
    };
  }

  async setFace(input: SetFaceInput): Promise<Market> {
    this.assertBroadcaster();
    const newFaceBaseUnits = humanToBaseUnits(input.newFaceHbd);
    // market.go SetFace. Zero-extra-read: fixed protocol range, independent
    // of the anti-rug band below — both are separate, unconditional AND
    // checks on-chain.
    if (newFaceBaseUnits < MIN_FACE_BASE_UNITS || newFaceBaseUnits > MAX_FACE_BASE_UNITS) {
      throw new Error('VscCreatorTokensDataSource: face out of range [MinFace, MaxFace]');
    }
    // market.go SetFace — the 2x/7-day anti-rug band, anchored to a rolling
    // WINDOW (kFaceAnchor/kFaceAnchorAt). Requires a real market read, unlike
    // the bound check above. Compared in HUMAN units directly against
    // Market.faceBand (already human-converted by readMarket) to avoid a
    // needless base<->human round-trip. Skipped — never blocked — when the
    // market can't be read or was never registered: this is a band check
    // only, never the excluded market-existence guard.
    const market = await this.readMarket(input.creator);
    if (market && market.phase !== 'UNKNOWN') {
      if (input.newFaceHbd < market.faceBand.minHbd || input.newFaceHbd > market.faceBand.maxHbd) {
        throw new Error('VscCreatorTokensDataSource: face change exceeds the 2x/7-day band (measured against the window anchor, not the last change)');
      }
    }
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'setFace',
      payload: setFacePayload(newFaceBaseUnits),
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    const txId = await this.broadcast(op);
    // ★ CONFIRM EXECUTION (2026-08-31). This used to return an optimistic face
    // overlay (pending) even if the chain refused the change (outside the
    // 2x/7-day band, market frozen). Confirm to a terminal status first.
    const outcome = await this.awaitExecution(txId);
    if (outcome === 'failed') {
      throw new Error('CREATOR_TOKENS_SETFACE_REFUSED: the chain refused this price change, so the posted price is unchanged.');
    }
    if (outcome === 'timeout') {
      throw new Error(
        'CREATOR_TOKENS_SETFACE_UNCONFIRMED: Hive accepted the price change, but Magi has not confirmed it yet. Check the market before changing it again.'
      );
    }
    // Confirmed. Return the PROJECTION, not a re-read (UI invalidates + refetches
    // exact state; 43/57, 2026-09-01). Overlay the new face on
    // the pre-broadcast read (every OTHER field is unchanged by setFace). The
    // derived faceBand shifts with the new face, but a slightly-stale band on a
    // clearly-pending result is reconciled by the next poll.
    if (!market || market.phase === 'UNKNOWN') {
      return { ...(market ?? unknownMarket(input.creator)), pending: true };
    }
    return { ...market, faceHbd: input.newFaceHbd, pending: true };
  }

  async setCap(input: SetCapInput): Promise<Market> {
    this.assertBroadcaster();
    // ★ 1000x TRAP: newCapTokens is ALREADY the raw integer token count — no
    // humanToBaseUnits() (see registerMarket's identical note).
    const newCapTokens = input.newCapTokens;
    // market.go SetCap. Zero-extra-read: fixed protocol range only — the
    // separate cap-vs-current-supply guard (market.go SetCap) needs an extra
    // read (kSupply) and is explicitly out of scope for this pass (mirrors
    // the pre-pivot version of this method).
    if (!Number.isInteger(newCapTokens) || newCapTokens < MIN_CAP_CREDITS_BASE_UNITS || newCapTokens > MAX_CAP_CREDITS_BASE_UNITS) {
      throw new Error('VscCreatorTokensDataSource: cap out of range [MinCap, MaxCap]');
    }
    // Read the CURRENT market BEFORE broadcasting so the optimistic PENDING
    // result below overlays the new cap on real prior state — not a racy
    // post-write read (which returns PRE-execution state, see registerMarket).
    const market = await this.readMarket(input.creator);
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'setCap',
      payload: setCapPayload(newCapTokens),
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    const txId = await this.broadcast(op);
    // ★ CONFIRM EXECUTION (2026-08-31). Confirm the cap change landed before
    // returning it as done.
    const outcome = await this.awaitExecution(txId);
    if (outcome === 'failed') {
      throw new Error('CREATOR_TOKENS_SETCAP_REFUSED: the chain refused this cap change, so the cap is unchanged.');
    }
    if (outcome === 'timeout') {
      throw new Error(
        'CREATOR_TOKENS_SETCAP_UNCONFIRMED: Hive accepted the cap change, but Magi has not confirmed it yet. Check the market before changing it again.'
      );
    }
    // Confirmed. Return the PROJECTION, not a re-read (UI invalidates + refetches
    // exact state; 43/57, 2026-09-01).
    if (!market || market.phase === 'UNKNOWN') {
      return { ...(market ?? unknownMarket(input.creator)), pending: true };
    }
    return { ...market, capTokens: newCapTokens, pending: true };
  }

  async buy(input: BuyInput): Promise<HolderPosition> {
    this.assertBroadcaster();
    assertPositiveTokenCount(input.tokens, 'tokens');
    // buy.go buyCompute — the exact area-step cost, fee and TotalDue.
    // quoteBuy() already runs every guard Buy itself would run (existence,
    // RequireInflowOpen incl. the RULING K3 retired check, and the cap
    // check), so a rejection here means a real Buy would ALSO reject.
    const quote = await this.quoteBuy(input.creator, input.tokens);
    if (input.maxTotalHbd !== undefined && quote.totalDueHbd > input.maxTotalHbd) {
      throw new Error('VscCreatorTokensDataSource: quoted total due exceeds maxTotalHbd');
    }
    // Read the CURRENT position BEFORE broadcasting (see registerMarket's own
    // doc: a post-broadcast read returns PRE-L2-execution state).
    const priorPosition = await this.readHolderPosition(input.creator, input.buyer).catch(() => null);
    const totalDueBaseUnits = humanToBaseUnits(quote.totalDueHbd);
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'buy',
      // ★ 1000x TRAP: input.tokens is the raw integer token count — op-builders'
      // buyPayload() sends it as an intStr, never through humanToBaseUnits().
      payload: buyPayload(toDid(input.creator), input.tokens),
      // buy.go's own doc: "the buyer's own signed transfer.allow on that draw"
      // IS the slippage protection — this IS that draw, computed from the
      // SAME quote the caller's optional maxTotalHbd was just checked against.
      hbdLegBaseUnits: totalDueBaseUnits,
      activeAuth: input.buyer,
      rcLimit: this.config.rcLimit
    });
    const txId = await this.broadcast(op);
    // ★ CONFIRM EXECUTION (2026-08-31, seventeen-unconfirmed-writes finding).
    // This used to return a PROJECTED balance (pending) the instant Hive
    // accepted the op, indistinguishable from a buy the chain refused (cap,
    // price moved, market retired). Confirm to a terminal status first.
    const outcome = await this.awaitExecution(txId);
    if (outcome === 'failed') {
      throw new Error('CREATOR_TOKENS_BUY_REFUSED: the chain refused this purchase, so no tokens were bought and nothing was charged.');
    }
    if (outcome === 'timeout') {
      throw new Error(
        'CREATOR_TOKENS_BUY_UNCONFIRMED: Hive accepted your purchase, but Magi has not confirmed it yet. Check your balance before buying again.'
      );
    }
    // Confirmed. Return the PROJECTION, not a re-read: the UI invalidates on
    // success and refetches exact state, so a re-read here is redundant (43/57,
    // 2026-09-01). Project the minted tokens onto the prior
    // balance. heldBlocks is projected as 0 (maximally fresh) rather than
    // carried over from priorPosition — holdclock.go's creditInflow always
    // re-averages the clock TOWARD `now` on a Buy (never away from it), so
    // keeping the OLD heldBlocks would understate the tax the position now
    // actually carries; 0 is the conservative (treasury-favouring) direction
    // used everywhere else unset/uncertain hold-time is displayed.
    // floorValueHbd is best-effort (kept at the pre-buy figure): an exact
    // post-buy value needs a fresh (reserve, supply) read, since the curve's
    // floor is not a simple linear function of tokens added.
    const priorTokens = priorPosition?.tokensHeld ?? 0;
    return {
      creator: input.creator,
      holder: input.buyer,
      tokensHeld: priorTokens + input.tokens,
      floorValueHbd: priorPosition?.floorValueHbd ?? 0,
      heldBlocks: 0,
      exitTaxBps: priorPosition?.exitTaxBps ?? 0,
      pending: true
    };
  }

  async sell(input: SellInput): Promise<HolderPosition> {
    this.assertBroadcaster();
    assertPositiveTokenCount(input.tokens, 'tokens');
    // sell.go sellCompute — the exact area-step gross, K2 tax, fee and net.
    // quoteSell() already runs every guard Sell itself would run (balance,
    // the rail switch).
    const quote = await this.quoteSell(input.creator, input.seller, input.tokens);
    if (input.minNetHbd !== undefined && quote.netHbd < input.minNetHbd) {
      throw new Error('VscCreatorTokensDataSource: quoted net proceeds below minNetHbd');
    }
    // Read the CURRENT position BEFORE broadcasting (see registerMarket's own
    // doc).
    const priorPosition = await this.readHolderPosition(input.creator, input.seller);
    if (!priorPosition) throw new Error(`VscCreatorTokensDataSource: no such market ${input.creator}`);
    const minNetBaseUnits = input.minNetHbd !== undefined ? humanToBaseUnits(input.minNetHbd) : undefined;
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'sell',
      // ★ 1000x TRAP: input.tokens is the raw integer token count —
      // op-builders' sellPayload() sends it as an intStr.
      payload: sellPayload(toDid(input.creator), input.tokens, minNetBaseUnits),
      activeAuth: input.seller,
      rcLimit: this.config.rcLimit
    });
    const txId = await this.broadcast(op);
    // ★ CONFIRM EXECUTION (2026-08-31). This used to return a projected balance
    // (pending) the instant Hive accepted the op — MEASURED as reporting
    // success for a real sell the chain refused (57, main). Confirm terminal first.
    const outcome = await this.awaitExecution(txId);
    if (outcome === 'failed') {
      throw new Error('CREATOR_TOKENS_SELL_REFUSED: the chain refused this sale, so no tokens were sold and no HBD was paid out.');
    }
    if (outcome === 'timeout') {
      throw new Error(
        'CREATOR_TOKENS_SELL_UNCONFIRMED: Hive accepted your sale, but Magi has not confirmed it yet. Check your balance before selling again.'
      );
    }
    // Confirmed. Return the PROJECTION (tokens debited off the whole balance),
    // not a re-read: the UI invalidates on success and refetches the exact
    // post-state, so a re-read here would be redundant with that AND would leave
    // this projection's own both-buckets debit math untested by
    // sell-two-buckets.selftest, which exists to prove exactly that (43/57,
    // 2026-09-01). Project the sold tokens off the pre-broadcast
    // balance. Unlike Buy, selling never re-ages the remainder (holdclock.go
    // debitBalance: wacq is untouched by a debit), so the prior
    // heldBlocks/exitTaxBps stay exactly right for what remains.
    // floorValueHbd is kept at its pre-sell figure (same best-effort
    // simplification as buy() — an exact post-sell value needs a fresh
    // (reserve, supply) read).
    const nextTokens = Math.max(0, priorPosition.tokensHeld - input.tokens);
    return {
      creator: input.creator,
      holder: input.seller,
      tokensHeld: nextTokens,
      floorValueHbd: priorPosition.floorValueHbd,
      heldBlocks: priorPosition.heldBlocks,
      exitTaxBps: priorPosition.exitTaxBps,
      pending: true
    };
  }

  async retire(input: RetireInput): Promise<Market> {
    this.assertBroadcaster();
    const [priorMarket, head] = await Promise.all([this.readMarket(input.creator), this.gql.getHeadBlock()]);
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'retire',
      payload: retirePayload(toDid(input.creator)),
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    const txId = await this.broadcast(op);
    // ★ CONFIRM EXECUTION (2026-08-31). Retiring winds the market down and
    // switches the exit rail; a refusal used to return an optimistic retired
    // market as though it had happened. Confirm to a terminal status first.
    const outcome = await this.awaitExecution(txId);
    if (outcome === 'failed') {
      throw new Error('CREATOR_TOKENS_RETIRE_REFUSED: the chain refused this retire, so the market is unchanged.');
    }
    if (outcome === 'timeout') {
      throw new Error(
        'CREATOR_TOKENS_RETIRE_UNCONFIRMED: Hive accepted the retire, but Magi has not confirmed it yet. Check the market before retiring again.'
      );
    }
    // Confirmed. Return the PROJECTION, not a re-read (UI invalidates + refetches
    // exact state; 43/57, 2026-09-01).
    if (!priorMarket || priorMarket.phase === 'UNKNOWN' || head === null) {
      return { ...(priorMarket ?? unknownMarket(input.creator)), pending: true };
    }
    // market.go Retire stamps kRetiredAt at the block THIS call executes at
    // — a height this client cannot know precisely before confirmation.
    // `head` (read just before broadcasting) is the closest honest estimate;
    // the poll reconciles the exact mark. RULING D/K3: from this block on the
    // market is in its 5-day OVERDUE notice (derivePhase's 4th arg reproduces
    // the MAX(natural, retired) fold), and — the load-bearing K3 change —
    // BOTH new inflows AND the curve Sell rail close IMMEDIATELY, not just
    // once the notice expires to FROZEN.
    const retiredAtBlock = head;
    const retiredPhase = derivePhase(false, priorMarket.paidUntilBlock, head, retiredAtBlock);
    return {
      ...priorMarket,
      retiredAtBlock,
      phase: retiredPhase,
      canBuy: false,
      canAsk: false,
      // requireMarketAcceptsMoney refuses a retired market too (market.go:408).
      canRenew: false,
      pending: true
    };
  }

  /**
   * offerings.go ListOfferings, read directly from state (the wasmexport of the
   * same name is a contract-side helper; a frontend reads keys, it does not
   * call exports).
   *
   * THREE SEQUENTIAL READS, and the order is load-bearing: offering keys are
   * EPOCH-SCOPED (Register bumps kOfferEpoch to orphan a dead incarnation's
   * whole catalogue in one write), and the id list lives under the epoch, so
   * neither the ids nor the per-offering keys can be built until the epoch is
   * known. Reading with a stale or assumed epoch returns a DEAD shop that looks
   * perfectly live.
   *
   * An absent epoch key is 0, which is the correct first-incarnation value —
   * not an error.
   */
  /**
   * One offering's posted price in base units, or 0 if it does not exist or was
   * deleted. Two reads, for the same epoch-scoping reason listOfferings has
   * three — see its doc.
   */
  private async readOfferingPriceBaseUnits(creator: string, offeringId: number): Promise<number> {
    const epochState = await this.gql.getStateByKeys(this.config.contractId, [kOfferEpoch(creator)]);
    const epoch = toU64(epochState[kOfferEpoch(creator)]);
    const priceKey = kOfferPrice(creator, epoch, offeringId);
    const state = await this.gql.getStateByKeys(this.config.contractId, [priceKey]);
    return toU64(state[priceKey]);
  }

  /**
   * The ranked creator list. TWO SOURCES, deliberately:
   *
   *   - the ORDER and the delivery stats come from the indexer view, which does
   *     the ranking in SQL so no client can quietly re-rank on price or volume;
   *   - the PRICE and CAP come from a single BATCHED chain read, because the
   *     indexer stores no price (it is a pure function of supply) and a replayed
   *     one would be stale the moment anyone traded.
   *
   * One getStateByKeys covers every creator at once — 3 keys each, and the
   * client batches internally — so this is two round trips regardless of how
   * many creators come back, not two per creator.
   */
  /**
   * The indexer's ingest position versus the node's. Both sides are read in
   * ONE round of parallel calls, so the two heights are as close to the same
   * instant as two network reads can be — comparing an indexer height fetched
   * now against a node height cached from earlier would manufacture lag that
   * is not there.
   *
   * ★ NEVER REJECTS, unlike every other indexer-backed read on this class.
   * That is deliberate and is the opposite of `readDiscovery`'s contract right
   * above. `readDiscovery` must reject, because resolving [] would be a false
   * claim that nobody has launched a token. This method's whole job is to
   * annotate a screen that has ALREADY loaded, so a throw here would blank a
   * working page over a diagnostic. `available: false` says "cannot tell",
   * which the UI is required to render as unknown and never as healthy.
   */
  async readIndexerHealth(): Promise<IndexerHealth> {
    const unknown: IndexerHealth = {
      available: false,
      lastUpdate: null,
      indexerBlock: null,
      nodeBlock: null,
      blocksBehind: null
    };
    if (!this.indexer) return unknown;
    try {
      const [health, nodeBlock] = await Promise.all([this.indexer.health(), this.gql.getHeadBlock()]);
      const indexerBlock = health.latestBlockHeight;
      // Both heights, or no lag number at all. A one-sided read cannot produce
      // a difference, and defaulting the missing side to 0 would report the
      // entire chain height as the lag.
      const blocksBehind =
        indexerBlock !== null && nodeBlock !== null ? Math.max(0, nodeBlock - indexerBlock) : null;
      return { available: true, lastUpdate: health.lastUpdate, indexerBlock, nodeBlock, blocksBehind };
    } catch {
      return unknown;
    }
  }

  async readDiscovery(limit = 60): Promise<CreatorSummary[]> {
    if (!this.indexer) throw new Error('VscCreatorTokensDataSource: discovery needs the Magi indexer (CREATOR_TOKENS_INDEXER_URL)');
    const rows = await this.indexer.discovery(limit);
    if (rows.length === 0) return [];

    /**
     * ★ ONE PASS, FOUR BATCHED ROUND TRIPS, NOT PER-CREATOR (2026-08-23).
     *
     * This read now answers three questions it used to leave to the UI to guess at: the price,
     * the ENTRY price, and whether the market can be bought at all. All three are batched
     * ACROSS every creator on the page — the round-trip count is constant no matter how many
     * creators come back, which is the property that made the old N+1 price read unacceptable.
     *
     * Round 1 adds `kOfferEpoch` (for the offering lookup) and the three phase inputs
     * `kPaidUntil`/`kState`/`kRetiredAt`, which `derivePhase` needs and which
     * `readMarket` already reads the same way (see :718-733). Rounds 2 and 3 resolve every
     * creator's offering ids and then every offering price in two flat batches.
     */
    const keys = rows.flatMap((r) => [
      kSupply(r.creator),
      kFace(r.creator),
      kRegisteredAt(r.creator),
      kOfferEpoch(r.creator),
      kPaidUntil(r.creator),
      kState(r.creator),
      kRetiredAt(r.creator)
    ]);
    const [state, head, rules] = await Promise.all([this.gql.getStateByKeys(this.config.contractId, keys), this.gql.getHeadBlock(), this.readRules()]);

    const epochOf = (c: string) => toU64(state[kOfferEpoch(c)]);
    const idsState = await this.gql.getStateByKeys(
      this.config.contractId,
      rows.map((r) => kOfferIds(r.creator, epochOf(r.creator)))
    );
    const idsOf = (c: string) => parseOfferIds(idsState[kOfferIds(c, epochOf(c))]);
    const priceKeys = rows.flatMap((r) =>
      idsOf(r.creator).map((id) => kOfferPrice(r.creator, epochOf(r.creator), id))
    );
    const priceState = priceKeys.length
      ? await this.gql.getStateByKeys(this.config.contractId, priceKeys)
      : {};
    // A price of 0 is deleted/unset (reads.ts), never a free offering — skipping them is what
    // stops a removed offering from advertising a creator's entry price as $0.
    const fromBaseUnitsOf = (c: string, faceBaseUnits: number) => {
      const prices = idsOf(c)
        .map((id) => toU64(priceState[kOfferPrice(c, epochOf(c), id)]))
        .filter((pr) => pr > 0);
      return prices.length ? Math.min(...prices, faceBaseUnits) : faceBaseUnits;
    };

    return rows
      .map((r) => {
        // A market the chain has never registered cannot be shown, whatever the
        // index says — the index can lag, and chain state is the record.
        if (toU64(state[kRegisteredAt(r.creator)]) === 0) return null;
        const supply = toU64(state[kSupply(r.creator)]);
        // ★ THE DISPLAY PRICE, NOT THE ORACLE RATE (QA, 2026-08-20). This called
        // `spotRateBaseUnits`, which returns 0 at supply 0 by design — so a
        // freshly launched market showed "Token $0.00" on the directory while its
        // OWN page correctly showed $1.01, at the same moment. The detail page was
        // fixed for exactly this once; the grid is a second call site the fix
        // never reached. `contract-math.ts` warns against confusing the two.
        const priceBaseUnits = displayPricePerTokenBaseUnits(supply);
        const faceBaseUnits = toU64(state[kFace(r.creator)]);
        const retiredAtBlock = toU64(state[kRetiredAt(r.creator)]) || null;
        // Without a head we cannot date the lapse clock, so the phase is genuinely
        // UNKNOWN rather than assumed healthy (the UI renders "status unavailable").
        const phase =
          head === null
            ? ('UNKNOWN' as const)
            : derivePhase(state[kState(r.creator)] === STATE_CLOSED, toU64(state[kPaidUntil(r.creator)]), head, retiredAtBlock);
        // ★ WINDING DOWN vs a RECOVERABLE PAUSE (2026-09-01). The grid used to
        // label every FROZEN market "Delisted", a v2-only word meaning a
        // recoverable pause, so a RETIRED or v1-frozen (permanent) wind-down read
        // as reversible. Derive it under the live rules the token page uses so the
        // card can tell the two apart, rather than branching on raw phase alone.
        const windingDown = phase === 'UNKNOWN' ? false : windingDownUnder(rules, { phase, retiredAtBlock });
        return {
          creator: r.creator,
          completionPct: r.completionPct,
          avgRating: r.avgRating,
          ratingCount: r.ratingCount,
          answeredCount: r.answeredCount,
          missedCount: r.missedCount,
          medianResponseBlocks: r.medianResponseBlocks,
          priceHbd: baseUnitsToHuman(priceBaseUnits),
          marketCapHbd: baseUnitsToHuman(priceBaseUnits * supply),
          faceHbd: baseUnitsToHuman(faceBaseUnits),
          fromPriceHbd: baseUnitsToHuman(fromBaseUnitsOf(r.creator, faceBaseUnits)),
          phase,
          windingDown,
          // "New" is measured from the LATEST registration, and only when we
          // actually know the head — guessing would put every creator in the
          // new shelf, or none.
          isNew: head !== null && r.registeredBlock > 0 && head - r.registeredBlock < 30 * BLOCKS_PER_DAY
        };
      })
      .filter((c): c is CreatorSummary => c !== null);
  }

  /**
   * Price history. The indexer stores SUPPLY at each trade, never a price — the
   * price is a pure function of supply on a bonding curve, and storing it would
   * be a second copy of the curve that can disagree with the buy button. This
   * applies the same ported formula the quote path uses.
   */
  async readPriceHistory(creator: string, limit = 200): Promise<PricePoint[]> {
    if (!this.indexer) throw new Error('VscCreatorTokensDataSource: price history needs the Magi indexer (CREATOR_TOKENS_INDEXER_URL)');
    // ★★★ toDid() WAS MISSING HERE, AND ONLY HERE (2026-08-28). The indexer
    // stores the creator as a DID (`hive:lumen.beat`), and reads.ts calls
    // toDid() "the ONE conversion point" for exactly this reason. Its three
    // sibling indexer reads on this class remember it — balancesOf(toDid(...)),
    // asksOf(toDid(...)), deliveryOf(toDid(...)) — and this one did not, so it
    // queried the bare handle the page routes on.
    //
    // Hasura answers a no-match with an empty array, never an error, so the
    // chart and the price-change indicator both rendered "no history yet" on
    // EVERY market that has ever traded. Measured against the live testnet
    // indexer on 2026-08-28: creator "lumen.beat" returns 0 rows, creator
    // "hive:lumen.beat" returns its real trades from the same query.
    const points = await this.indexer.priceHistoryOf(toDid(creator), limit);
    // ★ Same function the headline price uses (2026-08-07) — a chart drawn from
    // the ORACLE rate would print 0 for a market that has been fully sold back
    // to supply 0, while the header showed the real 1.000 HBD reset price.
    // Identical for every supply >= 1; this only fixes that one point.
    const priceAt = (supply: number): number => baseUnitsToHuman(displayPricePerTokenBaseUnits(supply));

    /*
     * ★★★ A SUPPLY THAT CANNOT EXIST IS NOT A DATA POINT (2026-08-30).
     *
     * Found by an adversarial sweep hours after the opening point below shipped,
     * and it is OUR regression, not a pre-existing one. `hive:magi.contracts` has
     * exactly one row on the live testnet indexer: `{supply_after: -2, delta: -2,
     * side: sell}`. A negative supply is impossible on chain; the view computes
     * `supply_after` as a window sum over bought and sold events only
     * (`magi-indexer/creator_tokens_views.yaml:113-124`), so any event class it
     * does not sum can drive it below zero.
     *
     * Before the opening point existed, a one-row market fell under `adapt.ts`'s
     * two-point floor and drew nothing, so the bad row was invisible. Adding the
     * opening point lifted it OVER that floor, and the page then rendered a line
     * falling to the axis captioned "Price down 100.0% across the 1 recorded
     * trade in this market" — on a page whose own header said the market holds 8
     * tokens at $1.07. We made a latent bad row into a false statement about
     * someone's money.
     *
     * `priceAt(-2)` returns 0 rather than throwing, which is exactly why this
     * had to be caught by looking rather than by an exception. Drop the row: a
     * missing point is honest, a fabricated 100% crash is not. The guard the
     * opening point already applied to its DERIVED supply now applies to every
     * row's own.
     */
    const usable = points.filter((p) => Number.isFinite(p.supplyAfter) && p.supplyAfter >= 0);
    const trades: PricePoint[] = usable.map((p) => ({ block: p.block, priceHbd: priceAt(p.supplyAfter) }));

    // ★★★ THE OPENING POINT (2026-08-30). Owner: *"theres no chart in the
    // market."* Reproduced at /creators/@hbd-temp on the running build: a market
    // reading "30 of 30 tokens issued — Sold out" rendered "No price history
    // yet. A chart appears once this market has traded more than once."
    //
    // It is not the toDid defect above coming back — that fix holds, and the
    // same page draws 17 points for `hive:lumen.beat`. It is an OFF-BY-ONE IN
    // WHAT A ROW MEANS. A `lumen_ct_price_history` row records where supply
    // LANDED, so one trade is one point, and `live/adapt.ts` (rightly) refuses
    // to draw a line through one point. But a trade has two ends: the row's own
    // `delta` is the signed change, so `supplyAfter - delta` is the supply the
    // market held immediately BEFORE the oldest trade we fetched. That is a
    // recorded state at a real moment, and its price comes from the SAME curve
    // function as every other point here — not an interpolation, not a guess.
    //
    // hbd-temp: one row {supply_after 30, delta +30} -> opening supply 0, whose
    // price is 1.007 HBD (buyCost(0,1), NOT the oracle's zero at supply 0), and
    // the chart draws 1.007 -> 1.247. Both ends true, both checkable.
    //
    // ONLY THE OLDEST ROW'S. Every later row's "before" is the previous row's
    // `supplyAfter` and is already plotted; prepending each would double every
    // point. And when the series is capped at `limit`, the oldest fetched row's
    // predecessor is still a genuine past supply, so this stays honest for a
    // market past 200 trades as well.
    //
    // GUARDED, because a wrong extra point would be worse than a missing chart:
    // no rows means no market history to open (0 stays 0, never a fabricated
    // line); a non-finite or negative derived supply means the `delta` column
    // could not be read, and the series is returned exactly as it was.
    const oldest = usable[0];
    if (!oldest) return trades;
    const openingSupply = oldest.supplyAfter - oldest.delta;
    if (!Number.isFinite(openingSupply) || openingSupply < 0) return trades;
    return [
      {
        // The opening state held from registration until the trade that ended
        // it, so the block BEFORE that trade is a block at which it was true.
        block: Math.max(0, oldest.block - 1),
        priceHbd: priceAt(openingSupply),
        // Not a trade. Everything that states a basis counts on this flag.
        opening: true
      },
      ...trades
    ];
  }

  async listOfferings(creator: string): Promise<Offering[]> {
    const epochState = await this.gql.getStateByKeys(this.config.contractId, [kOfferEpoch(creator)]);
    const epoch = toU64(epochState[kOfferEpoch(creator)]);

    const idsKey = kOfferIds(creator, epoch);
    const idsState = await this.gql.getStateByKeys(this.config.contractId, [idsKey]);
    const ids = parseOfferIds(idsState[idsKey]);
    if (ids.length === 0) return [];

    const keys = ids.flatMap((id) => [kOfferPrice(creator, epoch, id), kOfferTitle(creator, epoch, id)]);
    const state = await this.gql.getStateByKeys(this.config.contractId, keys);

    const out: Offering[] = [];
    for (const id of ids) {
      const priceBaseUnits = toU64(state[kOfferPrice(creator, epoch, id)]);
      // price 0 means deleted or never set, and the contract REFUSES an ask
      // against it rather than falling back to the face price. Listing it
      // would advertise a service that cannot be bought.
      if (priceBaseUnits <= 0) continue;
      out.push({
        offeringId: id,
        title: state[kOfferTitle(creator, epoch, id)] ?? '',
        priceHbd: baseUnitsToHuman(priceBaseUnits),
        priceBaseUnits
      });
    }
    return out;
  }

  async ask(input: AskInput): Promise<Ask> {
    this.assertBroadcaster();
    if (input.deadlineBlocks < MIN_ASK_DEADLINE_BLOCKS) throw new Error('VscCreatorTokensDataSource: deadline below MinAskDeadline');
    // ask.go enforces BOTH bounds on-chain; without this the tx broadcasts,
    // reverts, and the asker pays RC for a rejection we could see locally.
    if (input.deadlineBlocks > MAX_ASK_DEADLINE_BLOCKS) throw new Error('VscCreatorTokensDataSource: deadline above MaxAskDeadline');
    // ask.go Ask — contentHash validation, mirroring answer()'s identical
    // guard on answerHash below. Zero-extra-read.
    if (input.contentHash === '') {
      throw new Error('VscCreatorTokensDataSource: contentHash must not be empty');
    }
    if (input.contentHash.includes('|')) {
      throw new Error("VscCreatorTokensDataSource: contentHash must not contain '|'");
    }
    // ask.go Ask — reject a missing/zero maxCredits cap client-side rather
    // than letting an effectively-unlimited-spend call reach the chain: this
    // is the asker's own signed cap protecting against a creator spiking
    // `face` between signing and execution (see AskInput.maxCreditsBaseUnits's
    // own doc) — a call that arrives with no real cap defeats the whole point
    // of the guard existing, whether or not core would also catch it.
    if (!Number.isFinite(input.maxCreditsBaseUnits) || input.maxCreditsBaseUnits <= 0) {
      throw new Error('VscCreatorTokensDataSource: maxCreditsBaseUnits must be > 0');
    }
    // ask.go Ask -> market.go RequireInflowOpen — the canAsk gate, identical
    // in shape to buy()'s canBuy guard above (same RequireInflowOpen
    // chokepoint on the Go side, same Market field pair on this side).
    // Skipped — never blocked — when the market can't be read or was never
    // registered; see quoteBuy()'s comment for why.
    const market = await this.readMarket(input.creator);
    if (market && market.phase !== 'UNKNOWN' && !market.canAsk) {
      throw new Error('VscCreatorTokensDataSource: market inflow is not open (frozen, closed, retiring, or globally paused)');
    }
    // ★ RULING C: core.Ask's own settlement (settlement.go) now REFUSES
    // rather than falling back to PAR — readQuote() reflects that refusal via
    // creditsRequiredBaseUnits === null, and this call must refuse identically
    // rather than inventing a rate.
    // Quote the SAME offering the ask will name, or the commission leg and the
    // maxCredits check below would both be computed against the wrong posted
    // price (see readQuote's offeringId doc).
    const quote = await this.readQuote(input.creator, input.offeringId);
    if (quote.creditsRequiredBaseUnits === null) {
      throw new Error(`VscCreatorTokensDataSource: unable to price this ask (${quote.oracleStatus})`);
    }
    // ask.go Ask — creditsSpent > maxCredits, checked client-side against the
    // SAME quote fetched immediately above (so this can only fire when the
    // ask was already, definitely going to revert on the chain's own
    // identical check) — fail fast locally rather than spend RC on a
    // guaranteed revert.
    if (quote.creditsRequiredBaseUnits > input.maxCreditsBaseUnits) {
      throw new Error('VscCreatorTokensDataSource: settlement price exceeds maxCreditsBaseUnits');
    }
    // H2 fix (kept): the wrapper computes the EXACT commission itself via
    // core.CommissionOwedFor — main.go's `ask` entrypoint no longer reads a
    // commissionHbdPaid payload field at all (askPayload lost that parameter
    // with the pivot), so this is the intents-only HBD leg, never a wire field.
    const commissionBaseUnits = commissionOwedForBaseUnits(humanToBaseUnits(quote.faceHbd));
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'ask',
      payload: askPayload(toDid(input.creator), input.contentHash, input.deadlineBlocks, input.maxCreditsBaseUnits, input.offeringId),
      hbdLegBaseUnits: commissionBaseUnits,
      activeAuth: input.asker,
      rcLimit: this.config.rcLimit
    });
    const txId = await this.broadcast(op);
    // ★ CONFIRM EXECUTION (2026-08-31). An ask escrows the asker's tokens and
    // charges the HBD commission; a refusal (settlement-spend cap, a closed
    // window, the delivery gate) used to return an optimistic 'awaiting' Ask as
    // though the escrow had opened. It is the escrow op that OPENS one, so its
    // three siblings (answer/decline/reclaim) confirm and this did not.
    const outcome = await this.awaitExecution(txId);
    if (outcome === 'failed') {
      throw new Error('CREATOR_TOKENS_ASK_REFUSED: the chain refused this request, so nothing was escrowed and no commission was charged.');
    }
    if (outcome === 'timeout') {
      throw new Error(
        'CREATOR_TOKENS_ASK_UNCONFIRMED: Hive accepted your request, but Magi has not confirmed it yet. Check your requests before sending it again.'
      );
    }
    // Confirmed on chain (the caller still re-reads readCreatorAsks for the
    // real seq). The contract assigns `seq` server-side; the frontend cannot know it
    // before the tx lands. Return an optimistic placeholder — the caller
    // must re-read readCreatorAsks() to get the real seq once confirmed. This
    // is the canonical PENDING pattern the Market/HolderPosition writes now
    // mirror: unconfirmed both structurally (seq -1, id `:pending`) and via
    // the explicit `pending` flag.
    return {
      id: `${input.creator}:pending`,
      creator: input.creator,
      seq: -1,
      asker: input.asker,
      tokensEscrowed: quote.creditsRequired ?? 0,
      // Unconfirmed: the chain stamps the real hold clock at execution. 0
      // reads as maximally FRESH, which is the safe direction to guess.
      acqBlock: 0,
      deadlineBlock: quote.asOfBlock + input.deadlineBlocks,
      deadlineAt: blockToEpochMs(quote.asOfBlock + input.deadlineBlocks, quote.asOfBlock),
      reclaimableAtBlock: quote.asOfBlock + input.deadlineBlocks + RECLAIM_GRACE_BLOCKS,
      reclaimableAt: blockToEpochMs(quote.asOfBlock + input.deadlineBlocks + RECLAIM_GRACE_BLOCKS, quote.asOfBlock),
      status: 'awaiting',
      contentHash: input.contentHash,
      answerHash: null,
      pending: true
    };
  }

  async answer(input: AnswerInput): Promise<Ask> {
    this.assertBroadcaster();
    // ★ ONE VALIDATOR, NOT A THIRD HAND-WRITTEN COPY (2026-08-31). These two
    // inline checks were the third independent transcription of ask.go's hash
    // rules (payload-contract's assertHashField and the Studio dialog's
    // answerValid being the other two), and all three were incomplete in
    // different ways: none checked control characters, which ask.go's
    // validEventHash refuses, and the length checks counted UTF-16 units where
    // the contract counts BYTES. assertHashField is now the single source.
    assertHashField('answerHash', input.answerHash);
    // ask.go Answer — the answer half of the I6 disjoint window (block <=
    // deadline). Needs the CURRENT chain head, fetched fresh rather than
    // trusting any cached value the caller might be holding — a stale head
    // could let this guard pass locally on a call that would still revert
    // on-chain a moment later. Deliberately does NOT re-read the escrow
    // itself (kEscrow) to get the deadline — that would incidentally
    // implement the excluded escrow-existence check; AnswerInput.deadlineBlock
    // carries it instead, sourced from the Ask the caller already has.
    const head = await this.gql.getHeadBlock();
    if (head === null) {
      throw new Error('VscCreatorTokensDataSource: cannot verify the answer window (chain head unavailable)');
    }
    if (head > input.deadlineBlock) {
      throw new Error('VscCreatorTokensDataSource: answer window closed');
    }
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'answer',
      payload: answerPayload(input.seq, input.answerHash),
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    // ★ CONFIRM EXECUTION, do not project it (H-A, 2026-08-31). See
    // awaitEscrowStatus: a projected 'answered' on a call the chain refused
    // becomes an unearned miss on a permanent, public delivery record.
    const observed = await this.awaitEscrowStatus(input.creator, input.seq);
    if (observed === null) {
      throw new Error(
        'CREATOR_TOKENS_ANSWER_UNCONFIRMED: Hive accepted your answer, but Magi has not recorded it yet. It may still land in a moment. Check the ask now before answering again — if it did not land and you wait, the asker can reclaim.'
      );
    }
    if (observed !== 'ANSWERED') {
      throw new Error(
        `CREATOR_TOKENS_ANSWER_REFUSED: the chain resolved this ask as ${observed}, not ANSWERED. Your answer was not recorded.`
      );
    }
    const answered = await this.readOneAsk(input.creator, input.seq);
    return { ...answered, status: 'answered', answerHash: input.answerHash };
  }

  /**
   * ask.go Decline — the creator's free, honest "no". Legal in the SAME window
   * an Answer is (block <= deadlineBlock), so it uses the identical fresh-head
   * guard answer() does, for the identical reason: the escrow's deadline comes
   * from the Ask the caller already holds, so no second chain read is needed.
   *
   * NOT a miss against the delivery record, and it refunds the commission in
   * full — so this is strictly better for both sides than a creator letting an
   * ask rot, and it is what makes ask-flooding pointless as a grief.
   */
  async decline(input: DeclineInput): Promise<Ask> {
    this.assertBroadcaster();
    const head = await this.gql.getHeadBlock();
    if (head === null) {
      throw new Error('VscCreatorTokensDataSource: cannot verify the decline window (chain head unavailable)');
    }
    if (head > input.deadlineBlock) {
      throw new Error('VscCreatorTokensDataSource: decline window closed (the answer window is over; the asker reclaims from here)');
    }
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'decline',
      payload: declinePayload(toDid(input.creator), input.seq),
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    const observed = await this.awaitEscrowStatus(input.creator, input.seq);
    if (observed === null) {
      throw new Error(
        'CREATOR_TOKENS_DECLINE_UNCONFIRMED: Hive accepted the decline, but Magi has not recorded it yet. Re-open the ask to check before declining again.'
      );
    }
    if (observed !== 'DECLINED') {
      throw new Error(`CREATOR_TOKENS_DECLINE_REFUSED: the chain resolved this ask as ${observed}, not DECLINED.`);
    }
    const declined = await this.readOneAsk(input.creator, input.seq);
    return { ...declined, status: 'declined' };
  }

  async rate(input: RateInput): Promise<void> {
    this.assertBroadcaster();
    // Bounds are enforced on-chain too; failing here keeps a guaranteed revert
    // from costing the buyer RC.
    if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
      throw new Error('VscCreatorTokensDataSource: score must be a whole number 1-5');
    }
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'rate',
      payload: ratePayload(toDid(input.creator), input.seq, input.score),
      activeAuth: input.rater,
      rcLimit: this.config.rcLimit
    });
    // ★ CONFIRM EXECUTION (2026-08-31). A rating the chain refused used to
    // return void as though it had been recorded.
    const txId = await this.broadcast(op);
    const outcome = await this.awaitExecution(txId);
    if (outcome === 'failed') {
      throw new Error('CREATOR_TOKENS_RATE_REFUSED: the chain refused this rating, so it was not recorded.');
    }
    if (outcome === 'timeout') {
      throw new Error(
        'CREATOR_TOKENS_RATE_UNCONFIRMED: Hive accepted your rating, but Magi has not confirmed it yet. Check before rating again.'
      );
    }
  }

  async reclaim(input: ReclaimInput): Promise<Ask> {
    this.assertBroadcaster();
    // ask.go Reclaim — the reclaim half of the I6 disjoint window (block >
    // deadline+ReclaimGrace). Same fresh-head, no-escrow-read reasoning as
    // answer()'s identical guard above; ReclaimInput.deadlineBlock carries
    // the escrow's deadline for the same reason.
    const head = await this.gql.getHeadBlock();
    if (head === null) {
      throw new Error('VscCreatorTokensDataSource: cannot verify the reclaim window (chain head unavailable)');
    }
    if (head <= input.deadlineBlock + RECLAIM_GRACE_BLOCKS) {
      throw new Error('VscCreatorTokensDataSource: reclaim window not open');
    }
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'reclaim',
      payload: reclaimPayload(toDid(input.creator), input.seq),
      activeAuth: input.asker,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    const observed = await this.awaitEscrowStatus(input.creator, input.seq);
    if (observed === null) {
      throw new Error(
        'CREATOR_TOKENS_RECLAIM_UNCONFIRMED: Hive accepted the reclaim, but Magi has not recorded it yet. Check the ask before reclaiming again — your tokens are still escrowed until it lands.'
      );
    }
    if (observed !== 'RECLAIMED') {
      throw new Error(`CREATOR_TOKENS_RECLAIM_REFUSED: the chain resolved this ask as ${observed}, not RECLAIMED. Your tokens were not returned.`);
    }
    const reclaimed = await this.readOneAsk(input.creator, input.seq);
    return { ...reclaimed, status: 'reclaimed' };
  }

  async refund(input: RefundInput): Promise<HolderPosition> {
    this.assertBroadcaster();
    assertPositiveTokenCount(input.tokens, 'tokens');
    // Read the CURRENT position AND market BEFORE broadcasting (see
    // registerMarket's own doc) — the market read doubles as refund.go's own
    // rail-switch guard: Refund is the WIND-DOWN rail, open ONLY once the
    // market is winding down (retired, or naturally FROZEN/CLOSED); while it
    // trades, the exit is sell() instead (sell.go/refund.go's shared
    // rail-switch doc — the two rails are state-disjoint by construction).
    const [priorPosition, market] = await Promise.all([this.readHolderPosition(input.creator, input.holder), this.readMarket(input.creator)]);
    if (!priorPosition) throw new Error(`VscCreatorTokensDataSource: no such market ${input.creator}`);
    if (input.tokens > priorPosition.tokensHeld) {
      throw new Error('VscCreatorTokensDataSource: insufficient tokens');
    }
    if (market && market.phase !== 'UNKNOWN') {
      const windingDown = market.windingDown;
      if (!windingDown) {
        throw new Error('VscCreatorTokensDataSource: pro-rata refund opens only at wind-down; while the market trades, exit via sell() instead');
      }
    }
    const minNetBaseUnits = input.minNetHbd !== undefined ? humanToBaseUnits(input.minNetHbd) : undefined;
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'refund',
      // ★ 1000x TRAP: input.tokens is the raw integer token count — the wire
      // field is still named `credits` (main.go's payload shape predates the
      // pivot), but op-builders' refundPayload() sends it as an intStr, never
      // through humanToBaseUnits().
      payload: refundPayload(toDid(input.creator), input.tokens, minNetBaseUnits),
      activeAuth: input.holder,
      rcLimit: this.config.rcLimit
    });
    const txId = await this.broadcast(op);
    // ★ CONFIRM EXECUTION (2026-08-31). Redeeming is a money-OUT path: this used
    // to return a projected balance (pending) as though HBD had been paid out,
    // even if the chain refused the redemption. Confirm to terminal first.
    const outcome = await this.awaitExecution(txId);
    if (outcome === 'failed') {
      throw new Error('CREATOR_TOKENS_REFUND_REFUSED: the chain refused this redemption. Your tokens were not redeemed and no HBD was paid out.');
    }
    if (outcome === 'timeout') {
      throw new Error(
        'CREATOR_TOKENS_REFUND_UNCONFIRMED: Hive accepted your redemption, but Magi has not confirmed it yet. Check your balance before redeeming again.'
      );
    }
    // Confirmed. Return the PROJECTION, not a re-read (UI invalidates + refetches
    // exact state; 43/57, 2026-09-01). Project the redeemed tokens off the
    // pre-broadcast balance (same best-effort floorValueHbd simplification as
    // sell() — refund.go's pro-rata floor is not a simple linear function of
    // tokens removed either).
    const nextTokens = Math.max(0, priorPosition.tokensHeld - input.tokens);
    return {
      creator: input.creator,
      holder: input.holder,
      tokensHeld: nextTokens,
      floorValueHbd: priorPosition.floorValueHbd,
      heldBlocks: priorPosition.heldBlocks,
      exitTaxBps: priorPosition.exitTaxBps,
      pending: true
    };
  }

  async refundHolder(input: RefundHolderInput): Promise<HolderPosition> {
    this.assertBroadcaster();
    // finding M-e: `holder` is the actual payout DESTINATION (never the
    // caller — refund.go's own "can only ever pay the rightful owner, never
    // the caller"), distinct from every other write's account fields, which
    // are all either the signer or a market identifier. core's own
    // validAccount is only a '|' guard, run AFTER the tx has already spent
    // the caller's RC — reject a malformed destination client-side first so
    // a broadcast can never strand a payout at an address the contract
    // would have accepted but that means nothing.
    const holderDid = toDid(input.holder);
    if (!isWellFormedDid(holderDid)) {
      throw new Error('VscCreatorTokensDataSource: holder account is not well-formed');
    }
    // H3/EXITTAX-1: RefundHolder is gated to the SAME wind-down rail as
    // Refund itself (refund.go: "under RULING A/K the pull is rail-routed on
    // the same inWindDown predicate... the two gates now coincide"). Mirrors
    // refund()'s identical guard above.
    const [priorPosition, market] = await Promise.all([this.readHolderPosition(input.creator, input.holder), this.readMarket(input.creator)]);
    if (!priorPosition) throw new Error(`VscCreatorTokensDataSource: no such market ${input.creator}`);
    if (market && market.phase !== 'UNKNOWN') {
      const windingDown = market.windingDown;
      if (!windingDown) {
        throw new Error('VscCreatorTokensDataSource: refundHolder is only available once wind-down opens; the holder may still exit via sell()');
      }
    }
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'refundHolder',
      payload: refundHolderPayload(toDid(input.creator), holderDid),
      activeAuth: input.caller,
      rcLimit: this.config.rcLimit
    });
    const txId = await this.broadcast(op);
    // ★ CONFIRM EXECUTION (2026-08-31). A push-refund the chain refused used to
    // return tokensHeld: 0 (pending) as though the holder had been paid out.
    const outcome = await this.awaitExecution(txId);
    if (outcome === 'failed') {
      throw new Error('CREATOR_TOKENS_REFUND_REFUSED: the chain refused this refund. The holder was not paid out and their tokens were not redeemed.');
    }
    if (outcome === 'timeout') {
      throw new Error(
        "CREATOR_TOKENS_REFUND_UNCONFIRMED: Hive accepted the refund, but Magi has not confirmed it yet. Check the holder's balance before pushing it again."
      );
    }
    // Confirmed. Return the PROJECTION, not a re-read (UI invalidates + refetches
    // exact state; 43/57, 2026-09-01).
    // refund.go RefundHolder always pays out the holder's ENTIRE balance —
    // tokensHeld projects to exactly 0, not an estimate.
    return {
      creator: input.creator,
      holder: input.holder,
      tokensHeld: 0,
      floorValueHbd: 0,
      heldBlocks: priorPosition.heldBlocks,
      exitTaxBps: 0,
      pending: true
    };
  }

  async transferTokens(input: TransferTokensInput): Promise<void> {
    this.assertBroadcaster();
    const toDidAccount = toDid(input.to);
    // main.go Transfer. Zero-extra-read. Compared as DIDs (not the raw input
    // strings) so an inconsistently-prefixed pair (e.g. "alice" vs
    // "hive:alice", which core would treat as the SAME account) is still
    // caught here rather than sailing through as "different" only to collide
    // once toDid() is applied on the wire.
    if (toDid(input.from) === toDidAccount) {
      throw new Error('VscCreatorTokensDataSource: from and to must be different accounts');
    }
    assertPositiveTokenCount(input.tokens, 'tokens');
    // finding M-e: `to` is a genuine third-party DESTINATION distinct from
    // the signer (`from`) — same "reject a malformed destination before it
    // can strand funds" reasoning as refundHolder's holder guard above.
    if (!isWellFormedDid(toDidAccount)) {
      throw new Error('VscCreatorTokensDataSource: destination account is not well-formed');
    }
    // ★ AND it must be a destination that can actually RECEIVE. Well-formed is
    // not the same as real: `toDid()` turns any bare string into `hive:<string>`,
    // so a Lumen display name became a nonexistent Hive account and the tokens
    // were stranded with no way back. See assertTransferDestination.
    assertTransferDestination(input.to);
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'transfer', // the wasm export is `transfer`, not `transferTokens`
      // ★ 1000x TRAP: input.tokens is the raw integer token count —
      // op-builders' transferTokensPayload() sends it as an intStr.
      payload: transferTokensPayload(toDid(input.creator), toDidAccount, input.tokens),
      activeAuth: input.from,
      rcLimit: this.config.rcLimit
    });
    // ★ CONFIRM EXECUTION (2026-08-31). A transfer Hive accepted but the
    // contract refused (bad destination, insufficient balance) used to return
    // void as though the tokens had moved.
    const txId = await this.broadcast(op);
    const outcome = await this.awaitExecution(txId);
    if (outcome === 'failed') {
      throw new Error('CREATOR_TOKENS_TRANSFER_REFUSED: the chain refused this transfer, so no tokens were moved.');
    }
    if (outcome === 'timeout') {
      throw new Error(
        'CREATOR_TOKENS_TRANSFER_UNCONFIRMED: Hive accepted the transfer, but Magi has not confirmed it yet. Check the balances before sending again.'
      );
    }
  }

  async claimTradeFees(input: ClaimTradeFeesInput): Promise<number> {
    this.assertBroadcaster();
    // tradefee.go ClaimTradeFees pulls the CALLER'S ENTIRE accrued balance —
    // the pre-broadcast read below IS the exact amount this call claims
    // (there is no partial-claim path), so no post-write reconciliation is
    // needed the way Market/HolderPosition writes require.
    const owedHbd = await this.readFeeBalance(input.account);
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'claimTradeFees',
      payload: claimTradeFeesPayload(),
      activeAuth: input.account,
      rcLimit: this.config.rcLimit
    });
    // ★ CONFIRM THE PAYOUT (2026-08-31, seventeen-unconfirmed-writes finding).
    // This used to `return owedHbd` the instant Hive accepted the op — telling
    // the creator they had been paid, before the contract had run, and staying
    // wrong if the chain refused the claim. Confirm to a terminal status first;
    // only CONFIRMED means the fees actually left the fee balance.
    const txId = await this.broadcast(op);
    const outcome = await this.awaitExecution(txId);
    if (outcome === 'failed') {
      throw new Error(
        'CREATOR_TOKENS_CLAIM_REFUSED: the chain refused this claim, so no fees were paid out. Your fee balance is unchanged.'
      );
    }
    if (outcome === 'timeout') {
      throw new Error(
        'CREATOR_TOKENS_CLAIM_UNCONFIRMED: Hive accepted your claim, but Magi has not confirmed the payout yet. Check your fee balance before claiming again.'
      );
    }
    return owedHbd;
  }

  async closeIfDrained(input: CloseIfDrainedInput): Promise<boolean> {
    this.assertBroadcaster();
    const priorMarket = await this.readMarket(input.creator);
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'closeIfDrained',
      payload: closeIfDrainedPayload(toDid(input.creator)),
      activeAuth: input.caller,
      rcLimit: this.config.rcLimit
    });
    // ★ CONFIRM EXECUTION (2026-08-31). We now DO observe the outcome, via the
    // tx's own terminal status (awaitExecution), rather than only projecting it.
    const txId = await this.broadcast(op);
    const outcome = await this.awaitExecution(txId);
    if (outcome === 'failed') {
      throw new Error('CREATOR_TOKENS_CLOSE_REFUSED: the chain refused this close.');
    }
    if (outcome === 'timeout') {
      throw new Error(
        'CREATOR_TOKENS_CLOSE_UNCONFIRMED: Hive accepted the close, but Magi has not confirmed it yet. Check the market before trying again.'
      );
    }
    // refund.go CloseIfDrained: (FROZEN AND supply===0) => CLOSED, or already
    // CLOSED => true, else false — idempotent on the contract side. The tx
    // CONFIRMED above, so the pre-broadcast projection is what the contract did.
    if (!priorMarket || priorMarket.phase === 'UNKNOWN') return false;
    // Under v2 only a RETIRED frozen market closes (market/contract-rules.ts).
    return closesIfDrainedUnder(priorMarket.rules, priorMarket);
  }

  // ---- the offerings shop. The caller IS the creator on all four writes, so
  // none of them carries a `creator` payload field; input.creator is only ever
  // used as the SIGNER (activeAuth). Prices are UNQUOTED base-units integers on
  // the wire — see op-builders.ts's shop section for why a quoted string there
  // would post a free service. ----

  async createOffering(input: CreateOfferingInput): Promise<void> {
    this.assertBroadcaster();
    // ★ THE SHARED VALIDATOR, not a trim() (2026-08-31, M-2). The UI gates on
    // offerTitleProblem while the creator types, but this layer accepted
    // anything non-empty — so a title that is too long in BYTES, or carries a
    // '|' / ',' / control byte, reached the chain and reverted after signing.
    // validOfferTitle refuses all four (core/offerings.go:192-207).
    assertValidOfferTitle(input.title);
    if (!(input.priceHbd > 0)) throw new Error('VscCreatorTokensDataSource: offering price must be > 0');
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'createOffering',
      payload: createOfferingPayload(input.title, humanToBaseUnits(input.priceHbd)),
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    // ★ CONFIRM EXECUTION (2026-08-31). A service the chain refused used to
    // return void as though it had been created.
    const txId = await this.broadcast(op);
    const outcome = await this.awaitExecution(txId);
    if (outcome === 'failed') {
      throw new Error('CREATOR_TOKENS_OFFERING_REFUSED: the chain refused this service, so it was not created.');
    }
    if (outcome === 'timeout') {
      throw new Error(
        'CREATOR_TOKENS_OFFERING_UNCONFIRMED: Hive accepted the new service, but Magi has not confirmed it yet. Check your services before adding it again.'
      );
    }
  }

  async setOfferingPrice(input: SetOfferingPriceInput): Promise<void> {
    this.assertBroadcaster();
    if (!(input.newPriceHbd > 0)) throw new Error('VscCreatorTokensDataSource: offering price must be > 0');
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'setOfferingPrice',
      payload: setOfferingPricePayload(input.offeringId, humanToBaseUnits(input.newPriceHbd)),
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    // ★ CONFIRM EXECUTION (2026-08-31). Confirm the price change landed before
    // returning it as done.
    const txId = await this.broadcast(op);
    const outcome = await this.awaitExecution(txId);
    if (outcome === 'failed') {
      throw new Error('CREATOR_TOKENS_OFFERING_PRICE_REFUSED: the chain refused this price change, so the service price is unchanged.');
    }
    if (outcome === 'timeout') {
      throw new Error(
        'CREATOR_TOKENS_OFFERING_PRICE_UNCONFIRMED: Hive accepted the price change, but Magi has not confirmed it yet. Check the service before changing it again.'
      );
    }
  }

  async setOfferingTitle(input: SetOfferingTitleInput): Promise<void> {
    this.assertBroadcaster();
    assertValidOfferTitle(input.title); // see createOffering — same contract rule, same reason
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'setOfferingTitle',
      payload: setOfferingTitlePayload(input.offeringId, input.title),
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    // ★ CONFIRM EXECUTION (2026-08-31). Confirm the rename landed before
    // returning it as done.
    const txId = await this.broadcast(op);
    const outcome = await this.awaitExecution(txId);
    if (outcome === 'failed') {
      throw new Error('CREATOR_TOKENS_OFFERING_TITLE_REFUSED: the chain refused this rename, so the service name is unchanged.');
    }
    if (outcome === 'timeout') {
      throw new Error(
        'CREATOR_TOKENS_OFFERING_TITLE_UNCONFIRMED: Hive accepted the rename, but Magi has not confirmed it yet. Check the service before renaming it again.'
      );
    }
  }

  async deleteOffering(input: DeleteOfferingInput): Promise<void> {
    this.assertBroadcaster();
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'deleteOffering',
      payload: deleteOfferingPayload(input.offeringId),
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    // ★ CONFIRM EXECUTION (2026-08-31). Confirm the removal landed before
    // returning it as done.
    const txId = await this.broadcast(op);
    const outcome = await this.awaitExecution(txId);
    if (outcome === 'failed') {
      throw new Error('CREATOR_TOKENS_OFFERING_DELETE_REFUSED: the chain refused this removal, so the service is still listed.');
    }
    if (outcome === 'timeout') {
      throw new Error(
        'CREATOR_TOKENS_OFFERING_DELETE_UNCONFIRMED: Hive accepted the removal, but Magi has not confirmed it yet. Check your services before removing it again.'
      );
    }
  }

  async withdrawTreasury(input: WithdrawTreasuryInput): Promise<number> {
    this.assertBroadcaster();
    if (!Number.isFinite(input.amountHbd) || input.amountHbd <= 0) {
      throw new Error('VscCreatorTokensDataSource: amountHbd must be positive');
    }
    const amountBaseUnits = humanToBaseUnits(input.amountHbd);
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'withdrawTreasury',
      payload: withdrawTreasuryPayload(amountBaseUnits),
      activeAuth: input.caller,
      rcLimit: this.config.rcLimit
    });
    // ★ CONFIRM EXECUTION (2026-08-31). This used to `return input.amountHbd`
    // the instant Hive accepted the op — reporting a withdrawal the contract
    // may have refused (over the treasury balance, not the owner, paused).
    const txId = await this.broadcast(op);
    const outcome = await this.awaitExecution(txId);
    if (outcome === 'failed') {
      throw new Error(
        'CREATOR_TOKENS_WITHDRAW_REFUSED: the chain refused this withdrawal. Nothing was withdrawn from the treasury.'
      );
    }
    if (outcome === 'timeout') {
      throw new Error(
        'CREATOR_TOKENS_WITHDRAW_UNCONFIRMED: Hive accepted the withdrawal, but Magi has not confirmed it yet. Check the treasury balance before withdrawing again.'
      );
    }
    // read.go WithdrawTreasury debits EXACTLY `amount` (bounded to (0,
    // current treasury balance] — an over-withdrawal is refused outright,
    // never clamped), so a confirmed call withdrew exactly what was requested.
    return input.amountHbd;
  }

  private assertBroadcaster(): void {
    if (!this.broadcaster) throw new Error(NO_BROADCASTER_MSG);
  }

  private async broadcast(op: CustomJsonOp): Promise<string> {
    if (!this.broadcaster) throw new Error(NO_BROADCASTER_MSG);
    return this.broadcaster(op);
  }

  private assertBundleBroadcaster(): void {
    if (!this.bundleBroadcaster) throw new Error(NO_BUNDLE_BROADCASTER_MSG);
  }

  private async bundleBroadcast(ops: CustomJsonOp[]): Promise<string> {
    if (!this.bundleBroadcaster) throw new Error(NO_BUNDLE_BROADCASTER_MSG);
    return this.bundleBroadcaster(ops);
  }

  /**
   * S4 (2026-08-30): poll kPaidUntil until it advances past `before`, or give
   * up. `before === null` (the pre-read was unusable) still polls, but for ANY
   * non-zero value change across the window rather than a strict advance, and
   * a read failure inside the window counts as "not yet", never as confirmed.
   * Same 90 s / 3 s cadence as the wallet rail's waitForInclusion.
   */
  private async awaitPaidUntilAdvance(creator: string, before: number | null): Promise<boolean> {
    const TIMEOUT_MS = RENEW_CONFIRM_TIMEOUT_MS;
    const POLL_MS = 3_000;
    const key = kPaidUntil(toDid(creator));
    const deadline = Date.now() + TIMEOUT_MS;
    let first: number | null = null;
    for (;;) {
      try {
        const state = await this.gql.getStateByKeys(this.config.contractId, [key]);
        const now = toU64(state[key]);
        if (before !== null ? now > before : first !== null && now !== first) return true;
        if (first === null) first = now;
      } catch {
        // not yet; a read failure is not a confirmation
      }
      if (Date.now() + POLL_MS >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  /**
   * H-A (2026-08-31): the escrow-status half of S4's execution confirmation.
   *
   * ★ WHY THIS EXISTS. answer/decline/reclaim used to broadcast and then return
   * a PROJECTED ask (`status: 'answered', pending: true`) built from a read that
   * is necessarily PRE-execution. A silent on-chain refusal — a rejected
   * answerHash, a window that closed between the guard and the block, a state
   * the client did not model — was therefore indistinguishable from success:
   * the creator saw "answered", closed the dialog, and the delivery record
   * recorded a MISS they had no way to know about. An unearned miss is the
   * worst outcome this feature has, because it is permanent, public, and the
   * creator cannot tell it happened.
   *
   * Polls the escrow record until its status leaves PENDING, exactly as
   * awaitPaidUntilAdvance polls kPaidUntil, and with the same discipline: a
   * read failure inside the window counts as "not yet", NEVER as confirmed.
   * Returns the observed terminal status, or null on timeout.
   */
  /**
   * M-3's half of the execution confirmation: poll kRegisteredAt until it
   * ADVANCES past the pre-broadcast value. Same 90s/3s cadence and the same
   * "a read failure is not a confirmation" rule as awaitPaidUntilAdvance and
   * awaitEscrowStatus.
   *
   * `before === null` means the pre-read failed, so an advance cannot be
   * defined; it then accepts any non-zero value change, exactly as
   * awaitPaidUntilAdvance does in the same situation.
   */
  private async awaitRegisteredAdvance(creator: string, before: number | null): Promise<boolean> {
    const TIMEOUT_MS = REGISTER_CONFIRM_TIMEOUT_MS;
    const POLL_MS = 3_000;
    const key = kRegisteredAt(creator);
    const deadline = Date.now() + TIMEOUT_MS;
    let first: number | null = null;
    for (;;) {
      try {
        const state = await this.gql.getStateByKeys(this.config.contractId, [key]);
        const now = toU64(state[key]);
        if (before !== null ? now > before : first !== null && now !== first) return true;
        if (first === null) first = now;
      } catch {
        // not yet; a read failure is not a confirmation
      }
      if (Date.now() + POLL_MS >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  private async awaitEscrowStatus(creator: string, seq: number): Promise<ParsedEscrow['status'] | null> {
    const TIMEOUT_MS = ESCROW_CONFIRM_TIMEOUT_MS;
    const POLL_MS = 3_000;
    // kEscrow routes the account through toDid() itself (reads.ts:61 — "never
    // build a key from a raw account string directly"), so callers pass the
    // account as they have it, exactly like readOneAsk and readCreatorAsks.
    const key = kEscrow(creator, seq);
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      try {
        const state = await this.gql.getStateByKeys(this.config.contractId, [key]);
        const raw = state[key];
        const parsed = raw ? parseEscrow(raw) : null;
        if (parsed && parsed.status !== 'PENDING') return parsed.status;
      } catch {
        // not yet; a read failure is not a confirmation
      }
      if (Date.now() + POLL_MS >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  /**
   * ★★★ EXECUTION CONFIRMATION FOR THE MONEY-MOVING WRITES (2026-08-31, the
   * seventeen-unconfirmed-writes finding, clauderfly-57).
   *
   * register/renew confirm a STATE ADVANCE; answer/decline/reclaim confirm an
   * ESCROW STATUS. The remaining writes broadcast and then returned a
   * success-shaped value WITHOUT asking whether the CONTRACT executed. A
   * custom_json resolves at L1-accept, before L2 runs; on the HIVE-key rail the
   * broadcaster then hands back a tx id and checks nothing more
   * (broadcaster.ts), so a contract refusal — MEASURED as a real terminal
   * FAILED on a sell the chain rejected (57, main, 2026-08-31) — reached the
   * user as success. The BTC/EVM wallet rail already confirms (submit.ts
   * waitForInclusion) but only to INCLUDED, which the same measurement showed is
   * ~30s short of finality and can still flip to FAILED; polling here to a
   * TERMINAL status re-checks past that hole on EITHER rail.
   *
   * Polls findTransaction(byId) — the SAME query the wallet rail already runs
   * through the SAME /api/creator-tokens/submit proxy, so no new node surface is
   * opened and the two cannot drift — until the status is TERMINAL:
   *   CONFIRMED -> 'confirmed'  (executed AND final; 57 measured the state key
   *                              readable in the same sample, so a caller may
   *                              re-read the real post-state with no extra wait)
   *   FAILED    -> 'failed'     (sequenced and rejected at execution)
   *   otherwise -> keep polling. That "otherwise" INCLUDES the node's OWN
   *     `UNCONFIRMED` status (reported immediately on mempool acceptance) as
   *     well as INCLUDED / PENDING / no-row / a read failure — none is a
   *     verdict. ★ The node's `UNCONFIRMED` is NOT this feature's
   *     CREATOR_TOKENS_*_UNCONFIRMED error: the node means "accepted, not yet
   *     sequenced"; our error means "we gave up waiting for a terminal status".
   *     They must never be conflated by a reader of this code.
   *
   * ★★★ DOCUMENTED LIMITS (clauderfly-57 adversarial review, 2026-08-31) —
   * chosen, not missed:
   *  1. THE HIVE-RAIL TX ID MUST RESOLVE IN findTransaction, OR THIS IS A TOTAL
   *     HIVE-RAIL OUTAGE, not a graceful degrade. If the id
   *     hiveTransactionBroadcaster returns does not resolve, `status` is
   *     undefined every poll, nothing is terminal, and EVERY hive money-out —
   *     including the successful ones — waits the full window and returns
   *     'timeout'. It fails safe from FALSE SUCCESS (never says "done" wrongly)
   *     but NOT from a false UNCONFIRMED on a real success. A HARD pre-ship
   *     verification, not an after-the-fact one.
   *  2. IT WIDENS THE CROSS-TAB DOUBLE-SUBMIT WINDOW from ~2s (broadcast-accept)
   *     to the full window on every money path — exactly as renew's S4 note
   *     describes, and worse here: a duplicate BUY is a second purchase further
   *     up the curve, a duplicate ASK is a second escrow AND a second commission.
   *     The same-tab `inFlight` ref guards a double-click for the whole await;
   *     the residual is a SECOND TAB (its own ref), which also needs its own
   *     wallet signature. A cross-tab claim (like launch's LAUNCH_CLAIM_TTL_MS)
   *     would close it — flagged as a follow-up, not built here.
   *  3. ON THE WALLET RAIL THE CEILING IS ~270s, NOT 180s: broadcastWalletCall's
   *     own waitForInclusion polls up to 90s, then this polls up to 180s more.
   *     The happy path composes cleanly (~42s inclusion + ~30s to CONFIRMED); the
   *     270s is only a genuinely stuck or dropped tx.
   *  4. THE POLL BUDGET DEPENDS ON THE MAGI_GQL_PER_IP_PER_DAY CAP. Up to
   *     EXECUTION_CONFIRM_TIMEOUT_MS/POLL_MS (~60) status polls per money-out,
   *     where there were ZERO, sharing the 'ct-nonce' scope's `creator_tokens`
   *     bucket. Comfortable at the raised 200k cap; at the OLD 10k default it
   *     would refuse the confirmation polls themselves after ~166 money-outs/IP/
   *     day and report UNCONFIRMED on real successes. rate-limit.ts carries the
   *     matching note — do not restore the old default.
   */
  private async awaitExecution(txId: string): Promise<'confirmed' | 'failed' | 'timeout'> {
    const injected = this.txStatusReader;
    // The DEFAULT reader is a relative-path browser fetch, so an accidental
    // server-side call would throw, be caught below as "no verdict", and burn the
    // whole window. Guard that ONCE, up front, so it fails loudly (57 review #5)
    // — but ONLY for the default reader. A Node caller injects its own reader (a
    // selftest) and is exempt, which keeps the real sell()/refund() money math
    // end-to-end testable without a browser and the *_REFUSED branch testable at
    // all (43 + 57, 2026-09-01).
    if (!injected && typeof window === 'undefined') {
      throw new Error(
        'VscCreatorTokensDataSource: awaitExecution needs a browser or an injected txStatusReader (SUBMIT_PROXY_PATH is a relative proxy path)'
      );
    }
    const read = injected ?? defaultTxStatusReader;
    const POLL_MS = 3_000;
    // ★ Effective window is ~EXECUTION_CONFIRM_TIMEOUT_MS - POLL_MS: the check
    // below returns 'timeout' when the NEXT poll would cross the deadline, so the
    // final poll lands ~one interval early (57 review #5). Intentional, same
    // shape as the escrow/paidUntil helpers above.
    const deadline = Date.now() + EXECUTION_CONFIRM_TIMEOUT_MS;
    for (;;) {
      try {
        const status = await read(txId);
        if (status === 'CONFIRMED') return 'confirmed';
        if (status === 'FAILED') return 'failed';
        // INCLUDED / PENDING / node-UNCONFIRMED / null: not terminal.
      } catch {
        // a read or parse failure is not a verdict — keep waiting for one
      }
      if (Date.now() + POLL_MS >= deadline) return 'timeout';
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  private async readOneAsk(creator: string, seq: number): Promise<Ask> {
    const [state, head] = await Promise.all([this.gql.getStateByKeys(this.config.contractId, [kEscrow(creator, seq)]), this.gql.getHeadBlock()]);
    const raw = state[kEscrow(creator, seq)];
    const parsed = raw ? parseEscrow(raw) : null;
    if (!parsed) throw new Error(`VscCreatorTokensDataSource: no such escrow ${creator}:${seq}`);
    return buildAskFromParsed(creator, seq, parsed, head);
  }
}
