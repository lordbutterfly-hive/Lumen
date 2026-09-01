import env from '@beam-australia/react-env';
import type { AnswerInput, Ask, AskInput, BuyInput, BuyQuote, ClaimTradeFeesInput, CloseIfDrainedInput, ContractRules, CreateOfferingInput, CreatorAsksResult, CreatorSummary, DeclineInput, DeleteOfferingInput, DeliveryRecord, HolderPosition, IndexerHealth, Market, MarketPrice, MyAsksResult, Offering, PricePoint, Quote, RateInput, ReclaimInput, RefundHolderInput, RefundInput, RegisterMarketInput, RenewSubscriptionInput, RetireInput, SellInput, SellQuote, SetCapInput, SetFaceInput, SetOfferingPriceInput, SetOfferingTitleInput, TransferTokensInput, WalletPositionsResult, WithdrawTreasuryInput } from '../types';
import { MockCreatorTokensDataSource } from './mock/mock-data-source';
import { hiveTransactionBroadcaster } from './vsc/broadcaster';
import { routingBroadcaster } from './vsc/wallet-broadcaster';
import { signMessageWith, signTypedDataWith } from '@/blog/features/lite-auth/wallet/appkit';
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

  /**
   * The chain's live contract rule set (v1/v2), independent of any market. The
   * concrete source reads the deployed bytecode's CID and maps it via
   * rulesForCode; readMarket embeds the same answer as `market.rules`, but the
   * launch flow needs it BEFORE a market exists (to gate the wind-down copy on
   * step 3). Defaults v1 on any failure, the safe direction (contract-rules.ts).
   */
  readRules(): Promise<ContractRules>;

  /**
   * Does this HIVE account exist on the configured Hive node? true / false, or
   * null when it cannot be checked (no node configured, or the lookup failed).
   * A send UI must verify a hive destination before signing, because the
   * transfer contract CREDITS a well-formed but NONEXISTENT hive account
   * (shape-only at both contract layers, deliberately), so a typo is a
   * permanent, unrecoverable send. did:pkh has no registry, so shape is all
   * there is for those and this is not called for them.
   */
  hiveAccountExists(name: string): Promise<boolean | null>;
  /** null = creator has no market at all. Rejects on a genuine read failure — a 0-balance resolve would be indistinguishable from "really holds nothing." Surfaced as isPositionError by useCreatorToken. */
  readHolderPosition(creator: string, holder: string): Promise<HolderPosition | null>;
  /** Cross-creator wallet view (UI-BRIEF Page 4). Indexer-backed; resolves { positions, unavailable } so the UI can tell "couldn't load" from "holds nothing". */
  readWallet(holder: string): Promise<WalletPositionsResult>;
  /** A creator's own escrow inbox (UI-BRIEF Page 6), directly chain-readable via kSeq + e|creator|i. Rejects on a genuine read failure. */
  readCreatorAsks(creator: string): Promise<CreatorAsksResult>;
  /** An asker's asks across every creator (UI-BRIEF Page 3). Indexer-backed; resolves { asks, unavailable } (same unavailable-vs-empty discriminator as readWallet). */
  readMyAsks(asker: string): Promise<MyAsksResult>;
  /** Answered-vs-missed history + response time. Not contract state (SPEC §1.7.1) — always indexer-backed; degrades to source:'unavailable'. */
  readDeliveryRecord(creator: string): Promise<DeliveryRecord>;
  /**
   * Client-side preview of what Ask() would charge right now. Never authoritative — see Quote.asOfBlock doc. Rejects on a genuine read failure; a resolved oracleStatus other than 'ok' means AskRate()/SettlementRate() itself would refuse to price (RULING C: no PAR fallback any more — see Quote.rate's doc), so the caller must disable the ask action, not merely treat it as informational.
   *
   * `offeringId` (F4 fix, 2026-08-19): widened from `readQuote(creator)` so a
   * caller can re-quote the SAME offering an ask will name before signing —
   * see the doc on this method in vsc-data-source.ts, whose own ask() write
   * already did this internally. Optional and additive; existing callers
   * that only want the legacy face price are unaffected.
   */
  readQuote(creator: string, offeringId?: number): Promise<Quote>;
  /** tradefee.go kFeeBal(account) — the account's pull-claimable trade-fee balance (the 5% creator half of every trade fee, RULING F8), in HBD. Rejects on a genuine read failure — same reasoning as readHolderPosition, there is no honest 0-balance-shaped optimistic value. */
  readFeeBalance(account: string): Promise<number>;
  /** buy.go QuoteBuy — the read-only preview of Buy, sharing buyCompute with the real trade so the two can never disagree (RULING F: this quote is mandatory UI before signing). Rejects on a genuine read failure OR the same RequireInflowOpen refusal a real Buy would hit (e.g. market frozen/paused/retired, or cap exceeded) — the caller must disable the buy action on rejection, not merely surface an error toast. */
  quoteBuy(creator: string, tokens: number): Promise<BuyQuote>;
  /** sell.go QuoteSell — the read-only preview of Sell for `seller` (the exit-tax RATE is the seller's own hold clock, so the holder to preview is a required parameter, unlike quoteBuy). Rejects on a genuine read failure or the same rail-closed refusal a real Sell would hit (market winding down — use refund()/RefundInput instead in that state). */
  quoteSell(creator: string, seller: string, tokens: number): Promise<SellQuote>;
  /**
   * offerings.go ListOfferings — the creator's posted shop. Resolves [] for a
   * creator with no offerings; REJECTS on a genuine read failure, following the
   * single-entity convention (an empty shop and an unreadable one must never
   * render the same, or a UI shows "no services" during an outage and the
   * creator looks closed for business).
   */
  listOfferings(creator: string): Promise<Offering[]>;
  /**
   * The ranked creator list (indexer view `lumen_ct_discovery`, ordered on
   * DELIVERY in SQL). REJECTS when the indexer is unreachable — an empty list
   * would read as "nobody has launched a token", which is a very different
   * claim from "we couldn't look".
   */
  readDiscovery(limit?: number): Promise<CreatorSummary[]>;
  /**
   * How far the indexer is behind the node. NEVER rejects: a lag read that
   * throws would take down the screen it exists to annotate, so an unreachable
   * or unconfigured indexer resolves `{ available: false }` and the UI says
   * "cannot tell" rather than "up to date". See `IndexerHealth` for why the lag
   * is measured in blocks and not against the viewer's clock.
   */
  readIndexerHealth(): Promise<IndexerHealth>;
  /** A token's price history (indexer view `lumen_ct_price_history`). Rejects when unavailable — a flat or empty chart would be a claim about the price. */
  readPriceHistory(creator: string, limit?: number): Promise<PricePoint[]>;

  // ---- writes: build + broadcast a signed custom_json op. Real
  // implementations throw until a broadcaster is injected (see
  // VscCreatorTokensDataSource) — same deferred-broadcaster convention as
  // VscMarketDataSource.placeBet/claim. ----
  registerMarket(input: RegisterMarketInput): Promise<Market>;
  renewSubscription(input: RenewSubscriptionInput): Promise<Market>;
  setFace(input: SetFaceInput): Promise<Market>;
  setCap(input: SetCapInput): Promise<Market>;
  /** buy.go Buy — mints input.tokens whole tokens to input.buyer at the exact curve cost. Replaces the deleted prepay()/core.Prepay (the PAR mint). */
  /** Spot prices for many creators in as few requests as possible — the feed-chip read. Every requested handle gets an entry, so "no market" and "not answered" stay distinguishable. */
  readMarketPrices(creators: readonly string[]): Promise<Map<string, MarketPrice>>;
  buy(input: BuyInput): Promise<HolderPosition>;
  /** sell.go Sell — redeems input.tokens of input.seller's balance at the exact curve slice, less the K2 exit tax and the 10% trade fee. The curve exit rail; see refund()/RefundInput for the wind-down rail. */
  sell(input: SellInput): Promise<HolderPosition>;
  /** market.go Retire — the creator's own irreversible wind-down trigger. Moves no funds; returns the market's new (still-optimistic) phase/retiredAtBlock. */
  retire(input: RetireInput): Promise<Market>;
  ask(input: AskInput): Promise<Ask>;
  answer(input: AnswerInput): Promise<Ask>;
  /** rating.go Rate — the buyer's 1-5 score for a delivered job. Reputation only; it can never move money. Rejects if the caller didn't pay for the job, if it wasn't delivered, or if it was already rated. */
  rate(input: RateInput): Promise<void>;
  /** ask.go Decline — the creator's free "no": full refund INCLUDING the commission, inside the same window an Answer is legal in, and not a miss. A studio that offers Answer without this is pushing creators to take a black mark for work they cannot do. */
  decline(input: DeclineInput): Promise<Ask>;
  reclaim(input: ReclaimInput): Promise<Ask>;
  refund(input: RefundInput): Promise<HolderPosition>;
  refundHolder(input: RefundHolderInput): Promise<HolderPosition>;
  /** main.go `transfer` — moves input.tokens whole tokens from input.from to input.to. Renamed from transferCredits with the pivot. */
  transferTokens(input: TransferTokensInput): Promise<void>;
  /** tradefee.go ClaimTradeFees — pulls the caller's ENTIRE accrued trade-fee balance. Resolves the HBD amount actually claimed (0 if nothing was accrued — a harmless no-op, never a rejection). */
  claimTradeFees(input: ClaimTradeFeesInput): Promise<number>;
  /** refund.go CloseIfDrained — fully permissionless; flips a FROZEN, fully-drained market to terminal CLOSED. Resolves the contract's own idempotent boolean (true whenever the market ends up CLOSED, whether just now or already was). */
  closeIfDrained(input: CloseIfDrainedInput): Promise<boolean>;
  // ---- the offerings shop (creator-only; the caller IS the creator) ----
  /** offerings.go CreateOffering — posts a new named service. Resolves the created offering (id assigned on-chain, so it is optimistic and flagged by the caller re-reading). */
  createOffering(input: CreateOfferingInput): Promise<void>;
  /** offerings.go SetOfferingPrice — bounded by the offering's TITLE-anchored 2x/7d band; a rename or a delete-and-recreate does not reset it. */
  setOfferingPrice(input: SetOfferingPriceInput): Promise<void>;
  /** offerings.go SetOfferingTitle — renaming ONTO another live offering's title is refused on-chain (it would launder that title's price band). */
  setOfferingTitle(input: SetOfferingTitleInput): Promise<void>;
  /** offerings.go DeleteOffering — delists only; escrows already asked against this offering are untouched. */
  deleteOffering(input: DeleteOfferingInput): Promise<void>;
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
  /**
   * The Hive L1 this feature's WRITES must be broadcast to. Set both, or
   * neither — see lib/vsc/hive-chain.ts for why writes were previously landing
   * on a different network from the one the contract lives on.
   */
  hiveApi?: string;
  hiveChainId?: string;
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
    rcLimit,
    hiveApi: readEnv('CREATOR_TOKENS_HIVE_API')?.replace(/\/+$/, ''),
    hiveChainId: readEnv('CREATOR_TOKENS_HIVE_CHAIN_ID')
  };
}

/**
 * Local-development ONLY escape hatch, mirroring prediction-market's
 * isMarketDemoEnabled() exactly. When no contract is provisioned
 * (getCreatorTokensConfig() === null) AND REACT_APP_CREATOR_TOKENS_DEMO=1,
 * getCreatorTokensDataSource() serves the in-memory Mock so the UI can be
 * built without a deployed contract.
 *
 * IT MUST NEVER BE SET ON A PRODUCTION BUILD. The Mock serves fabricated
 * markets, balances and prices; a user acting on them would be spending real
 * intent against numbers nobody owes them. The default un-provisioned state is
 * honest-unavailable, not a silently fake market.
 *
 * WHY THIS EXISTS AT ALL (gap list, 2026-07-28): the previous selector fell
 * back to the Mock whenever the env was missing — and the env is set NOWHERE
 * in this repo, no .env, no compose file, no Dockerfile. So every build, in
 * every environment, served the Mock, and nothing anywhere said so. That is
 * how a whole feature can look finished and be connected to nothing.
 */
export function isCreatorTokensDemoEnabled(): boolean {
  // ★ FAIL-SAFE (2026-08-01): the flag is INERT in production, whatever the env
  // says. Both comments above warn "must never be set on a production build" —
  // a warning is not a control. The flag is set by a human on a deploy target,
  // which is exactly the kind of thing that gets copied into the wrong
  // environment, so production refuses it here instead of trusting the warning.
  if (process.env.NODE_ENV === 'production') return false;
  return readEnv('CREATOR_TOKENS_DEMO') === '1';
}

let instance: CreatorTokensDataSource | null = null;

/**
 * Real source once REACT_APP_CREATOR_TOKENS_* is provisioned; the Mock ONLY
 * behind the dev demo flag; otherwise **null** — the feature is unavailable and
 * callers must say so rather than render fabricated numbers.
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
export function getCreatorTokensDataSource(): CreatorTokensDataSource | null {
  if (!instance) {
    const config = getCreatorTokensConfig();
    if (config) {
      // ★ ROUTED, not replaced (2026-08-20). `required_auths[0]` decides the
      // rail: a `hive:` account signs a Hive custom_json exactly as before, and
      // a `did:pkh:eip155` identity signs a native Magi container with its EVM
      // wallet. Routing HERE rather than at each call site means all 24 write
      // actions gained the wallet rail at once, through the same `buildOp` that
      // already enforces the payload and auth contracts. A Hive user's path is
      // byte-identical to what it was before this line changed.
      instance = new VscCreatorTokensDataSource({
        config,
        broadcaster: routingBroadcaster(
          hiveTransactionBroadcaster,
          signTypedDataWith,
          // BTC signs a plain message (the container CID), which is exactly what
          // the existing login/bind signer already does — same wallet, same
          // provider call, different message. Bound to the 'btc' chain here so
          // the broadcaster never has to know which chains exist.
          (address, message) => signMessageWith('btc', address, message)
        )
      });
    } else if (isCreatorTokensDemoEnabled()) {
      instance = new MockCreatorTokensDataSource();
    } else {
      // Deliberately NOT cached: a null here means "not provisioned", and the
      // next call should re-read the env rather than pin the unavailable
      // verdict for the lifetime of the process.
      return null;
    }
  }
  return instance;
}
