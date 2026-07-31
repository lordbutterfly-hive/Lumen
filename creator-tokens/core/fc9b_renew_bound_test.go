package core

import (
	"os"
	"strings"
	"testing"
)

// fc9b_renew_bound_test.go — source-derived guard for the Renew wrapper's
// int64/positivity bound on the raw `paid` payload amount (F-C9, item 9b).
//
// WHY A SOURCE TEST: the guard lives in ../contract/main.go, which imports the
// wasm-only ../runtime and cannot be built by the native toolchain (see
// payee_address_test.go for the same idiom). So this asserts the wiring by
// reading the source — exactly the class of check that would catch the omission.
//
// THE DEFECT THIS GUARDS: Renew pulls HBD via `sdk.HiveDraw(nativeInt64(paid))`,
// where `paid` is a caller-supplied payload amount. nativeInt64 ABORTS (a
// host-level crash, not a recoverable rejection) on an int64 overflow, and a
// non-positive `paid` would attempt a ≤0 draw. The fix rejects both with a clean
// typed inputErr BEFORE the draw, mirroring Buy's shipped BUY-INT64 guard.
func TestContract_FC9B_RenewPaidBoundedBeforeDraw(t *testing.T) {
	src, err := os.ReadFile("../contract/main.go")
	if err != nil {
		t.Fatalf("read contract/main.go: %v", err)
	}
	text := string(src)

	ri := strings.Index(text, "func Renew(a *string) *string")
	if ri < 0 {
		t.Fatal("F-C9b REGRESSION: contract/main.go has no Renew wasmexport — this test's premise is broken, fix it rather than deleting it")
	}
	// Scope the search to the Renew body: from its declaration to the next
	// top-level func so a guard in some other entrypoint can't satisfy this.
	body := text[ri:]
	if next := strings.Index(body[1:], "\nfunc "); next >= 0 {
		body = body[:next+1]
	}

	guard := body
	gi := strings.Index(guard, "paid.Sign() <= 0 || !paid.IsInt64()")
	if gi < 0 {
		t.Fatal("F-C9b REGRESSION: Renew no longer rejects a non-positive or int64-overflowing `paid` before drawing — an overflowing amount hits nativeInt64's hard Abort and a ≤0 amount attempts a negative HiveDraw")
	}
	di := strings.Index(guard, "sdk.HiveDraw(nativeInt64(paid)")
	if di < 0 {
		t.Fatal("F-C9b REGRESSION: Renew's `paid` HiveDraw call moved or changed shape — re-verify this pin against the new draw")
	}
	if gi >= di {
		t.Fatal("F-C9b REGRESSION: the `paid` bound must run BEFORE the HiveDraw — a guard placed after the pull cannot stop the overflow Abort or the ≤0 draw")
	}
}
