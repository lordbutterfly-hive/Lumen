package settler

import (
	"strings"
	"testing"

	"github.com/vsc-eco/hivego"
	"hive-price-market/scheduler"
)

// The posting-key authority check is the difference between a settler that
// refuses to start and one that looks healthy while silently never settling
// anything. It is pure, so it is testable without a network — and it must stay
// that way.

func acct(name string, keyAuths [][]interface{}, threshold int) hivego.AccountData {
	return hivego.AccountData{
		Name:    name,
		Posting: hivego.Authority{KeyAuths: keyAuths, WeightThreshold: threshold},
	}
}

func TestPostingKeyCheck_AcceptsAKeyThatIsOnTheAccount(t *testing.T) {
	a := acct("bot", [][]interface{}{{"STM_GOOD", float64(1)}}, 1)
	if err := assertPostingKeyBelongsTo(a, "STM_GOOD"); err != nil {
		t.Fatalf("a key present on the account with sufficient weight must be accepted, got: %v", err)
	}
}

func TestPostingKeyCheck_RejectsAKeyFromAnotherAccount(t *testing.T) {
	// The dangerous case: a valid WIF that simply is not this account's. Every
	// transaction it signs is rejected by Hive, forever, with nothing in our own
	// logs to explain why.
	a := acct("bot", [][]interface{}{{"STM_THEIRS", float64(1)}}, 1)
	err := assertPostingKeyBelongsTo(a, "STM_MINE")
	if err == nil {
		t.Fatal("a key absent from the account's posting authority MUST be refused at startup")
	}
	if !strings.Contains(err.Error(), "NOT a posting key") {
		t.Fatalf("the refusal must say plainly what is wrong, got: %v", err)
	}
}

func TestPostingKeyCheck_RejectsMultisigItCannotSatisfyAlone(t *testing.T) {
	// Present, but weight 1 against a threshold of 2: this bot signs alone and
	// can never produce a valid signature. Caught at boot, not mid-round.
	a := acct("bot", [][]interface{}{{"STM_GOOD", float64(1)}, {"STM_OTHER", float64(1)}}, 2)
	err := assertPostingKeyBelongsTo(a, "STM_GOOD")
	if err == nil {
		t.Fatal("a multisig posting authority this key cannot satisfy alone MUST be refused")
	}
	if !strings.Contains(err.Error(), "MULTISIG") {
		t.Fatalf("the refusal must name the real reason, got: %v", err)
	}
}

func TestPostingKeyCheck_SurvivesMalformedKeyAuthRows(t *testing.T) {
	// key_auths is [][]interface{} off the wire. A short or wrongly-typed row
	// must be skipped, not panic — a node returning something unexpected should
	// not take the process down.
	a := acct("bot", [][]interface{}{
		{},                           // empty
		{"STM_GOOD"},                 // missing weight
		{float64(1), "STM_GOOD"},     // reversed
		{"STM_GOOD", "not-a-number"}, // weight not numeric
	}, 1)
	// The last row matches the key but has a non-numeric weight, so weight stays
	// 0 and the threshold check refuses. The point of this test is that it
	// RETURNS rather than panics.
	if err := assertPostingKeyBelongsTo(a, "STM_GOOD"); err == nil {
		t.Fatal("a matching key with an unreadable weight must not be treated as sufficient")
	}
}

// Broadcast's guards: it signs with a POSTING key, so anything arriving that
// wants active authority, or that names another account, must be refused rather
// than signed. These run without a network because they reject before any call.

func TestBroadcast_RefusesAnOpWantingActiveAuthority(t *testing.T) {
	h := &HiveBroadcaster{Node: "n", Account: "bot", postingWif: "x", rpc: hivego.NewHiveRpc([]string{"http://127.0.0.1:9"})}
	_, err := h.Broadcast(scheduler.CustomJSON{
		ID:                   "vsc.call",
		RequiredAuths:        []string{"bot"},
		RequiredPostingAuths: []string{},
	})
	if err == nil || !strings.Contains(err.Error(), "ACTIVE authority") {
		t.Fatalf("an active-auth op must be refused, not signed with a posting key; got %v", err)
	}
}

func TestBroadcast_RefusesSigningForAnotherAccount(t *testing.T) {
	h := &HiveBroadcaster{Node: "n", Account: "bot", postingWif: "x", rpc: hivego.NewHiveRpc([]string{"http://127.0.0.1:9"})}
	_, err := h.Broadcast(scheduler.CustomJSON{
		ID:                   "vsc.call",
		RequiredPostingAuths: []string{"hive:someone-else"},
	})
	if err == nil || !strings.Contains(err.Error(), "another account") {
		t.Fatalf("an op authorised for a different account must be refused; got %v", err)
	}
}

func TestBroadcast_AcceptsTheHivePrefixedFormOfItsOwnAccount(t *testing.T) {
	// The scheduler builds auths from a "hive:name" caller; the Hive protocol
	// wants the bare name. Both spellings must compare equal or every op would
	// be refused as belonging to a stranger.
	h := &HiveBroadcaster{Node: "n", Account: "bot", postingWif: "x", rpc: hivego.NewHiveRpc([]string{"http://127.0.0.1:9"})}
	_, err := h.Broadcast(scheduler.CustomJSON{
		ID:                   "vsc.call",
		RequiredPostingAuths: []string{"hive:bot"},
	})
	// It gets past the guards and fails at the network, which is the proof: the
	// error must NOT be one of the refusals.
	if err != nil && (strings.Contains(err.Error(), "another account") || strings.Contains(err.Error(), "ACTIVE authority")) {
		t.Fatalf("hive:bot and bot must be treated as the same account; got %v", err)
	}
}

func TestScrubKey_RemovesTheKeyFromAnyErrorText(t *testing.T) {
	const wif = "5KSuperSecretKeyMaterial"
	got := scrubKey("node said: bad signature for "+wif+" at height 1", wif)
	if strings.Contains(got, wif) {
		t.Fatalf("the signing key must never survive into text we log or return: %q", got)
	}
	if !strings.Contains(got, "[REDACTED]") {
		t.Fatalf("expected a redaction marker, got %q", got)
	}
	// An empty key must not turn every string into a redaction.
	if scrubKey("untouched", "") != "untouched" {
		t.Fatal("an empty key must leave the text alone")
	}
}
