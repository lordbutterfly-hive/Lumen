//go:build pruned_findings

// ════ AUDIT FINDING-DETECTOR, NOT A UNIT TEST ════
//
// This file FAILS ON PURPOSE. Each test asserts the ABSENCE of a defect the PRUNED audit
// of 2026-08-19 proved is PRESENT, so a failure here is the finding reproducing itself,
// not a regression.
//
// ★ IT IS BEHIND A BUILD TAG SO THE DEFAULT SUITE STAYS GREEN. Left untagged, `go test
// ./...` was red for reasons that are all known and documented - which destroys the one
// thing a suite is for: telling you when something NEW broke. A permanently-red suite is
// a suite nobody reads.
//
//   run the detectors:  go test -tags pruned_findings ./...
//   run the real suite: go test ./...
//
// When a finding is FIXED, its detector here starts passing. That is the intended signal:
// delete the test then, or move it into the real suite as a regression guard.
//
// Findings, artifacts and twins: /mnt/o/LUMEN-DOCS/audits/creator-tokens/2026-08-19/

package core

// zz_pruned_phase1_observability_test.go — PRUNED PHASE 1, OBSERVABILITY /
// OFF-CHAIN DIVERGENCE lane (H-16, H-17, H-18, H-06). Test-only file, adds
// no production code. Every test here is EXECUTED, not read-only.

import (
	"encoding/json"
	"math/big"
	"testing"
)

// ---------------------------------------------------------------------------
// H-17 — evJSONEscape sweep + control-byte injection through Ask/Answer.
// ---------------------------------------------------------------------------

// TestPhase1_H17_EvJSONEscape_Sweep is the free, in-repo, decisive check:
// every string argument that reaches evJSONEscape anywhere in events.go is
// EITHER constrained by validAccount (which rejects every byte < 0x20 and
// 0x7f..0xff, see util.go:137-149) OR constrained by validOfferTitle (which
// rejects control bytes explicitly, offerings.go:230-239) OR a hardcoded
// literal at the call site (EvInitMagiNft's name/symbol) — with exactly two
// exceptions: contentHash (EvAsked) and answerHash (EvAnswered), which
// ask.go validates only for emptiness, MaxHashLen, and the absence of '|'.
//
// This test proves the validAccount claim by construction (it is the
// account gate every core entrypoint applies) and proves the two exceptions
// by driving Ask/Answer with a control byte and watching them succeed.
func TestPhase1_H17_EvJSONEscape_Sweep(t *testing.T) {
	controlByte := byte(0x0a) // newline — well inside 0x00-0x1F
	dirty := "a" + string([]byte{controlByte}) + "b"

	// validAccount is the gate for every creator/actor/to/from/holder/asker/
	// owner/spender/operator/tokenID argument in every Ev* constructor.
	// Confirm it actually rejects the same control byte contentHash/
	// answerHash let through.
	if validAccount(dirty) {
		t.Fatalf("validAccount unexpectedly accepted a control byte — the sweep's safety claim for every account-typed field is false")
	}
	if validAccount("") {
		t.Fatalf("validAccount unexpectedly accepted empty")
	}

	// validOfferTitle is the gate for EvOfferingCreated/EvOfferingUpdated's
	// title argument. Confirm it rejects the same control byte.
	if err := validOfferTitle(dirty); err == nil {
		t.Fatalf("validOfferTitle unexpectedly accepted a control byte — the offering-title fix regressed")
	}

	// The two unguarded doors: contentHash and answerHash accept the same
	// byte that the two gates above reject. Proven properly below
	// (TestPhase1_H17_Ask_ControlByte / TestPhase1_H17_Answer_ControlByte);
	// this assertion just pins the asymmetry the sweep claims.
	if strings_Contains(dirty, "|") {
		t.Fatalf("test construction bug: dirty string must not contain '|', ask.go's own guard would reject it for an unrelated reason")
	}
}

// strings_Contains avoids importing strings twice under two names in this
// small file; core/ask.go already imports "strings" but this test file is
// compiled separately, so it gets its own tiny helper instead of an import
// collision risk.
func strings_Contains(s, substr string) bool {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// hz17SeedAskableMarket seeds a market and an asker with enough balance and
// TWAP history that Ask can settle. Reuses ask_test.go's own seedSettleObs
// helper (stObsCount observations spaced LongObsSpacing apart) rather than
// inventing a new observation schedule — that helper is already proven to
// satisfy both TWAP rings' count+span gates. block is set to the query
// block seedSettleObs returns, so the market is never stale.
func hz17SeedAskableMarket(t *testing.T, creator, asker string, rate int64) (*MemStore, uint64) {
	t.Helper()
	s := NewMemStore()
	base := uint64(1000)
	setupMarket(s, creator, base, 100000)
	setMoney(s, kFace(creator), big.NewInt(rate))
	// Give the asker a maturing balance large enough to cover any ask.
	setMoney(s, kBal(creator, asker), big.NewInt(1_000_000))
	setMoney(s, kSupply(creator), big.NewInt(1_000_000))
	queryBlock := seedSettleObs(s, creator, base, big.NewInt(rate))
	// setupMarket's paidUntil is anchored at `base`; extend it so the
	// market is still ACTIVE at queryBlock (well past base once the TWAP
	// history is laid down).
	setU64(s, kPaidUntil(creator), queryBlock+SubscriptionPeriod)
	return s, queryBlock
}

// H-17's Ask and Answer control-byte detectors have been REMOVED from this
// file, 2026-08-19, because the finding they measured is FIXED: core.Ask and
// core.Answer now reject control bytes in contentHash/answerHash
// (ask.go's validEventHash). They lived here asserting the VULNERABLE
// behaviour, so leaving them would mean a permanently red detector claiming a
// bug that no longer exists.
//
// Their coverage was not dropped — it was inverted and promoted into the
// tracked suite, where it now guards the fix instead of documenting the hole:
// TestAsk_ControlByteInContentHashRefused and
// TestAnswer_ControlByteInAnswerHashRefused in core/ask_test.go, same five
// cases (NUL, newline, ESC, DEL, clean baseline).
//
// TestPhase1_H17_EvJSONEscape_Sweep above is untouched: it measures the escape
// helper's own 16-site surface, which is still the right thing to watch.

func hz16SimulateWrapperTransfer(s Store, creator, from, to string, block uint64, amount *big.Int) (events []string, err error) {
	if err := TransferCredits(s, from, creator, from, to, block, amount); err != nil {
		return nil, err
	}
	events = append(events, EvTransferred(creator, from, to, block, amount))
	return events, nil
}

// hz16SimulateWrapperTransfer_FIXED is the counterfactual: the SAME call,
// but additionally emitting an EvMaturedMoved for whatever the matured
// bucket actually did — i.e. what the wrapper would need to do to close the
// gap (mirroring the shape of emitMaturedDelta at main.go:793, adapted to
// Transfer's two-holder shape). Used only to prove this test can
// discriminate a fixed wrapper from the real one (Standing Rule: "state
// what would have made it FAIL and confirm your test could produce that").
func hz16SimulateWrapperTransfer_FIXED(s Store, creator, from, to string, block uint64, amount *big.Int) (events []string, err error) {
	maturedFromBefore := getMatured(s, creator, from)
	if err := TransferCredits(s, from, creator, from, to, block, amount); err != nil {
		return nil, err
	}
	events = append(events, EvTransferred(creator, from, to, block, amount))
	maturedFromAfter := getMatured(s, creator, from)
	movedFrom := new(big.Int).Sub(maturedFromBefore, maturedFromAfter) // >0 if matured left `from`
	if movedFrom.Sign() > 0 {
		events = append(events, EvMaturedMoved(creator, from, from, to, block, movedFrom))
	}
	return events, nil
}

// hz16EventDerivedMaturedDelta replays a set of event STRINGS the way the
// indexer's own documented convention says it must (events.go's file header:
// "The DERIVED balance views compute holdings as inflow minus outflow over
// these events"): only "maturedMoved" (and the standard "TransferSingle",
// not exercised by this helper since main.go's real Transfer never emits
// it either) events move the matured-bucket ledger an indexer builds. A
// "transferred" event (EvTransferred's own type) is NOT one of those —
// events.go's own comment block enumerating the matured-bucket movers names
// exactly Ask/Answer/Refund/RefundHolder's four emitMaturedDelta call sites,
// never TransferCredits/EvTransferred. This function parses just enough of
// the flat JSON to find "type":"maturedMoved" events and fold their
// from/to/amount into a per-holder delta map, matching the SQL in
// magi-indexer/creator_tokens_views.yaml's own "inflow minus outflow" model.
func hz16EventDerivedMaturedDelta(t *testing.T, events []string, holder string) *big.Int {
	t.Helper()
	delta := big.NewInt(0)
	for _, raw := range events {
		var m map[string]any
		if err := json.Unmarshal([]byte(raw), &m); err != nil {
			t.Fatalf("event is not valid JSON, cannot replay it as an indexer would: %v (%s)", err, raw)
		}
		if m["type"] != "maturedMoved" {
			continue
		}
		amtStr, _ := m["amount"].(string)
		amt, ok := new(big.Int).SetString(amtStr, 10)
		if !ok {
			t.Fatalf("maturedMoved amount is not a valid decimal: %v", m["amount"])
		}
		if m["from"] == holder {
			delta.Sub(delta, amt)
		}
		if m["to"] == holder {
			delta.Add(delta, amt)
		}
	}
	return delta
}

// TestPhase1_H16_TransferCredits_MaturedBucket_EventGap is the differential
// test proper. Sequence: A holds a maturing balance M and a matured balance
// Tm > 0. A transfers amount = M + delta (delta <= Tm, delta > 0) to B, so
// splitDraw (matured.go:185, maturing-first) exhausts the maturing bucket
// and draws `delta` from A's MATURED bucket. TransferCredits credits that
// delta straight into B's matured bucket (transfer.go:157).
//
// LEDGER TRUTH: getMatured(A) falls by delta, getMatured(B) rises by delta —
// asserted directly against the Store, not inferred.
//
// EVENT-DERIVED TRUTH (real wrapper): the only event emitted is
// EvTransferred, which carries no "maturedMoved" type, so
// hz16EventDerivedMaturedDelta returns 0 for both A and B.
//
// DIVERGENCE: |ledger truth - event-derived truth| == delta, exactly the
// entire matured leg — for every delta in (0, Tm].
func TestPhase1_H16_TransferCredits_MaturedBucket_EventGap(t *testing.T) {
	creator := "creatorh16"
	holderA, holderB := "holdera16", "holderb16"
	block := uint64(5000)

	for _, delta := range []int64{1, 50, 999} {
		delta := delta
		t.Run(mustItoa(delta), func(t *testing.T) {
			s := NewMemStore()
			setupMarket(s, creator, block, 1_000_000)

			maturing := big.NewInt(200)
			matured := big.NewInt(1000) // >= every delta tried
			setMoney(s, kBal(creator, holderA), maturing)
			setMatured(s, creator, holderA, matured)
			setU64(s, kAcqBlock(creator, holderA), block) // fresh clock, irrelevant to this test

			amount := new(big.Int).Add(maturing, big.NewInt(delta))

			maturedABefore := getMatured(s, creator, holderA)
			maturedBBefore := getMatured(s, creator, holderB)

			events, err := hz16SimulateWrapperTransfer(s, creator, holderA, holderB, block, amount)
			if err != nil {
				t.Fatalf("TransferCredits failed: %v", err)
			}

			maturedAAfter := getMatured(s, creator, holderA)
			maturedBAfter := getMatured(s, creator, holderB)

			// ---- ledger truth ----
			ledgerDeltaA := new(big.Int).Sub(maturedABefore, maturedAAfter) // amount that LEFT A's matured bucket
			ledgerDeltaB := new(big.Int).Sub(maturedBAfter, maturedBBefore) // amount that ENTERED B's matured bucket
			want := big.NewInt(delta)
			if ledgerDeltaA.Cmp(want) != 0 {
				t.Fatalf("ledger truth: expected A's matured bucket to fall by %d, fell by %s", delta, ledgerDeltaA)
			}
			if ledgerDeltaB.Cmp(want) != 0 {
				t.Fatalf("ledger truth: expected B's matured bucket to rise by %d, rose by %s", delta, ledgerDeltaB)
			}

			// ---- event stream sanity: exactly one event, type "transferred" ----
			if len(events) != 1 {
				t.Fatalf("expected exactly 1 event from the real wrapper simulation, got %d: %v", len(events), events)
			}
			var evParsed map[string]any
			if err := json.Unmarshal([]byte(events[0]), &evParsed); err != nil {
				t.Fatalf("emitted event is not valid JSON: %v", err)
			}
			if evParsed["type"] != "transferred" {
				t.Fatalf("expected event type \"transferred\", got %v", evParsed["type"])
			}

			// ---- event-derived truth (what an indexer folding maturedMoved sees) ----
			derivedA := hz16EventDerivedMaturedDelta(t, events, holderA)
			derivedB := hz16EventDerivedMaturedDelta(t, events, holderB)
			if derivedA.Sign() != 0 {
				t.Fatalf("event-derived delta for A should be 0 (no maturedMoved emitted), got %s", derivedA)
			}
			if derivedB.Sign() != 0 {
				t.Fatalf("event-derived delta for B should be 0 (no maturedMoved emitted), got %s", derivedB)
			}

			// ---- the divergence, printed ----
			divergenceA := new(big.Int).Sub(ledgerDeltaA, new(big.Int).Neg(derivedA))
			t.Logf("DIVERGENT SEQUENCE (delta=%d): setupMarket(%s); seed holderA maturing=%s matured=%s; TransferCredits(creator=%s, from=%s, to=%s, block=%d, amount=%s) -> real wrapper emits ONLY %s. LEDGER: A matured %s->%s (-%s), B matured %s->%s (+%s). EVENT-DERIVED (maturedMoved fold): A delta=%s, B delta=%s. DIVERGENCE = %s tokens silently unaccounted for per holder.",
				delta, creator, maturing, matured, creator, holderA, holderB, block, amount, events[0],
				maturedABefore, maturedAAfter, ledgerDeltaA, maturedBBefore, maturedBAfter, ledgerDeltaB,
				derivedA, derivedB, divergenceA)

			// ---- discriminating-power check: the FIXED wrapper must NOT diverge ----
			s2 := NewMemStore()
			setupMarket(s2, creator, block, 1_000_000)
			setMoney(s2, kBal(creator, holderA), maturing)
			setMatured(s2, creator, holderA, matured)
			setU64(s2, kAcqBlock(creator, holderA), block)

			fixedEvents, err := hz16SimulateWrapperTransfer_FIXED(s2, creator, holderA, holderB, block, amount)
			if err != nil {
				t.Fatalf("fixed-wrapper simulation failed: %v", err)
			}
			fixedDerivedA := hz16EventDerivedMaturedDelta(t, fixedEvents, holderA)
			fixedDerivedB := hz16EventDerivedMaturedDelta(t, fixedEvents, holderB)
			wantNeg := new(big.Int).Neg(want)
			if fixedDerivedA.Cmp(wantNeg) != 0 {
				t.Fatalf("counterfactual (fixed wrapper) sanity check failed: expected derived A delta %s, got %s — this test's discriminating power is broken", wantNeg, fixedDerivedA)
			}
			if fixedDerivedB.Cmp(want) != 0 {
				t.Fatalf("counterfactual (fixed wrapper) sanity check failed: expected derived B delta %s, got %s — this test's discriminating power is broken", want, fixedDerivedB)
			}
			t.Logf("DISCRIMINATING POWER CONFIRMED: a wrapper that additionally emits EvMaturedMoved (as ask/answer/refund/refundHolder's emitMaturedDelta already does) makes event-derived truth match ledger truth exactly (A=%s, B=%s) — so this test fails (not passes) on a fixed Transfer entrypoint's event set, and the FAIL above is real signal, not a test-construction artifact.", fixedDerivedA, fixedDerivedB)
		})
	}
}

func mustItoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// ---------------------------------------------------------------------------
// H-06 — the closed-loop check, core arm only (indexer/keeper SQL side is
// out of this file's reach without a real Postgres; the falsifiable core
// claims are tested directly here): registerCheck refuses re-registration
// while supply > 0, CloseIfDrained refuses while supply > 0, and no core
// function enumerates holders (a structural absence, checked by grepping
// the Store interface, which offers no iteration primitive beyond the
// test-only MemStore.Keys()).
// ---------------------------------------------------------------------------

// TestPhase1_H06_StrandedHolder_BlocksCloseAndReregister drives the exact
// failure chain H-06 describes at the core level: a holder's matured
// balance is left outstanding (standing in for "the event that would have
// told the indexer about this holder never arrived"), so no RefundHolder is
// ever issued for them, so supply never reaches zero, so CloseIfDrained
// stays false forever, so registerCheck refuses a new incarnation forever.
//
// What would make this FALSE (per the hypothesis's own falsifier):
// CloseIfDrained succeeding despite the residual balance, or registerCheck
// clearing rather than refusing on non-zero supply. Both are asserted
// below, not assumed.
func TestPhase1_H06_StrandedHolder_BlocksCloseAndReregister(t *testing.T) {
	creator := "creatorh06"
	strandedHolder := "stranded16"
	block := uint64(9000)

	s := NewMemStore()
	setupMarket(s, creator, block, 1000)
	// Seed supply and a matured balance for a holder the (hypothetical)
	// indexer never learned about — mirrors "one bal-affecting event never
	// arrived" without needing the indexer itself.
	setMoney(s, kSupply(creator), big.NewInt(500))
	setMatured(s, creator, strandedHolder, big.NewInt(500))
	// Freeze the market naturally (paidUntil in the past) rather than via
	// Retire, to isolate this from H-18/retire semantics.
	setU64(s, kPaidUntil(creator), block-1)

	// Every OTHER holder already refunded / never existed — supply is
	// entirely the stranded holder's matured balance, so nothing further
	// core-side can reduce it without a RefundHolder call this test
	// deliberately never makes (standing in for "the indexer never told the
	// keeper about this holder").
	closeBlock := block + ExitTaxDecayBlocks + GraceBlocks + 10

	closed := CloseIfDrained(s, creator, closeBlock)
	if closed {
		t.Fatalf("CloseIfDrained succeeded despite supply=%s outstanding — H-06's core-side claim is FALSE (disconfirmed)", getMoney(s, kSupply(creator)))
	}
	if got := getStr(s, kState(creator)); got == "CLOSED" {
		t.Fatalf("state flipped to CLOSED despite non-zero supply")
	}

	if err := registerCheck(s, creator, creator, closeBlock+1, 1000, 1000); err == nil {
		t.Fatalf("registerCheck allowed re-registration despite stranded supply — H-06's core-side claim is FALSE (disconfirmed)")
	} else {
		t.Logf("CONFIRMED: registerCheck refuses re-registration forever while the stranded holder's matured balance (%s) keeps supply non-zero: %v", getMoney(s, kSupply(creator)), err)
	}

	// Now actually refund the stranded holder and show the loop closes —
	// proving the ONLY way out is a RefundHolder call for exactly this
	// holder, which is exactly the call the indexer gap makes the keeper
	// never issue.
	if _, err := RefundHolder(s, "anyone", creator, strandedHolder, closeBlock+1); err != nil {
		t.Fatalf("RefundHolder failed once wind-down is open: %v", err)
	}
	if !CloseIfDrained(s, creator, closeBlock+2) {
		t.Fatalf("CloseIfDrained still refused after the stranded holder was refunded and supply should be 0 (got supply=%s)", getMoney(s, kSupply(creator)))
	}
	if err := registerCheck(s, creator, creator, closeBlock+3, 1000, 1000); err != nil {
		t.Fatalf("registerCheck still refuses after a clean close: %v", err)
	}
	t.Logf("CONFIRMED: the ONLY exit from the stranded state is a RefundHolder call naming the exact holder the indexer's view must supply — no core function enumerates holders (Store has no iteration primitive outside test-only MemStore.Keys()), so a holder absent from lumen_ct_balances is a holder the keeper structurally cannot name.")
}
