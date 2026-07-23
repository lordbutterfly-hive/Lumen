# core — the API every module codes against

Spec: `/mnt/o/CREATOR-KEYS-2026-07-20/SPEC-CREATOR-KEYS.md` §1. Foundation files (`store.go`, `keys.go`, `params.go`, `errors.go`, `money.go`, `util.go`) are written and **must not be edited** — if you need a new key or constant, add it there in a separate, clearly-marked block.

## Units — settled, do not reinterpret

- HBD carries 3 decimals: `1.000 HBD == 1000` base units.
- **PAR: 1 credit ⇔ 1 HBD base unit at issuance.** Prepay mints credits 1:1 with HBD paid. This is what "prepay at face" means mechanically.
- **`face`** is the creator's posted ask price **in HBD base units** — how much an answer costs.
- **`rate`** is HBD base units per credit (token). A higher rate means an ask consumes **fewer** credits — this is SPEC §1.3b, the whole point. **`rate` is never a caller-supplied parameter** (2026-07-20 fix): `Ask` derives it itself. **RULING C (2026-07-21) — the PAR fallback is DELETED**: `SettlementRate` (settlement.go) is now `min(TWAP_short, TWAP_long, SpotRate(supply))` and returns `(rate, error)`, REFUSING when no safe rate exists (young market, quiet market, >20% move, divergence tripwire). PAR was wrong by exactly the factor `spot`, always in the asker-robbing direction (a MinFace 0.1 HBD service cost 100 tokens where correct pricing costs 1). A refusal only ever blocks a NEW service inflow (Ask/Unlock/Book) — no outflow consults settlement.
- **Credits spent per ask** = `ceilDiv(face, rate)`; rounding favours the reserve. The caller instead supplies **`maxCredits`**, its own signed cap on that number — added the same day to close a SEPARATE manipulation surface `rate`'s fix does nothing for: `face` is creator-controlled (`SetFace`) and can move between an asker signing and a block producer placing their tx, since intra-block order is producer-chosen, not consensus-enforced. `maxCredits` plays the same role for the credits leg that `transfer.allow` already plays for every HBD leg in this codebase — see `ask.go`'s `Ask` doc for the attack.

## Invariants — asserted in tests, true after every call

- **I1 solvency:** `reserve(c) >= sum of all refunds payable at the current refund price`. A full unwind pays exactly the reserve, never more.
- **I2 refund ≤ par:** `refundPerCredit = min(reserve/supply, PAR)`. Nobody is refunded more than a credit ever cost at issuance.
- **I3 supply:** `supply(c) == Σ bal(c, holder) + credits currently escrowed`.
- **I4 monotone reserve:** the reserve only decreases via refund, or via an answer paying the creator. No admin path exists to it, in any state.
- **I5 no commission on refunds:** commission is charged on delivered service only. Mechanically: `Ask` HOLDS the commission in the escrow record; `Answer` books it to the treasury (delivered); `Reclaim` returns it to the asker in full, alongside the credits (SPEC §1.7.2 rule 4).
- **I6 ordering-immune:** answer and reclaim windows never overlap, so no in-block ordering can decide which wins.

## Function signatures — implement exactly these

```go
// market.go — identity, subscription, phase, pricing band  [AGENT 1]
// launch.go — free registration + the OPTIONAL atomic creator first buy
//
// REGISTRATION IS FREE (LOCKED-MECHANISM "Revenue", USER-RULED 2026-07-21):
// the feePaid parameter and the RegistrationFee constant are BOTH DELETED.
// The spam filter is the Hive account cost plus the identity binding.
//
// RULING D (RULINGS-v2, 2026-07-21) — THE FIVE-DAY RETIRE NOTICE, now built:
// Retire stores retiredAt = block (a HEIGHT) and Phase derives
//     phase = MAX(naturalPhase, retiredPhase)   on ACTIVE<OVERDUE<FROZEN<CLOSED
//     retiredPhase = block < retiredAt+GraceBlocks ? OVERDUE : FROZEN
// The MAX is load-bearing: retiring may only ever make a market MORE frozen,
// which preserves the whole DEFECT-1 fix (no un-freeze, no subscription
// dodge) with no height subtraction to underflow. The notice exists because
// an INSTANT freeze was measured as the creator-whale's escape hatch around
// the exit tax (untaxed pro-rata wind-down 205.53 HBD vs taxed curve exit
// 180.62 HBD) — it is a hard prerequisite for RULING J's tax, not a courtesy.
// Retire is ONCE-ONLY (a re-arm would move the notice forward and could
// un-freeze); Renew is refused outright once retired; Register clears the
// mark so a returning creator starts fresh.
func Register(s Store, caller, creator string, block uint64, face, cap int64) error
func RegisterWithFirstBuy(s Store, caller, creator string, block uint64, face, cap int64, firstBuy *big.Int) (*RegisterResult, error)
// firstBuy is OPTIONAL (nil/0 == plain registration). When > 0 it executes an
// ORDINARY core.Buy of that many tokens by the creator, at FULL curve cost
// plus the full 10% trade fee, in the SAME state transition — zero premine,
// no discount. It is un-front-runnable STRUCTURALLY (Buy needs
// kRegisteredAt != 0 and Register needs caller == creator, so no state exists
// where the market is live and the creator's slice is not yet taken), which
// matters because intra-block order is producer-chosen. It is NOT an
// anti-snipe device and must never be described as one: it is optional, so at
// n == 0 a bot takes the bottom outright. BasePrice does the anti-snipe work.
// Register ALSO clears every per-incarnation key on re-registration:
// kObsIdx, kFaceAnchor/kFaceAnchorAt (H4), the retire mark, and — new
// 2026-07-21, a FALSE claim in keys.go until now — kUnlockPrice/kSessionPrice
// with all four band keys each. It REFUSES (never clears) re-registration
// while kReserve or kSupply is non-zero: clearing them would be an admin path
// to a market's reserve (I4) and would destroy real HBD.
func Renew(s Store, caller, creator string, block uint64, periods uint64, paid *big.Int) error
func SetFace(s Store, caller, creator string, block uint64, newFace int64) error
func SetCap(s Store, caller, creator string, block uint64, newCap int64) error
func Phase(s Store, creator string, block uint64) string        // ACTIVE|OVERDUE|FROZEN|CLOSED, derived LAZILY, never stored as truth
func RequireInflowOpen(s Store, creator string, block uint64) error // ACTIVE or OVERDUE only
func Retire(s Store, caller, creator string, block uint64) error // creator-only, ONCE-ONLY; starts the 5-day notice (OVERDUE) then FROZEN; no fund movement, paidUntil untouched
func RetiredAt(s Store, creator string) (uint64, bool)           // the notice, made observable: (retire block, true) or (0, false)

// prepay.go — issuance and holder transfer  [AGENT 2]
func Prepay(s Store, caller, creator string, block uint64, hbdPaid *big.Int) (*big.Int, error) // returns credits minted
func TransferCredits(s Store, creator, from, to string, amount *big.Int) error

// ask.go — escrowed asks  [AGENT 3]
// SIGNATURES BELOW UPDATED 2026-07-20 (two CRITICAL fixes): Ask no longer
// takes `rate` — it derives its own settlement rate internally
// (SettlementRate: TWAP-or-PAR; see ask.go's doc for why and the honest
// switchover risk) — and instead takes `maxCredits`, the asker's own
// signed slippage cap against a creator-controlled `face` spike. Reclaim
// now returns the held commission too, not just credits (SPEC §1.7.2 rule
// 4 / I5 — commission is HELD in escrow by Ask, booked by Answer, returned
// in full by Reclaim; core never moves HBD itself, so the wasm wrapper is
// responsible for actually paying ReclaimResult.CommissionHbd back via
// sdk.HiveTransfer, state-mutate-then-transfer / CEI).
//
// UPDATED AGAIN 2026-07-21 — three fixes:
//   - H1: Reclaim is now PERMISSIONLESS once the reclaim window is open
//     (block > deadline+ReclaimGrace) — `caller` is checked non-empty only
//     and can never be paid; the payout ALWAYS lands on the escrow's own
//     `rec.asker`, now exposed as ReclaimResult.Asker so the wrapper knows
//     who to actually pay. Before this fix, an abandoned PENDING escrow
//     (asker never reclaims) permanently pinned supply>0 and bricked the
//     creator's market forever — CloseIfDrained needs supply==0, and
//     Register's duplicate-registration guard needs CLOSED.
//   - H2: `commissionHbdPaid` must now EXACTLY equal
//     `commissionOwedFor(face)` at execution — not merely be >= it. A
//     band-legal SetFace drop between an asker's quote and this call's
//     execution used to let the asker overpay the commission (up to 4x),
//     which got HELD in full and booked to the treasury in full on Answer.
//     The wrapper must draw only the exact owed amount, bounded by the
//     asker's own signed transfer.allow cap.
//   - AnswerResult gained CommissionHbd (at the indexer agent's request,
//     mirroring ReclaimResult.CommissionHbd): Answer already books
//     rec.commissionHbd to kTreasury(); this exposes that exact amount so
//     the wrapper can pass it into EvAnswered for the indexer's money-model
//     reconstruction.
type AskResult struct { Seq uint64; CreditsSpent *big.Int; CommissionHbd *big.Int; RateUsed *big.Int }
type AnswerResult struct { CreditsToCreator *big.Int; CommissionHbd *big.Int }
type ReclaimResult struct { CreditsReturned *big.Int; CommissionHbd *big.Int; Asker string }
func Ask(s Store, caller, creator string, block uint64, maxCredits *big.Int, commissionHbdPaid *big.Int, contentHash string, deadlineBlocks uint64) (*AskResult, error) // commissionHbdPaid must EXACTLY equal commissionOwedFor(face) at execution (H2)
func Answer(s Store, caller, creator string, block, seq uint64, answerHash string) (*AnswerResult, error)
func Reclaim(s Store, caller, creator string, block, seq uint64) (*ReclaimResult, error) // PERMISSIONLESS once window open (H1); always pays ReclaimResult.Asker, never caller

// settlement.go — the service settlement derivation  [RULING C, 2026-07-21]
// Shared VERBATIM by Ask, Unlock and Book (RULING C3). SettlementRate MOVED
// here from ask.go and CHANGED SHAPE: (rate, error), no PAR fallback — it
// REFUSES (typed error) when it cannot price safely. rate =
// min(AskRate short window, 7-day long window, SpotRate(supply)) + the C5
// divergence tripwire; SettleSpend adds the C4 minimum-price guard
// (face·2 >= rate), the C2 depth ceiling (face <= 50% of Area(supply) — the
// AREA, never the reserve), ceil(face/rate) for the count, and the 5%-of-
// supply spend cap. Refusal gates NO funds: only the three service INFLOWS
// call this.
type SettleQuote struct { Credits *big.Int; Rate *big.Int }
func SettlementRate(s Store, creator string, block uint64) (*big.Int, error)
func SettleSpend(s Store, creator string, block uint64, face *big.Int) (*SettleQuote, error) // the wrapper `quote` preview — same code the fund paths bind

// refund.go — floor, wind-down, permissionless push  [AGENT 4]
// RefundHolder UPDATED 2026-07-21 (H3 fix): now requires
// Phase(creator, block) == FROZEN or CLOSED — the only phases wind-down
// refunds are intended for. Before this fix it worked in EVERY phase, so
// any third party could force-liquidate any other holder's live ACTIVE-
// market position at will, with zero consent. Self-`Refund` is completely
// UNAFFECTED by this fix and remains state-blind in every phase, exactly
// as before — this gates the PUSH, never the PULL.
func RefundPrice(s Store, creator string) *big.Int                 // HBD per credit = min(reserve/supply, PAR)
func Refund(s Store, caller, creator string, block uint64, credits *big.Int) (*big.Int, error)
func RefundHolder(s Store, caller, creator, holder string, block uint64) (*big.Int, error) // pays HOLDER, never caller; Phase must be FROZEN/CLOSED (H3)
func CloseIfDrained(s Store, creator string, block uint64) bool

// read.go — exported accessors, PLUS one mutator [shared / global keys]
// WithdrawTreasury ADDED 2026-07-21 (C2 fix): kTreasury had NO exit
// anywhere in the package — Register's registration fee, Renew's
// subscription fee, and Ask/Answer's commission leg all credited it, with
// 100% of protocol revenue permanently locked as a result. Owner-gated
// (Owner(s), prepay.go), bounded to (0, current treasury balance]. No path
// to any market's reserve. Core never moves HBD — the wrapper pays the
// owner via sdk.HiveTransfer after this call mutates state (CEI).
func WithdrawTreasury(s Store, caller string, amount *big.Int) (*big.Int, error)
// CommissionOwedFor ADDED 2026-07-21 (DEFECT 5 fix): the EXACT HBD commission
// owed on one ask against `face` — floor(face*CommissionBps/10000), delegating
// to ask.go's own commissionOwedFor. Exported so the wasm wrapper's ask/quote
// stop hand-copying the formula: core.Ask (H2) requires commissionHbdPaid to
// EXACTLY equal it, so any drift would brick every ask.
func CommissionOwedFor(face *big.Int) *big.Int

// twap.go — price observations  [AGENT 5]
// RULING C1 (2026-07-21): RecordObs now feeds TWO rings — the short ring
// (one obs per block max, as before) and a LONG ring sampled at most once
// per LongObsSpacing (6300) blocks so 32 slots span 7 days. The trade path
// feeds it: core.Buy and core.Sell call RecordObs with the curve's marginal
// rate (the curve IS the price source). The long window read (askRateLong)
// is package-private — it is only ever one arm of settlement's min().
func RecordObs(s Store, creator string, block uint64, rate *big.Int)
func AskRate(s Store, creator string, block uint64) (*big.Int, error) // short-window TWAP, never spot; errors if too few/too recent obs
```

## Rules that bind every module

1. **No scheduler exists.** Every time-based transition is computed lazily inside the call that needs it. Nothing may assume a keeper ran.
2. **Payouts are pull-based**, except `RefundHolder` (pushable by anyone but **only ever pays the holder**, never the caller — and, as of the H3 fix 2026-07-21, only once Phase is FROZEN or CLOSED) and `Reclaim` (as of the H1 fix 2026-07-21, pushable by anyone once the reclaim window is open, but **only ever pays the escrow's own asker**, never the caller).
3. **Outflows never pause.** A global or per-market pause blocks inflows only. Refund, reclaim and answer must work in every state where funds are owed.
4. **The billing state must never gate a holder's OWN exit.** `Phase` may block new asks and new prepay. It may not block self-`Refund`, `Reclaim`, transfer of already-owned credits, or answering an outstanding ask. `RefundHolder` is the one deliberate exception (H3, 2026-07-21): it gates the PUSH — a THIRD PARTY forcing someone else's exit — to FROZEN/CLOSED only, since that is a different question from whether the holder can exit on their own terms (rule 2 above still guarantees they always can, via self-`Refund`).
5. **Rounding always favours the reserve** — `mMulDivCeil` for what a payer owes, `mMulDiv` for what a payee receives.
6. Every exported function returns `*Err` (via `newErr`) — never a bare `errors.New`.
7. Write a `_test.go` beside your file covering the happy path, every guard, and the invariants your module can break.
