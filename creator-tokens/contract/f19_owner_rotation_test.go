package main

import (
	"testing"

	"creator-tokens/sdk"
)

// F19 DEFECT FIX (2026-08-19) regression test. Part of the delivered fix,
// NOT scratch audit scaffolding — unlike the zz_pruned_phase1_*.go files
// this package may also carry during verification, this file defines its
// own tiny env helpers below rather than depending on theirs, so it stands
// on its own whenever this package is exercised under the native-stub
// substitution (runtime/native_stub.go + sdk/mock_host.go) that contract/'s
// own file-level TESTING NOTE already documents as the only way this
// package is ever natively testable at all — a pre-existing limitation of
// the package, not one this test introduces.
//
// PROVES: before this fix, "owner" (core/keys.go's kOwner()) was bound
// exactly once at Init and NO export could ever move it again — a lost or
// compromised owner key permanently locked withdrawTreasury and pause/
// unpause. This test sweeps every OTHER state-changing export and confirms
// none of them ever touch "owner", then drives the real changeOwner /
// acceptOwnership 2-step and confirms: (1) it is the ONE path that moves the
// key, (2) the new owner's authority actually works afterward, and (3) the
// old owner is refused afterward.

// f19EnvJSON builds the wire object the host hands to system.get_env — same
// shape mock_host.go's getEnv/getEnvKey expect, verified against
// requireActiveAuth's own doc (contract/main.go): caller must equal
// required_auths[0].
func f19EnvJSON(caller, auths string) string {
	return `{"contract.id":"vsc1f19test0000000000000000000000000",` +
		`"block.height":100,` +
		`"msg.caller":"` + caller + `",` +
		`"msg.sender":"` + caller + `",` +
		`"msg.required_auths":` + auths + `,` +
		`"msg.required_posting_auths":[]}`
}

// f19SwitchCaller changes only WHO is calling — it deliberately does NOT
// reset sdk.MockState, so a multi-step flow (Init, then Pause, then
// changeOwner, then acceptOwnership, ...) keeps its state across callers,
// exactly like real chain transactions from different signers against the
// same contract would.
func f19SwitchCaller(caller string) {
	sdk.MockEnvJSON = f19EnvJSON(caller, `["`+caller+`"]`)
	sdk.MockEnvKeys["block.height"] = "100"
}

// f19Bootstrap resets the whole mock host, fixes `deployer` as
// contract.owner (what Init's own gate requires — currentCaller() ==
// *sdk.GetEnvKey("contract.owner")), and switches to it as the caller.
func f19Bootstrap(deployer string) {
	sdk.MockReset()
	sdk.MockEnvKeys["contract.owner"] = deployer
	f19SwitchCaller(deployer)
}

func f19Owner() string {
	v, _ := store.Get("owner")
	return v
}

func f19PendingOwner() string {
	v, _ := store.Get("pendingOwner")
	return v
}

// f19Sweep is every state-changing export EXCEPT changeOwner/acceptOwnership
// themselves, with a plausible-shaped payload each. Whether any individual
// call SUCCEEDS is irrelevant to this test — many will fail validation
// against an unseeded market, and that is fine; the only thing asserted is
// that "owner" never changes value as a side effect of calling them.
func f19Sweep(t *testing.T, label string) {
	t.Helper()
	const c = "hive:f19sweepcreator"
	cases := []struct{ name, payload string }{
		{"init", `{}`},
		{"pause", `{}`},
		{"unpause", `{}`},
		{"register", `{"face":25000,"cap":1000000,"firstBuy":"0"}`},
		{"renew", `{"creator":"` + c + `","periods":1,"paid":"10000"}`},
		{"setFace", `{"creator":"` + c + `","newFace":26000}`},
		{"setCap", `{"creator":"` + c + `","newCap":2000000}`},
		{"transfer", `{"creator":"` + c + `","to":"hive:f19sink","amount":"10"}`},
		{"safeTransferFrom", `{"from":"` + c + `","to":"hive:f19sink","id":"` + c + `","amount":10,"data":""}`},
		{"approve", `{"spender":"hive:f19sink","id":"` + c + `","amount":50,"expected":0}`},
		{"graduate", `{"id":"` + c + `"}`},
		{"allowance", `{"owner":"` + c + `","spender":"hive:f19sink","id":"` + c + `"}`},
		{"balanceOf", `{"account":"` + c + `","id":"` + c + `"}`},
		{"creatorTokenBalance", `{"account":"` + c + `","id":"` + c + `"}`},
		{"ask", `{"creator":"` + c + `","contentHash":"Qm","offeringId":1,"deadlineBlocks":28800,"maxCredits":100000}`},
		{"answer", `{"seq":1,"answerHash":"Qm"}`},
		{"decline", `{"creator":"` + c + `","seq":1}`},
		{"rate", `{"creator":"` + c + `","seq":1,"score":5}`},
		{"reclaim", `{"creator":"` + c + `","seq":1}`},
		{"refund", `{"creator":"` + c + `","credits":"10"}`},
		{"buy", `{"creator":"` + c + `","tokens":"10"}`},
		{"sell", `{"creator":"` + c + `","tokens":"10"}`},
		{"refundHolder", `{"creator":"` + c + `","holder":"hive:f19sink"}`},
		{"closeIfDrained", `{"creator":"` + c + `"}`},
		{"withdrawTreasury", `{"amount":"1"}`},
		{"claimTradeFees", `{}`},
		{"retire", `{"creator":"` + c + `"}`},
		{"quote", `{"creator":"` + c + `"}`},
		{"quoteBuy", `{"creator":"` + c + `","tokens":"10"}`},
		{"quoteSell", `{"creator":"` + c + `","tokens":"10"}`},
		{"createOffering", `{"title":"sweep","price":25000}`},
		{"setOfferingPrice", `{"offeringId":1,"newPrice":30000}`},
		{"setOfferingTitle", `{"offeringId":1,"title":"resweep"}`},
		{"deleteOffering", `{"offeringId":1}`},
		{"listOfferings", `{"creator":"` + c + `"}`},
	}
	fns := map[string]func(*string) *string{
		"init": Init, "pause": Pause, "unpause": Unpause, "register": Register,
		"renew": Renew, "setFace": SetFace, "setCap": SetCap, "transfer": Transfer,
		"safeTransferFrom": SafeTransferFrom, "approve": ApproveAllowance,
		"graduate": GraduateMatured, "allowance": AllowanceRead,
		"balanceOf": BalanceOfMatured, "creatorTokenBalance": CreatorTokenBalance,
		"ask": Ask, "answer": Answer, "decline": Decline, "rate": Rate,
		"reclaim": Reclaim, "refund": Refund, "buy": Buy, "sell": Sell,
		"refundHolder": RefundHolder, "closeIfDrained": CloseIfDrained,
		"withdrawTreasury": WithdrawTreasury, "claimTradeFees": ClaimTradeFees,
		"retire": Retire, "quote": Quote, "quoteBuy": QuoteBuy, "quoteSell": QuoteSell,
		"createOffering": CreateOffering, "setOfferingPrice": SetOfferingPrice,
		"setOfferingTitle": SetOfferingTitle, "deleteOffering": DeleteOffering,
		"listOfferings": ListOfferings,
	}
	if len(cases) != 35 || len(fns) != 35 {
		t.Fatalf("%s: export enumeration drift: %d cases / %d fns, want 35 (the full export list minus changeOwner/acceptOwnership)", label, len(cases), len(fns))
	}

	before := f19Owner()
	for _, cs := range cases {
		p := cs.payload
		fns[cs.name](&p)
		if got := f19Owner(); got != before {
			t.Fatalf("%s: %q moved the owner key: %q -> %q (want it untouched — only changeOwner+acceptOwnership may ever move it)",
				label, cs.name, before, got)
		}
	}
	t.Logf("%s: swept %d exports, owner key untouched throughout (%q)", label, len(cases), before)
}

func TestF19_OwnerRotation_ExactlyOnePathMovesOwner(t *testing.T) {
	const deployer = "hive:f19deployer"
	const attacker = "hive:f19attacker"
	const candidate = "hive:f19candidate"
	const bystander = "hive:f19bystander"

	f19Bootstrap(deployer)
	initPayload := `{}`
	if out := Init(&initPayload); out == nil {
		t.Fatalf("Init failed: reverts=%+v aborts=%v", sdk.MockReverts, sdk.MockAborts)
	}
	if got := f19Owner(); got != deployer {
		t.Fatalf("owner after Init = %q, want %q", got, deployer)
	}

	// ---- SWEEP 1: every other export, called by a non-owner attacker.
	// This is the ORIGINAL finding's own methodology ("a sweep of 28
	// state-changing exports as a non-owner proved ZERO can move it"),
	// re-run against the fixed contract to prove the fix did not
	// accidentally open a SECOND path.
	f19SwitchCaller(attacker)
	f19Sweep(t, "sweep-as-attacker")

	// ---- SWEEP 2: same sweep, called by the LEGITIMATE owner. Even the
	// owner's OWN unrelated actions (SetFace, Register, ...) must never move
	// "owner" as a side effect — only the dedicated 2-step path may.
	f19SwitchCaller(deployer)
	f19Sweep(t, "sweep-as-owner")
	if got := f19Owner(); got != deployer {
		t.Fatalf("owner drifted during the owner-caller sweep: %q, want unchanged %q", got, deployer)
	}

	// ---- acceptOwnership with NO pending transfer: refused, nothing moves.
	f19SwitchCaller(candidate)
	acceptEmpty := `{}`
	if out := AcceptOwnership(&acceptEmpty); out != nil {
		t.Fatalf("acceptOwnership with no pending transfer succeeded: %v", *out)
	}
	if len(sdk.MockReverts) == 0 || sdk.MockReverts[len(sdk.MockReverts)-1].Symbol != "STATE" {
		t.Fatalf("acceptOwnership with no pending transfer: want a STATE revert, got %+v", sdk.MockReverts)
	}
	if got := f19Owner(); got != deployer {
		t.Fatalf("owner moved by a no-op acceptOwnership call: %q", got)
	}

	// ---- changeOwner (PROPOSE), called by a non-owner: refused.
	f19SwitchCaller(attacker)
	proposeByAttacker := `{"newOwner":"` + attacker + `"}`
	if out := ChangeOwner(&proposeByAttacker); out != nil {
		t.Fatalf("changeOwner by a non-owner succeeded: %v", *out)
	}
	if got := f19PendingOwner(); got != "" {
		t.Fatalf("non-owner changeOwner set a pending owner: %q", got)
	}

	// ---- changeOwner (PROPOSE), called by the real owner: this is THE
	// path. Ownership must NOT move yet — propose only.
	f19SwitchCaller(deployer)
	propose := `{"newOwner":"` + candidate + `"}`
	out := ChangeOwner(&propose)
	if out == nil {
		t.Fatalf("legitimate changeOwner failed: reverts=%+v", sdk.MockReverts)
	}
	if got := f19Owner(); got != deployer {
		t.Fatalf("owner moved by changeOwner alone (propose-only step): %q, want still %q", got, deployer)
	}
	if got := f19PendingOwner(); got != candidate {
		t.Fatalf("pendingOwner = %q, want %q", got, candidate)
	}
	t.Logf("changeOwner (propose) ok: %s", *out)

	// ---- acceptOwnership called by the WRONG account (not the candidate):
	// refused, nothing moves — proves a bystander cannot hijack a pending
	// transfer meant for someone else.
	f19SwitchCaller(bystander)
	acceptWrong := `{}`
	if out := AcceptOwnership(&acceptWrong); out != nil {
		t.Fatalf("acceptOwnership by a non-candidate account succeeded: %v", *out)
	}
	if got := f19Owner(); got != deployer {
		t.Fatalf("owner moved by a wrong-account acceptOwnership: %q", got)
	}
	if got := f19PendingOwner(); got != candidate {
		t.Fatalf("pendingOwner cleared/changed by a refused accept: %q, want still %q", got, candidate)
	}

	// ---- acceptOwnership (ACCEPT), called by the real candidate: THIS is
	// the only line, anywhere, that may move "owner" after Init.
	f19SwitchCaller(candidate)
	accept := `{}`
	out = AcceptOwnership(&accept)
	if out == nil {
		t.Fatalf("legitimate acceptOwnership failed: reverts=%+v", sdk.MockReverts)
	}
	if got := f19Owner(); got != candidate {
		t.Fatalf("owner after acceptOwnership = %q, want %q", got, candidate)
	}
	if got := f19PendingOwner(); got != "" {
		t.Fatalf("pendingOwner not cleared after acceptance: %q", got)
	}
	t.Logf("acceptOwnership (accept) ok: %s — owner is now %q", *out, f19Owner())

	// ---- THE NEW OWNER WORKS. Exercise a real owner-gated export
	// (pause) as the candidate and confirm it succeeds.
	f19SwitchCaller(candidate)
	pausePayload := `{}`
	if out := Pause(&pausePayload); out == nil {
		t.Fatalf("new owner's Pause call failed: reverts=%+v", sdk.MockReverts)
	}
	t.Logf("new owner (%s) can Pause: ok", candidate)
	// Unpause again so the rest of this test's calls aren't blocked by it.
	unpausePayload := `{}`
	if out := Unpause(&unpausePayload); out == nil {
		t.Fatalf("new owner's Unpause call failed: reverts=%+v", sdk.MockReverts)
	}

	// ---- THE OLD OWNER IS REFUSED. The deployer, who legitimately signed
	// away ownership, can no longer exercise owner-only capability.
	f19SwitchCaller(deployer)
	pauseByOldOwner := `{}`
	if out := Pause(&pauseByOldOwner); out != nil {
		t.Fatalf("OLD owner's Pause call succeeded after rotation: %v — the old key must be refused", *out)
	}
	if sym := sdk.MockReverts[len(sdk.MockReverts)-1].Symbol; sym != "AUTH" {
		t.Fatalf("old owner's refused Pause: want AUTH revert, got %+v", sdk.MockReverts)
	}
	t.Logf("old owner (%s) correctly refused: %+v", deployer, sdk.MockReverts[len(sdk.MockReverts)-1])

	// ---- FINAL SWEEP: with rotation complete, re-run the full 35-export
	// sweep as the OLD owner (now a bystander) and as an unrelated attacker,
	// proving the key stays put at its new value under continued pressure.
	f19SwitchCaller(deployer)
	f19Sweep(t, "post-rotation sweep-as-old-owner")
	f19SwitchCaller(attacker)
	f19Sweep(t, "post-rotation sweep-as-attacker")
	if got := f19Owner(); got != candidate {
		t.Fatalf("owner drifted after the fix's full lifecycle: %q, want %q", got, candidate)
	}
}
