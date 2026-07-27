import env from '@beam-australia/react-env';
import type {
  Ask,
  AskInput,
  AnswerInput,
  BuyInput,
  BuyQuote,
  ClaimTradeFeesInput,
  CloseIfDrainedInput,
  DeliveryRecord,
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
  WithdrawTreasuryInput
} from '../types';
import { MockCreatorTokensDataSource } from './mock/mock-data-source';
import { hiveTransactionBroadcaster } from './vsc/broadcaster';
import { VscCreatorTokensDataSource } from './vsc-data-source';

// Protocol constants, money conversion and every ported piece of core/*.go's
// pure logic (phase derivation, curve math, exit tax, TWAP replication) live
// in ./contract-math — this file is deliberately just the interface + the
// mock/vsc selector, so a reviewer looking for "what does the UI/API boundary
// look like" never has to scroll past hundreds of lines of ported contract
// math to find it. See lib/contract-math.ts for that math and its line-by-line
// verification notes against /mnt/o/CREATOR-TOKENS/core/*.go.

// The swap boundary between the UI and creator-tokens data, mirroring
// features/prediction-market/lib/market-data-source.ts unchanged: no UI
// component ever imports MockCreatorTokensDataSource or
// VscCreatorTokensDataSource directly, only getCreatorTokensDataSource().
// This is what let the market UI be built and demoed before a contract
// existed (SPEC-CREATOR-KEYS.md §2.5/§2.7), and it applies unchanged here.

export interface CreatorTokensDataSource {
  // ---- reads. Failure contract (deliberately not uniform — see the report):
  // readMarket is the ONLY method that resolves phase 'UNKNOWN' on a failed
  // read, because it is the one field UI-BRIEF §2.2 mandates a dedicated,
  // actions-disabled chip for. Every other single-entity read REJECTS on a
  // genuine read failure (let the caller's query layer show its own
  // loading/error state — there is no honest optimistic value to resolve
  // with for a balance or an ask; useCreatorToken exposes readHolderPosition's
  // rejection as `isPositionError` so the holder view can say "balance
  // unavailable" rather than throwing). List-shaped, indexer-backed reads
  // (readWallet, readMyAsks) resolve to a DISCRIMINATED result carrying an
  // `unavailable` flag on failure — NOT a bare [], which would conflate
  // "couldn't load" with "genuinely nothing" (RULE: unavailable ≠ empty ≠
  // error). readDeliveryRecord likewise degrades to source:'unavailable'.
  // quoteBuy/quoteSell/readFeeBalance follow the single-entity REJECT
  // convention — same reasoning as readHolderPosition: there is no honest
  // optimistic number to resolve a price preview or a fee balance with. ----
  /** null = creator never registered a market (kRegisteredAt == 0). A Market with phase 'UNKNOWN' = the read itself failed — never conflate the two. */
  readMarket(creator: string): Promise<Market | null>;
  /** null = creator has no market at all. Rejects on a genuine read failure — a 0-balance resolve would be indistinguishable from "really holds nothing." Surfaced as isPositionError by useCreatorToken. */
  readHolderPosition(creator: string, holder: string): Promise<HolderPosition | null>;
  /** Cross-creator wallet view (UI-BRIEF Page 4). Indexer-backed; resolves { positions, unavailable } so the UI can tell "couldn't load" from "holds nothing". */
  readWallet(holder: string): Promise<WalletPositionsResult>;
  /** A creator's own escrow inbox (UI-BRIEF Page 6), directly chain-readable via kSeq + e|creator|i. Rejects on a genuine read failure. */
  readCreatorAsks(creator: string, opts?: { limit?: number }): Promise<Ask[]>;
  /** An asker's asks across every creator (UI-BRIEF Page 3). Indexer-backed; resolves { asks, unavailable } (same unavailable-vs-empty discriminator as readWallet). */
  readMyAsks(asker: string): Promise<MyAsksResult>;
  /** Answered-vs-missed history + response time. Not contract state (SPEC §1.7.1) — always indexer-backed; degrades to source:'unavailable'. */
  readDeliveryRecord(creator: string): Promise<DeliveryRecord>;
  /** Client-side preview of what Ask() would charge right now. Never authoritative — see Quote.asOfBlock doc. Rejects on a genuine read failure; a resolved oracleStatus other than 'ok' means AskRate()/SettlementRate() itself would refuse to price (RULING C: no PAR fallback any more — see Quote.rate's doc), so the caller must disable the ask action, not merely treat it as informational. */
  readQuote(creator: string): Promise<Quote>;
  /** tradefee.go kFeeBal(account) — the account's pull-claimable trade-fee balance (the 5% creator half of every trade fee, RULING F8), in HBD. Rejects on a genuine read failure — same reasoning as readHolderPosition, there is no honest 0-balance-shaped optimistic value. */
  readFeeBalance(account: string): Promise<number>;
  /** buy.go QuoteBuy — the read-only preview of Buy, sharing buyCompute with the real trade so the two can never disagree (RULING F: this quote is mandatory UI before signing). Rejects on a genuine read failure OR the same RequireInflowOpen refusal a real Buy would hit (e.g. market frozen/paused/retired, or cap exceeded) — the caller must disable the buy action on rejection, not merely surface an error toast. */
  quoteBuy(creator: string, tokens: number): Promise<BuyQuote>;
  /** sell.go QuoteSell — the read-only preview of Sell for `seller` (the exit-tax RATE is the seller's own hold clock, so the holder to preview is a required parameter, unlike quoteBuy). Rejects on a genuine read failure or the same rail-closed refusal a real Sell would hit (market winding down — use refund()/RefundInput instead in that state). */
  quoteSell(creator: string, seller: string, tokens: number): Promise<SellQuote>;

  // ---- writes: build + broadcast a signed custom_json op. Real
  // implementations throw until a broadcaster is injected (see
  // VscCreatorTokensDataSource) — same deferred-broadcaster convention as
  // VscMarketDataSource.placeBet/claim. ----
  registerMarket(input: RegisterMarketInput): Promise<Market>;
  renewSubscription(input: RenewSubscriptionInput): Promise<Market>;
  setFace(input: SetFaceInput): Promise<Market>;
  setCap(input: SetCapInput): Promise<Market>;
  /** buy.go Buy — mints input.tokens whole tokens to input.buyer at the exact curve cost. Replaces the deleted prepay()/core.Prepay (the PAR mint). */
  buy(input: BuyInput): Promise<HolderPosition>;
  /** sell.go Sell — redeems input.tokens of input.seller's balance at the exact curve slice, less the K2 exit tax and the 10% trade fee. The curve exit rail; see refund()/RefundInput for the wind-down rail. */
  sell(input: SellInput): Promise<HolderPosition>;
  /** market.go Retire — the creator's own irreversible wind-down trigger. Moves no funds; returns the market's new (still-optimistic) phase/retiredAtBlock. */
  retire(input: RetireInput): Promise<Market>;
  ask(input: AskInput): Promise<Ask>;
  answer(input: AnswerInput): Promise<Ask>;
  reclaim(input: ReclaimInput): Promise<Ask>;
  refund(input: RefundInput): Promise<HolderPosition>;
  refundHolder(input: RefundHolderInput): Promise<HolderPosition>;
  /** main.go `transfer` — moves input.tokens whole tokens from input.from to input.to. Renamed from transferCredits with the pivot. */
  transferTokens(input: TransferTokensInput): Promise<void>;
  /** tradefee.go ClaimTradeFees — pulls the caller's ENTIRE accrued trade-fee balance. Resolves the HBD amount actually claimed (0 if nothing was accrued — a harmless no-op, never a rejection). */
  claimTradeFees(input: ClaimTradeFeesInput): Promise<number>;
  /** refund.go CloseIfDrained — fully permissionless; flips a FROZEN, fully-drained market to terminal CLOSED. Resolves the contract's own idempotent boolean (true whenever the market ends up CLOSED, whether just now or already was). */
  closeIfDrained(input: CloseIfDrainedInput): Promise<boolean>;
  /** read.go WithdrawTreasury — owner-gated; the UI must keep this behind an owner-only surface (the contract also refuses a non-owner caller). Resolves the HBD amount actually withdrawn. */
  withdrawTreasury(input: WithdrawTreasuryInput): Promise<number>;
}

// =====================================================================
// Selector
// =====================================================================

export interface CreatorTokensConfig {
  contractId: string;
  netId: string;
  gqlUrl: string;
  indexerUrl?: string;
  rcLimit?: number;
}

function readEnv(key: string): string | undefined {
  const value = env(key);
  return value && value.length > 0 ? value : undefined;
}

/** Mirrors prediction-market/lib/market-config.ts's getMarketConfig() exactly, scoped to this feature's own env vars so the two features can be provisioned independently. */
export function getCreatorTokensConfig(): CreatorTokensConfig | null {
  const contractId = readEnv('CREATOR_TOKENS_CONTRACT_ID');
  const netId = readEnv('CREATOR_TOKENS_NET_ID');
  const gqlUrl = readEnv('CREATOR_TOKENS_GQL_URL');
  if (!contractId || !netId || !gqlUrl) return null;

  const rcLimitRaw = readEnv('CREATOR_TOKENS_RC_LIMIT');
  const parsedRcLimit = rcLimitRaw !== undefined ? Number(rcLimitRaw) : undefined;
  const rcLimit = parsedRcLimit !== undefined && Number.isFinite(parsedRcLimit) ? parsedRcLimit : undefined;

  return {
    contractId,
    netId,
    gqlUrl: gqlUrl.replace(/\/+$/, ''),
    indexerUrl: readEnv('CREATOR_TOKENS_INDEXER_URL')?.replace(/\/+$/, ''),
    rcLimit
  };
}

let instance: CreatorTokensDataSource | null = null;

/**
 * Real source once REACT_APP_CREATOR_TOKENS_* is provisioned, else the Mock
 * — an un-provisioned build behaves exactly as it does today (no contract
 * exists yet, SPEC §1 status).
 *
 * Finding C-B: `broadcaster` is now supplied — hiveTransactionBroadcaster
 * (./vsc/broadcaster.ts) — so every write actually signs and broadcasts
 * instead of throwing NO_BROADCASTER_MSG. This did NOT require breaking the
 * lazy-singleton pattern with a setter or a React context/provider: the
 * broadcaster is a plain function reference that reads the app's live
 * signing state (`transactionService`, a module-level singleton whose
 * signer is populated by <SignerProvider> mounted once at the app root)
 * fresh on every call, never anything captured at construction time — see
 * broadcaster.ts's own doc for the full trace of why this is safe
 * regardless of whether this singleton is created before or after the user
 * logs in.
 */
export function getCreatorTokensDataSource(): CreatorTokensDataSource {
  if (!instance) {
    const config = getCreatorTokensConfig();
    instance = config ? new VscCreatorTokensDataSource({ config, broadcaster: hiveTransactionBroadcaster }) : new MockCreatorTokensDataSource();
  }
  return instance;
}
