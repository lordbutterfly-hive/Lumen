package core

// Protocol constants. Every settable parameter has a hard cap AND a floor in
// code — friend.tech's had neither (setProtocolFeePercent accepted any value),
// and that is finding #5 of our own teardown.
//
// Block time on Magi is ~3s, so 1 day ≈ 28,800 blocks.

const BlocksPerDay uint64 = 28800

// ---- revenue (SPEC §1.7, ruled by the user 2026-07-20) ----

// CommissionBps is taken from every payment that reaches a creator. 12%.
// Charged ONLY on delivered service — never on a refund.
const CommissionBps uint64 = 1200

// THERE IS NO MaxCommissionBps. It existed as `const MaxCommissionBps uint64 =
// 2000`, documented as bounding "any future governance change to the
// commission" — and it bounded nothing, because CommissionBps above is a
// compile-time const with no setter anywhere in the contract. There is no
// governance path to cap.
//
// DELETED rather than left in place for exactly the reason this file gives for
// deleting RegistrationFee below: a named, exported protocol parameter that
// nothing enforces is a dead safety parameter — it reads as a protection that
// is not there, and it is the class that gets wired up by accident later. If a
// commission setter is ever added, the cap gets added WITH it, enforced at the
// setter, and tested there.

// REGISTRATION IS FREE — there is deliberately NO RegistrationFee constant.
// USER-RULED (LOCKED-MECHANISM "Revenue", 2026-07-21), reversing SPEC §1.4's
// registration bond.
//
// WHAT WAS HERE AND WHY IT IS GONE: `const RegistrationFee int64 = 10_000`
// (10.000 HBD), enforced by market.go's Register as `feePaid >=
// RegistrationFee` and booked to the treasury. The ruling is that the spam
// filter is the Hive account-creation cost (~3 HIVE + RC) plus the
// one-market-per-account identity binding Register already enforces — which
// is strictly stronger than a $10 bond, because it does not disappear when
// the bond is waived. Residual junk (a market visible during its free first
// month) is contained by discovery ranking, not by a fee.
//
// The constant is DELETED rather than kept at 0 or kept unused: a named,
// exported protocol parameter that nothing enforces is a dead safety
// parameter — the exact class of defect that gets re-wired by accident
// later, and the class an audit is supposed to find. Registration cannot
// charge anything if there is nothing to charge.
//
// Revenue is unchanged and lives elsewhere: SubscriptionFee (below, the
// liveness gate — the FIRST month is free, so creating is genuinely free),
// CommissionBps (12% on delivered service) and TradeFeeBps (the 5% platform
// half of the 10% trade fee).

// SubscriptionFee is the recurring charge, in HBD base units, per period.
const SubscriptionFee int64 = 10_000

// SubscriptionPeriod is one month.
const SubscriptionPeriod uint64 = 30 * BlocksPerDay

// MaxPrepaidPeriods caps how far ahead a creator may pay, so a lapsed market
// can never be resurrected from an ancient prepayment.
const MaxPrepaidPeriods uint64 = 12

// ---- the lapse ladder (SPEC §1.7.5) ----

// GraceBlocks is the fully-functional warning window after the subscription
// lapses. 5 days. Nothing changes functionally until it expires.
const GraceBlocks uint64 = 5 * BlocksPerDay

// ---- ask pricing band (SPEC §1.3b) ----

// FaceBandBps caps a face-price change to 2x (up or down) ...
const FaceBandNumerator uint64 = 2

// ... per FaceBandWindow.
const FaceBandWindow uint64 = 7 * BlocksPerDay

// MinFace / MaxFace bound the posted ask price in HBD base units. A face below
// MinFace would let rounding degenerate; above MaxFace is a fat-finger guard.
// The same [MinFace, MaxFace] range and the same FaceBand (2x/7d) bound the
// creator shop's per-offering prices (offerings.go) — one bound, one band, so
// the anti-rug guarantee is identical across every priced offering.
//
// ★ SET-2 FIX (adversarial fix round 1, 2026-07-22) — MinFace was 100
// (0.100 HBD) and that CONTRADICTED a compiled guard: RULING C4's
// minimum-price rule refuses any face below half of one token
// (`face·2 >= rate`), and the settlement rate can never fall below
// BasePrice (1000) because every arm of min(TWAP_short, TWAP_long, spot) is
// an average of curve prices and price(i) >= BasePrice for every i. So every
// face in [100, 499] was PERMANENTLY UNSETTLEABLE while Register and SetFace
// happily accepted it — a creator could post a documented-minimum price,
// see it accepted, and then have every single Ask refuse, with
// recovery throttled to 2x per 7 days (three windows, 21 days, from 100).
// A configuration error must fail at the configuration call, not silently at
// the revenue call.
//
// MinFace is pinned to the GLOBAL-MINIMUM reachable C4 settle floor. SET-2
// used ceil(BasePrice/2)=500 (the floor at S==0/1), but LIVE-1 (PRUNED
// 2026-07-22) proved S==0/1 cannot settle any service at all: the first
// settleable supply is S==2, where the C4 floor lo=ceil(SpotRate(2)/2)=508.
// So every posted face in [500,507] was DEAD-ON-ARRIVAL — unsettleable at
// EVERY reachable supply, not merely "after appreciation". MinFace is
// therefore 508, the exact floor at the cheapest settleable market. It still
// clears SET-2's invariant (508*2=1016 >= BasePrice=1000), which
// TestSettlement_SET2_MinFaceClearsC4Floor asserts so the two constants can
// never drift apart again. NOTE this fixes only the DEAD-ON-ARRIVAL floor:
// the C4 floor RISES with the token price (it is half a token, and the token
// price is quadratic in supply), so a face legal at launch can still go dead
// as the market appreciates — see settlement.go's ServiceFaceRange, which
// exports the live window, and the honest product limit recorded there.
// MinFace is a POSTED price, and only 100%-CommissionBps of a posted price
// reaches the token leg the C4 floor actually measures (splitFace, ask.go —
// USER RULING 2026-07-27). 508 was the reachable C4 floor at S==2 in token-leg
// terms; grossed up it is 577, the smallest posted face whose token leg still
// clears it (577-floor(577*1200/10000) = 577-69 = 508; 576 gives 507 and is
// therefore dead on arrival). TestSettlement_SET2_MinFaceClearsC4Floor pins
// the two together so they can never drift apart again.
const MinFace int64 = 577        // LIVE-1 (PRUNED 2026-07-22) grossed up for the commission carve-out (2026-07-27)
const MaxFace int64 = 10_000_000 // 10,000.000 HBD

// THERE IS NO MinTip, and there is no tip.go. `const MinTip int64 = 100`
// used to sit here, documented as bounding "a tip below which rounding
// degenerates ... carries only this dust floor and the fixed MaxFace ceiling
// (tip.go)" — and it bounded nothing: no Tip function, no tip entrypoint, no
// tip.go file, and no other reference to MinTip anywhere in this repository
// (core, contract, cmd, keeper, indexer, or sim) ever existed alongside it.
// Whatever tipping feature this was written for was never built, or was
// removed before this constant was, and nobody deleted the constant with it.
//
// DELETED for exactly the reason this file deletes every other unenforced
// parameter (see MaxCommissionBps and RegistrationFee above): a named,
// exported protocol constant that nothing enforces is a dead safety
// parameter — it reads as a protection that is there when it is not, and it
// is the class of defect that gets wired up by accident later, or worse,
// relied upon by a caller who assumes it is already checked somewhere. If a
// tip mechanism is ever built, its own floor gets added WITH it, enforced at
// the call site that spends it, and tested there — not resurrected from a
// constant that spent its whole life unread.

// ---- offering catalogue ----

// MaxOfferings bounds how many LIVE named offerings one creator may post at a
// time (offerings.go). Two reasons, both structural rather than cosmetic: an
// unbounded catalogue is an unbounded read for any client rendering the shop
// (the batch-size bound every array-taking surface in this codebase carries),
// and the cap is what makes DeleteOffering's slot accounting meaningful. It
// bounds LIVE offerings, never ids ever issued — ids are monotone by design
// (keys.go), so a creator may churn through as many as they are willing to pay
// Hive transaction fees for, holding at most this many at once.
const MaxOfferings uint64 = 20

// MaxOfferTitleLen bounds the display label. A title is free-form buyer-facing
// text, so it is length-capped and "|"-rejected at the door for the same reason
// contentHash is (ask.go): every event and packed record in this codebase
// concatenates fields without escaping.
const MaxOfferTitleLen int = 64

// MaxHashLen bounds the free-form commitment strings an escrow carries —
// contentHash (the asker's question) and answerHash (the creator's delivery
// attestation). Both are content addresses, not content: a CIDv1 is 59 bytes
// and a sha256 hex digest is 64, so 128 is generous for anything that is
// honestly a hash while refusing a body pasted into the field.
//
// WHY IT IS BOUNDED AT ALL, stated because the absence was the inconsistency:
// every OTHER free-form buyer-facing field in this contract is length-capped at
// the door (MaxOfferTitleLen above, for exactly this reason), and these two are
// the ones that end up in a PERMANENT packed escrow record. An unbounded field
// concatenated into a stored record is the batch-size class of defect — no
// individual write is wrong, and nothing bounds the total. Rejecting at the
// door is the same discipline validOfferTitle applies.
const MaxHashLen int = 128

// ---- supply cap ----

// MinCap / MaxCap bound the creator-set outstanding-credit cap. The cap is the
// speculation switch (SPEC §1.3): once exhausted, further demand must clear on
// the secondary market above face.
const MinCap int64 = 1
const MaxCap int64 = 1_000_000_000

// ---- escrow ----

// MinAskDeadline / MaxAskDeadline bound how long a creator has to answer.
// ---- delivery gate (RULING E, built 2026-07-27) ----
//
// A MISS is objective and needs no oracle: an escrow still PENDING at
// deadline+ReclaimGrace was not delivered, full stop. A creator who does not
// want a job can Decline it for free (ask.go) — full refund including the
// commission, and explicitly NOT a miss — so a miss means the creator ignored
// a paying customer until the window closed. That is why the threshold can be
// this strict without punishing anyone acting in good faith.
//
// MinMissesForDelinquency is a floor on the SAMPLE, not on the offence: with
// one ask in flight, one miss is 100% and would otherwise convict instantly.
// MaxMissBps then judges the rate, so a busy creator who misses 3 of 100 is
// fine and a quiet one who misses 3 of 4 is not.
const MinMissesForDelinquency uint64 = 3
const MaxMissBps uint64 = 2500 // 25% of resolved asks

// DelinquencyBlocks is how long inflows stay shut after crossing the
// threshold. It is a FIXED, self-clearing penalty rather than a condition to
// be cured, because the cure would be circular: delinquency refuses new asks,
// and only new answered asks could improve the ratio, so a rate-based release
// would be a life sentence served by a creator with no way to appeal it. Seven
// days is long enough to cost a real creator real money and short enough that
// an honest one who was ill or offline is not destroyed by it.
const DelinquencyBlocks uint64 = 7 * BlocksPerDay

const MinAskDeadline uint64 = BlocksPerDay      // 1 day
const MaxAskDeadline uint64 = 30 * BlocksPerDay // 30 days

// ReclaimGrace separates the answer window from the reclaim window so the two
// can never both be valid in the same block. This is what makes the verified
// producer-ordering defect irrelevant here: order inside a block cannot decide
// which of answer/reclaim wins, because only one is ever legal.
const ReclaimGrace uint64 = 1200 // ~1 hour

// MissReclaimSliceBps is the fraction of the HELD commission the protocol keeps
// when a reclaim is a MISS (USER RULING, 2026-07-28). It is the only exception
// to I5 ("no commission on refunds"), and it exists because griefing was
// otherwise free: Reclaim handed back the credits AND 100% of the commission,
// and the credits come back with their original acquisition clock (holdclock),
// so nine junk asks in one block bought 22 days of a creator's shutdown at a
// cost of exactly zero. delivery.go's claim that "a hostile asker must pay for
// each ask" was factually false until this constant existed.
//
// It is charged ONLY on a miss — never on Decline (the creator's free, honest
// "no"), never on a self-dealt escrow, and never against the CREDITS, which
// always come back whole. So the honest asker's exposure is bounded by the
// creator's own behaviour: a creator who cannot do the job declines and the
// asker is made whole to the last unit; an asker only ever pays this when the
// creator went silent for the entire window. That is a real cost borne by a
// wronged party, and it is the deliberate price of making the grief cost
// nonzero — there is no way to charge only the malicious asker, because the
// contract cannot tell them apart from an unlucky one.
//
// It goes to kTreasury(), NEVER to the creator. Paying the creator here would
// pay them for going silent, which is the exact behaviour the gate punishes.
//
// 25% of a 12% commission = 3% of the posted face per junk ask, so the grief
// cost scales with the price of the creator being griefed rather than with a
// protocol-wide constant an attacker could shop around. Rounded UP (mMulDivCeil)
// so no dust-priced escrow can round the deterrent away to zero.
const MissReclaimSliceBps uint64 = 2500

// ---- TWAP (SPEC §1.3b) ----

// ObsWindow is the ring-buffer size for price observations.
const ObsWindow uint64 = 32

// MinObsBlocks is the minimum span the TWAP must cover before it may be used to
// price an ask. Spot price is never used.
const MinObsBlocks uint64 = 1200 // ~1 hour

// MinObsCount is the minimum number of DISTINCT-block observations required.
const MinObsCount uint64 = 8

// ShortObsSpacing is the SHORT ring's sampling interval — the fix for
// SET-1 (adversarial fix round 1, 2026-07-22).
//
// THE DEFECT IT CLOSES, stated plainly because it was a self-inflicted kill
// switch: the short ring used to accept ONE observation per BLOCK with no
// further rate limit, while twapWindowRead demands the live set span at
// least MinObsBlocks (1200). The live set is always the last ObsWindow (32)
// observations, so ANY market that traded more than 32 times inside an hour
// evicted its own history, its window span fell below 1200, and every
// settlement path (Ask — and SettlementRate itself) refused
// with "observations span less than the minimum window". Measured on the
// real package: 31 trades/1200 blocks priced fine, 33 killed it. Two
// consequences, both bad: (a) SUCCESS was the trigger — a market busy enough
// to trade in ~3% of blocks permanently lost its entire services product
// with no attacker at all; (b) a griefer could buy the outage for the trade
// fee alone (a flat Buy(1)/Sell(1) round trip realizes zero gain, so RULING
// J1's cap makes the exit tax exactly 0) — measured 212 HBD/day against a
// small market, 15,250 HBD/day against a large one.
//
// THE FIX IS STRUCTURAL, not a threshold: rate-limit the short ring exactly
// the way RecordObs already rate-limits the LONG one (LongObsSpacing), so a
// full ring's span is >= MinObsBlocks BY CONSTRUCTION instead of by luck.
// With 32 slots, a full ring spans at least
//
//	(ObsWindow − 1) · ShortObsSpacing = 31 · 40 = 1240 >= MinObsBlocks (1200)
//
// with headroom, and extra writes inside an interval are DROPPED rather than
// stored, so no amount of trading can ever compress the window again. This
// subsumes the old same-block dedup (spacing >= 1) and leaves
// MaxObsWeightBlocks (2400) doing its existing job. The young-market
// refusal is unchanged: MinObsCount (8) samples still cannot span
// MinObsBlocks on their own (7 · 40 = 280 < 1200), so a fresh market still
// has to age into a price.
//
// The cost, stated honestly: on a busy market the short window now covers
// >= ~20 minutes of history rather than the last 32 blocks, and the first
// trade of each 40-block interval is the one that samples. Both are
// STRICTLY better for manipulation resistance (a wider window is harder to
// walk), and the sampling-choice property is identical to the long ring's,
// which the ruling already accepted.
const ShortObsSpacing uint64 = 40

// MaxRateDeviationBps caps how far the accepted rate may move from the window's
// MEDIAN observation. Beyond it an ask reverts rather than settling at a
// suspicious price.
//
// Measured against the median rather than the newest observation deliberately.
// Comparing against the newest is self-referential: on a market that has been
// quiet, the newest observation carries almost all of the time-weight, so it
// sets the TWAP and then passes its own deviation check trivially. The median
// cannot be moved by a single write.
const MaxRateDeviationBps uint64 = 2000 // 20%

// MaxObsWeightBlocks caps how much time-weight any SINGLE observation may carry.
//
// Without it, a market nobody has touched for weeks gives its newest
// observation a dwell time covering the entire gap — so one opportunistically
// timed write dominates the average. Clamping each observation's dwell means a
// stale market simply fails to produce a usable rate (too little total weight)
// instead of producing a manipulated one. Refusing to price is always safe;
// pricing wrongly is not.
const MaxObsWeightBlocks uint64 = 2400 // ~2h

// MaxStaleBlocks refuses to price at all when the newest observation is older
// than this. The weight clamp stops one sample dominating, but a market that
// has been silent for a week would still price off week-old data and call it a
// rate. Refusing is the safe failure; pricing stale is not. Tunable at testnet.
const MaxStaleBlocks uint64 = 3 * BlocksPerDay

// ParBaseUnitsPerCredit is PAR: 1 credit ⇔ 1 HBD base unit at issuance.
// Hoisted here from refund.go so no module has to infer it from prose — the
// refund cap and any future rate floor/ceiling must agree on one value.
const ParBaseUnitsPerCredit int64 = 1

// ---- market states ----

const (
	StateActive  = "ACTIVE"  // subscription current, everything works
	StateOverdue = "OVERDUE" // lapsed, inside grace — still fully functional
	StateFrozen  = "FROZEN"  // inflows blocked, wind-down open, escrows resolve
	StateClosed  = "CLOSED"  // wind-down complete
)

// ---------------------------------------------------------------------------
// ---- bonding curve (RULING I, RULINGS-v2-2026-07-21 — USER-RULED) ----
//
// ADDED as a separate, clearly-marked block per this file's own header rule
// ("Foundation files ... must not be edited — if you need a new key or
// constant, add it there in a separate, clearly-marked block", API.md).
//
// RULING F5 — BINDING: every constant in this block is a compile-time
// `const` with NO setter, EVER. Not a governance parameter, not an owner
// knob, not a per-market field. A live change to any of them retroactively
// reinterprets every stored (supply, reserve) pair against a DIFFERENT curve
// across ALL markets at once, and can push reserve < area(supply) — an
// instant, global solvency break with no transaction having moved a single
// unit. The curve's SHAPE and its exact-integer area form are locked by
// RULING I; these values are frozen into the bytecode.
//
// THE RULED CURVE (RULING I, replacing the pure-linear PS=21/D=2 slope, and
// building the RULING-H BasePrice that params.go previously recorded as
// unbuilt):
//
//	price(i) = BasePrice + a·i + b·i²      a = 63/8,  b = 21/8000
//	area(S)  = S·BasePrice + floor((63000·T(S) + 21·P(S)) / 8000)
//	           T(S) = S(S+1)/2             P(S) = S(S+1)(2S+1)/6
//
// T and P are EXACT integers (S(S+1) always even; S(S+1)(2S+1) always
// divisible by 6), the BasePrice term is EXACT (never divided), and the
// single common denominator 8000 makes the floor the ONE rounding site in
// the whole primitive. A recheck PROVED the alternative — rounding the
// linear and quadratic legs independently — fails the L5 round-trip
// equality in 65% of cases and breaks L1-L4 as well; the exact-area form
// holds all five lemmas as exact equalities (200,000 fuzz cases, 0
// failures). NEVER split the division.
//
// WHY 25% QUADRATIC (RULING I's rationale, recorded): pure linear was
// originally chosen because friend.tech's pure quadratic made being early
// worth 267×, and that early-buyer premium IS the pump-and-dump incentive.
// The ruled 25%-at-calibration-point quadratic term buys back a bounded
// amount of upside — early-100 multiple 6.1× → 7.7× at a 1,000-token
// market, 17.3× → 33.5× at 3,000 — concentrated on markets that actually
// GROW, not on the bottom of the curve where sniping lives. The first-mint
// snipe stays ~11× because BasePrice holds the floor. ★ Correction carried
// from the ruling: BasePrice is a LARGER anti-speculation lever than the
// curve exponent (it alone moved the early multiple 18.8× → 6.1× and the
// first-mint snipe 1,500× → 11×); any future "more speculation" request is
// evaluated against BasePrice first, and lowering it re-opens sniping fast
// (0.050 HBD ⇒ 185× snipe).
//
// VERIFIED AT THESE EXACT INTEGERS (RULING I): the governing theorem
// (fresh buyer of any n at a flat pro-rata wind-down never profits) — 2,030
// cases at these parameters and 4,270 across 7 curve parameterisations, 0
// profitable; it holds for the whole family (price ~ i^p ⇒ area ~ S^(p+1)
// ⇒ area(S)/area(S+n) <= S/(S+n) for every p >= 0, and positive blends
// inherit it by the mediant inequality). No zero or negative marginal price
// anywhere (price(i) >= BasePrice = 1000 > 0). Reserve at S=1,000 is
// 5,817.750 HBD. Cost, stated honestly: backing per token FALLS vs pure
// linear (6,255 → 5,818 HBD at S=1,000) because early tokens sell cheaper —
// the floor is the reserve, so a steeper curve is a lower floor.
//
// WHAT THE PREVIOUS CALIBRATION WAS AND WHY IT CHANGED: PS=21/D=2 (pure
// linear, slope 10.5 units/token, zero intercept) fixed the two RULING-H
// defects of PS=D=1 — an absurd economic range and ceil==floor rounding
// no-ops invisible to mutation testing — but carried no BasePrice (the
// zero intercept is a 100,000× first-buy free ride, RULING H) and no
// quadratic term. Under RULING I the remainder (63000·T + 21·P) mod 8000
// is nonzero on most real trades, so the floor stays mutation-visible
// (asserted by curve_test.go's parity test, the same anti-no-op guard the
// 21/2 calibration introduced).
// ---------------------------------------------------------------------------

// BasePrice is the constant term of price(i), in HBD base units: 1.000 HBD.
// EXACT — the S·BasePrice area term is never divided, never rounded. This is
// RULING H's anti-snipe intercept, now built: the first token costs
// 1000 + floor((63000 + 21)/8000) = 1007 units (≈ 1.007 HBD), not dust, so
// neither a bot nor the creator's own alt gets a cheap instant first buy.
const BasePrice int64 = 1000

// CurveLinNum is the linear coefficient's numerator over CurveDenom:
// a = 63/8 = CurveLinNum/CurveDenom = 63000/8000 base units per token index.
const CurveLinNum int64 = 63000

// CurveQuadNum is the quadratic coefficient's numerator over CurveDenom:
// b = 21/8000 = CurveQuadNum/CurveDenom base units per token index squared.
// At the calibration point this contributes 25% of the marginal price — the
// ruled "bounded step toward speculation".
const CurveQuadNum int64 = 21

// CurveDenom is the single common denominator of both curve coefficients.
// ONE denominator ⇒ ONE floor per area evaluation ⇒ the exact-area lemmas
// L1-L5 hold as equalities (curve.go). Must be >= 1; must NOT divide both
// numerators' contributions into exactness for all S (a curve whose
// numerator is always divisible by CurveDenom resurrects the ceil==floor
// mutation-invisibility no-op documented above — with 63000·T + 21·P mod
// 8000 this is not the case, verified by the parity test).
const CurveDenom int64 = 8000

// TradeFeeBps is the total trade fee on curve buys AND sells: 10% = 5% creator
// + 5% platform, friend.tech-style (LOCKED-MECHANISM "Fees & taxes"). The fee
// is REVENUE, never reserve: skimmed ON TOP of buyCost on buys (buyer pays
// cost+fee, only cost enters the reserve) and OUT OF the payout on sells
// (seller receives proceeds−tax−fee; the reserve is debited the full
// proceeds, the tax goes to the treasury — RULING J, sell.go — and the fee
// to the pull pots).
// C-19: the reserve delta is exactly ±the curve leg on every trade; the fee
// never touches kReserve in either direction.
//
// The creator/platform split is computed in tradefee.go (floor half to the
// creator, remainder — i.e. the odd unit — to the platform), NOT stored as two
// separate bps constants, so the two halves can never be edited out of sync
// with the total.
//
// RULING F8 — BINDING: the fee accrues to PULL-claimable balances
// (kFeeBal(creator) / kTreasury()), NEVER a pushed transfer. Our own
// friend.tech teardown found that a creator whose address cannot receive a
// pushed fee bricks every buy and sell forever (fee-push + require(success));
// pull-based accrual makes that failure structurally impossible.
const TradeFeeBps uint64 = 1000

// MaxExitTaxBps is the exit-tax ceiling: 20% for the freshest holds, decaying
// linearly to 0 at ExitTaxDecayBlocks (exittax.go).
//
// RULING J (RULINGS-v2-2026-07-21, USER-RULED — overturns RULING A's
// destination while keeping what A actually proved): the tax is taken in
// MONEY, never as a token burn, and goes to the TREASURY. RULING K
// (2026-07-22) makes it ONE rule at every value-out door (curve Sell AND
// wind-down Refund) on GROSS proceeds with NO cap:
//
//	tax = ceil(grossProceeds · τ(h) / 10000)
//
// RULING J1's realized-gain cap — min(rate, gain) — is REVERSED (K1): it was
// defeated 45–68% by splitting one dump into two same-block sells, and the
// gross tax is un-splittable (ceil superadditive + curve-leg path-independent)
// with ZERO per-holder state. kBasis and the sell-episode accumulators are
// deleted (exittax.go / keys.go).
//
// THE FULL HISTORY, because this parameter's mechanism was corrected twice
// and both corrections were proven at exact integers:
//
//  1. The BURN (original): withheld ceil(ΔS·τ/1e4) tokens with no payout.
//     Wrong three ways — at the ruled 20% a burn LOWERS the floor R/S
//     (ratcheting needs τ >= 50%); the effective full-exit tax was τ² = 4%
//     (burned tokens are the cheapest slice — regressive); and the
//     accumulated backing was an unallocated pot any fresh buyer could raid
//     pro-rata at wind-down (the purchasable-weight lemma — a measured
//     attacker took 97.5% of the pot in 5 days).
//  2. The HOLDER DISTRIBUTION (RULING A, now overturned by J): money tax,
//     accrual-accumulator to holders of record. Measured wrong at exact
//     integers: the effective rate was ≈ τ·(1 − your share of supply) —
//     a 1% fan paid 19.9% while a 99% whale paid 0.5%; the tax bit the fan
//     and spared the whale it existed for. The idealized best case of ALL
//     proposed patches at once (perfect snapshot + 7-day min-hold + full
//     seller exclusion) still left whale self-recovery at 97.5% — an aged
//     keeper account is indistinguishable from an honest holder (the
//     receiving-side dual of the purchasable-weight lemma). Repointing to
//     treasury makes the whale's effective rate 20.0%, un-recoverable at
//     any tranche or account count, and the one-block front-run bot
//     collects zero.
//
// Treasury-destination keeps everything RULING A proved: the tax is money
// (20% means 20% at every exit size), R === area(S) holds with equality (no
// pot ever forms — the governing theorem closes the drain class), and no
// accounting aggregate remains that could revert an outflow (RULING G is
// satisfied structurally).
const MaxExitTaxBps uint64 = 2000

// ExitTaxDecayBlocks is the hold time at which the exit tax reaches exactly 0:
// 6 weeks (LOCKED-MECHANISM: "LINEAR decay to 0% at 6 weeks held").
// 42 days · 28,800 blocks/day = 1,209,600 blocks at ~3s each.
// UNCHANGED by RULING J — the rate machinery (linear ceil decay, hold clock,
// transfer-reset) was never broken; only the tax's DESTINATION was.
const ExitTaxDecayBlocks uint64 = 42 * BlocksPerDay

// ---------------------------------------------------------------------------
// ---- settlement (RULING C, RULINGS-v2-2026-07-21) ----
//
// ADDED as a separate, clearly-marked block per this file's own header rule.
// These parameterise settlement.go (rate = min(TWAP_short, TWAP_long, spot)
// + the depth/spend/min-price guards) and twap.go's LONG observation ring.
//
// WHAT THE PREVIOUS VERSION DID AND WHY IT CHANGED: SettlementRate fell back
// to PAR (1 base unit per token) whenever the TWAP refused — which is wrong
// by exactly the factor `spot`, ALWAYS in the asker-robbing direction (a
// 0.1 HBD MinFace service cost 100 tokens where correct pricing costs 1 —
// a 100x overcharge), and fired on ordinary conditions (a market quiet 3
// days, a >20% move). RULING C: settlement must REFUSE instead. Refusing is
// an INFLOW refusal only — Ask is the only settlement caller
// and is a RequireInflowOpen-gated inflow; no outflow anywhere calls
// settlement (proven by TestSettlementRefusalGatesNoOutflow).
// ---------------------------------------------------------------------------

// LongObsSpacing is the long ring's sampling interval: RecordObs writes the
// long ring only when the previous long observation is at least this many
// blocks old, so ObsWindow (32) slots span 32·6300 = 201,600 blocks = exactly
// the ruled 7 days (RULING C1: TWAP_long = 7 days). This is the honest
// storage design the ruling asks for: a full-resolution 7-day ring would need
// ~201,600 slots; the coarse ring costs ONE extra state write per
// LongObsSpacing per creator (amortised ~one write per 5.25h of trading) and
// 32 slots, at the price of a sampling granularity of 6300 blocks — a
// sustained walk must therefore hold its position across MANY samples, which
// is exactly the property the long window exists for.
const LongObsSpacing uint64 = 6300

// LongMinObsCount is the minimum number of long-ring samples before the long
// TWAP may price at all (mirrors MinObsCount's role on the short ring).
const LongMinObsCount uint64 = 8

// LongMinObsBlocks is the minimum span (and minimum accumulated clamped
// weight) the long ring must cover before pricing: 2 days. Consequence,
// stated honestly: a brand-new market CANNOT settle services for its first
// ~2 days of trading — that is deliberate. The first observations after
// launch are the thinnest and most manipulable this system ever sees (the
// old PAR-era doc admitted this and shipped anyway); under RULING C the
// young-market answer is REFUSE, which gates only inflows. Full 7-day depth
// was considered and rejected as the minimum: it would dead-zone every
// market's first week for no additional safety, since the spot ceiling
// (RULING C1's no-arbitrage bound) holds independently of window depth.
const LongMinObsBlocks uint64 = 2 * BlocksPerDay

// LongMaxObsWeightBlocks caps the dwell weight of a single long-ring sample
// at 2·LongObsSpacing — same role as MaxObsWeightBlocks on the short ring: a
// market quiet for weeks runs out of total weight and refuses, instead of
// letting one well-timed sample dominate a 7-day average.
const LongMaxObsWeightBlocks uint64 = 2 * LongObsSpacing

// LongMaxStaleBlocks refuses the long TWAP when its newest sample is older
// than this: MaxStaleBlocks + LongObsSpacing. The +LongObsSpacing term is the
// sampling offset — under dense trading the long ring's newest sample lags
// the newest trade by up to one spacing interval, so a bare MaxStaleBlocks
// bound would spuriously refuse a market that traded continuously and then
// went quiet for just under 3 days. Effective quietness tolerance is
// therefore the same 3 days the short ring already enforces.
const LongMaxStaleBlocks uint64 = MaxStaleBlocks + LongObsSpacing

// MaxServiceFaceAreaBps is RULING C2's depth ceiling: a service face may not
// exceed 50% of area(S) — the market's OWN curve depth — at spend time.
// Measured against area(S), NEVER the reserve: v1's reserve-relative version
// was backwards — divergence IS the reserve being large relative to S, so the
// reserve-relative ceiling read 480,048 HBD on the diverged exhibit (never
// binds when needed) and over-bound a healthy market. Under R === area(S)
// the two coincide, and the area form stays correct even on corrupt state.
const MaxServiceFaceAreaBps uint64 = 5000

// MaxSpendSupplyBps is the settlement spend cap: one settlement may consume
// at most 5% of the CURRENT supply in tokens (c·10000 <= S·500). RULING C2
// ships it in the same commit as the spot term because it is load-bearing
// against DOWN-manipulation of spot: min() follows a walked-down rate, which
// INFLATES the token count c = ceil(face/rate) — the asker consented via
// maxCredits, but without this cap a down-walked market would let a single
// service settlement move an unbounded fraction of the supply to the
// creator in one call.
const MaxSpendSupplyBps uint64 = 500

// DivergenceRateMultiple is RULING C5's circuit-breaker: refuse settlement
// when ceil(R/S) > 4·rate. Under R === area(S) the backing-per-token R/S is
// the curve's AVERAGE price, which never exceeds the marginal spot (price is
// non-decreasing in i), so with rate ≈ spot this cannot fire — it is a
// tripwire that PROVES the equality invariant holds on the live path. It can
// also fire transiently after an extreme (≳4x in average-price terms) recent
// supply move, while the TWAPs still lag far below the new spot: that is a
// refusal on an inflow during a highly abnormal move, safe by construction,
// and it self-heals as the windows catch up.
const DivergenceRateMultiple uint64 = 4
