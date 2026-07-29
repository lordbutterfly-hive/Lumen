// Package settler is the off-chain process that opens and resolves
// prediction-market rounds.
//
// WHY IT EXISTS. Magi has no on-chain scheduler: a contract cannot wake itself
// up. A round must be opened by someone sending `roll`, and resolved by someone
// sending `settle`. Both are PERMISSIONLESS and the outcome is fixed by the
// schedule — `settle` pins the price to the first oracle tick at or after the
// settle block, so whoever calls it cannot influence the result or pick a
// favourable moment. Nothing here is trusted; this process is a courier.
//
// If it stops, nothing is lost: a round left unsettled past its window VOIDs and
// every staker is refunded, and any staker can force that themselves with
// `reclaim`. That is the whole reason a bot is the right answer rather than a
// consensus-level scheduler — the failure mode is a refund, not a halt.
//
// WHY A SEPARATE MODULE from the contract: see go.mod. In short, hivego needs
// Go >= 1.24 and the parent module builds a wasm contract with TinyGo on a
// deliberately conservative toolchain. Keeping them apart means a dependency of
// the bot can never break the build of the contract.
package settler

import (
	"fmt"
	"strings"

	"github.com/vsc-eco/hivego"
	"hive-price-market/scheduler"
)

// HiveBroadcaster is the REAL scheduler.Broadcaster: it signs a `vsc.call`
// custom_json with the bot's Hive posting key and broadcasts it to Hive L1.
//
// POSTING KEY, NOT ACTIVE. Every op this bot sends — roll, settle, voidStale —
// carries no `transfer.allow` intent and moves none of the bot's own money, so
// posting authority is sufficient. That is deliberate and worth preserving: the
// key this process holds should be worthless if stolen. Do not "upgrade" it to
// an active key to make something else work.
type HiveBroadcaster struct {
	// Node is a Hive L1 RPC endpoint (e.g. https://api.hive.blog).
	Node string
	// Account is the bot's own Hive account, bare (no "hive:" prefix).
	Account string
	// postingWif is the signing key. Unexported and never logged, never
	// included in an error message, never printed by String().
	postingWif string

	rpc *hivego.HiveRpcNode
}

// NewHiveBroadcaster constructs a broadcaster and PROVES, before returning, that
// the supplied key is actually a posting key of the named account.
//
// WHY THE BOOT CHECK. Without it, a wrong key is discovered at the worst possible
// moment: mid-cycle, as an opaque signature rejection, after the round has
// already drifted past its window. Worse, a key belonging to a DIFFERENT account
// would sign happily and produce transactions Hive rejects forever, silently.
// Failing at construction turns a permanent operational mystery into a startup
// error. Same discipline as the lite publisher's own boot assertions.
func NewHiveBroadcaster(node, account, postingWif string) (*HiveBroadcaster, error) {
	account = strings.TrimPrefix(account, "hive:")
	if node == "" {
		return nil, fmt.Errorf("settler: no Hive RPC node configured")
	}
	if account == "" {
		return nil, fmt.Errorf("settler: no Hive account configured")
	}
	if postingWif == "" {
		return nil, fmt.Errorf("settler: no posting key configured")
	}

	kp, err := hivego.KeyPairFromWif(postingWif)
	if err != nil {
		// Deliberately does NOT echo the key or any part of it. hivego's own
		// error text is about WIF decoding and carries no secret, but wrapping
		// it keeps that guarantee local rather than depending on a dependency.
		return nil, fmt.Errorf("settler: posting key is not a valid WIF")
	}
	pub := kp.GetPublicKeyString()
	if pub == nil {
		return nil, fmt.Errorf("settler: could not derive a public key from the posting key")
	}

	rpc := hivego.NewHiveRpc([]string{node})
	accounts, err := rpc.GetAccount([]string{account})
	if err != nil {
		return nil, fmt.Errorf("settler: could not read account %q to verify the posting key: %w", account, err)
	}
	if len(accounts) == 0 {
		return nil, fmt.Errorf("settler: account %q does not exist on this chain", account)
	}

	if err := assertPostingKeyBelongsTo(accounts[0], *pub); err != nil {
		return nil, err
	}

	return &HiveBroadcaster{Node: node, Account: account, postingWif: postingWif, rpc: rpc}, nil
}

// assertPostingKeyBelongsTo checks the derived public key against the account's
// posting authority, and refuses a multisig posting authority outright.
//
// A multisig posting authority (threshold above the single key's weight) would
// mean this bot alone can never produce a valid signature. Detecting that here
// rather than at broadcast time is the difference between "won't start" and
// "appears healthy and silently never settles anything".
func assertPostingKeyBelongsTo(acct hivego.AccountData, pub string) error {
	// key_auths is [][]interface{} of [publicKey, weight] pairs — Hive's wire
	// shape, so it needs unpacking defensively rather than by index alone.
	var weight float64
	found := false
	for _, pair := range acct.Posting.KeyAuths {
		if len(pair) < 2 {
			continue
		}
		key, ok := pair[0].(string)
		if !ok || key != pub {
			continue
		}
		found = true
		// JSON numbers decode to float64 through interface{}.
		if w, ok := pair[1].(float64); ok {
			weight = w
		}
		break
	}
	if !found {
		return fmt.Errorf(
			"settler: the configured key is NOT a posting key of @%s — refusing to start. "+
				"Every transaction it signed would be rejected by Hive, and the round would silently never settle",
			acct.Name)
	}
	if int(weight) < acct.Posting.WeightThreshold {
		return fmt.Errorf(
			"settler: @%s has a MULTISIG posting authority (this key's weight %d < threshold %d) — "+
				"this bot signs alone and can never satisfy it. Use an account whose posting key signs by itself",
			acct.Name, int(weight), acct.Posting.WeightThreshold)
	}
	return nil
}

// Broadcast signs and submits one op, returning the Hive transaction id.
//
// The op is built entirely by the parent scheduler package (scheduler/ops.go);
// this function adds a signature and a network call and NOTHING else. It does
// not rewrite auths, does not retry, and does not swallow errors: a failed
// broadcast is returned to the caller, whose next poll re-reads chain state and
// decides again from scratch. That statelessness is what makes a crashed or
// double-running settler harmless.
func (h *HiveBroadcaster) Broadcast(op scheduler.CustomJSON) (string, error) {
	if h.rpc == nil {
		return "", fmt.Errorf("settler: broadcaster was not constructed via NewHiveBroadcaster")
	}
	// A guard, not a repair: the ops this bot sends must carry posting auth and
	// only ever the bot's own account. If a future op arrives wanting active
	// authority, refuse it here rather than signing something with a key that
	// cannot authorise it — and never silently move it to the other auth list.
	if len(op.RequiredAuths) > 0 {
		return "", fmt.Errorf(
			"settler: op %q requires ACTIVE authority, which this bot deliberately does not hold — "+
				"see HiveBroadcaster's doc before changing this", op.ID)
	}
	if len(op.RequiredPostingAuths) != 1 {
		return "", fmt.Errorf("settler: op %q must carry exactly one posting auth, got %d",
			op.ID, len(op.RequiredPostingAuths))
	}
	if signer := strings.TrimPrefix(op.RequiredPostingAuths[0], "hive:"); signer != h.Account {
		return "", fmt.Errorf(
			"settler: op is authorised for @%s but this bot signs as @%s — refusing rather than signing for another account",
			signer, h.Account)
	}

	wif := h.postingWif
	txID, err := h.rpc.BroadcastJson(op.RequiredAuths, op.RequiredPostingAuths, op.ID, op.JSON, &wif)
	if err != nil {
		// hivego surfaces the node's own message. It describes the op, never the
		// key, but scrub defensively: an error path is exactly where secrets leak.
		return "", fmt.Errorf("settler: broadcast failed: %s", scrubKey(err.Error(), h.postingWif))
	}
	return txID, nil
}

// scrubKey removes the signing key from any string about to be logged or
// returned. Cheap, and this is the one code path where it matters.
func scrubKey(s, wif string) string {
	if wif == "" {
		return s
	}
	return strings.ReplaceAll(s, wif, "[REDACTED]")
}
