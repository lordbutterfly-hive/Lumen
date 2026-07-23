package scheduler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"hive-price-market/market"
)

// StateReader reads a single contract state key, mirroring market.Store's
// own (value, found) shape — read via VSC's getStateByKeys GraphQL query,
// never a broadcast, never a state write.
type StateReader interface {
	Get(contractID, key string) (string, bool, error)
}

// MockStateReader is a StateReader test/dry-run double: a plain key→value
// map (missing key ⇒ not found), directly settable to simulate on-chain
// state, e.g. state["active|hive"] = "1".
type MockStateReader map[string]string

func (m MockStateReader) Get(_ string, key string) (string, bool, error) {
	v, ok := m[key]
	return v, ok, nil
}

// IsRoundOpen mirrors market/create.go:76-88's own one-open-round-per-asset
// guard EXACTLY (kActiveRound(asset) → rd|<id>|state, market/keys.go:26,29),
// so the scheduler never wastes a broadcast attempting a createRound the
// contract would itself reject with STATE "an open round already exists for
// this asset".
//
// COUPLING WARNING (same caveat contract/main.go's roundAsset carries): this
// duplicates market/keys.go's key format outside the market package; keep in
// sync if that format ever changes.
func IsRoundOpen(r StateReader, contractID, asset string) (open bool, roundID uint64, err error) {
	activeRaw, ok, err := r.Get(contractID, "active|"+asset)
	if err != nil {
		return false, 0, fmt.Errorf("scheduler: read active|%s: %w", asset, err)
	}
	if !ok || activeRaw == "" || activeRaw == "0" {
		return false, 0, nil // 0 (or unset) = no round ever created for this asset
	}
	activePlusOne, err := strconv.ParseUint(activeRaw, 10, 64)
	if err != nil {
		return false, 0, fmt.Errorf("scheduler: active|%s = %q is not a valid uint64", asset, activeRaw)
	}
	id := activePlusOne - 1 // kActiveRound stores id+1 (market/create.go:117)
	stateVal, ok, err := r.Get(contractID, "rd|"+strconv.FormatUint(id, 10)+"|state")
	if err != nil {
		return false, 0, fmt.Errorf("scheduler: read rd|%d|state: %w", id, err)
	}
	if !ok {
		return false, 0, nil
	}
	return stateVal == market.StateOpen, id, nil
}

// ReadRoundSchedule reads one round's keeper-relevant fields FRESH off
// StateReader — state/asset/settle/grace (market/keys.go's rk(id,...) format,
// same coupling caveat IsRoundOpen above carries) — so a settle-keeper poll
// never relies on a schedule computed or cached by an earlier cycle: a
// crashed-and-restarted keeper, or two independent keeper processes racing
// each other, always re-derive an identical decision from the same on-chain
// truth (statelessness / crash-safety). found=false only when the round has
// never been created (no rd|<id>|state key at all); a since-resolved round
// is still "found" — State reads "settled"/"void" and
// DecideKeeperAction correctly treats that as nothing-to-do.
func ReadRoundSchedule(r StateReader, contractID string, id uint64) (RoundSchedule, bool, error) {
	idStr := strconv.FormatUint(id, 10)
	state, ok, err := r.Get(contractID, "rd|"+idStr+"|state")
	if err != nil {
		return RoundSchedule{}, false, fmt.Errorf("scheduler: read rd|%d|state: %w", id, err)
	}
	if !ok || state == "" {
		return RoundSchedule{}, false, nil
	}
	asset, _, err := r.Get(contractID, "rd|"+idStr+"|asset")
	if err != nil {
		return RoundSchedule{}, false, fmt.Errorf("scheduler: read rd|%d|asset: %w", id, err)
	}
	settleRaw, _, err := r.Get(contractID, "rd|"+idStr+"|settle")
	if err != nil {
		return RoundSchedule{}, false, fmt.Errorf("scheduler: read rd|%d|settle: %w", id, err)
	}
	settleBlock, err := strconv.ParseUint(settleRaw, 10, 64)
	if err != nil {
		return RoundSchedule{}, false, fmt.Errorf("scheduler: rd|%d|settle = %q is not a valid uint64: %w", id, settleRaw, err)
	}
	graceRaw, _, err := r.Get(contractID, "rd|"+idStr+"|grace")
	if err != nil {
		return RoundSchedule{}, false, fmt.Errorf("scheduler: read rd|%d|grace: %w", id, err)
	}
	graceBlocks, err := strconv.ParseUint(graceRaw, 10, 64)
	if err != nil {
		return RoundSchedule{}, false, fmt.Errorf("scheduler: rd|%d|grace = %q is not a valid uint64: %w", id, graceRaw, err)
	}
	return RoundSchedule{ID: id, Asset: asset, State: state, SettleBlock: settleBlock, GraceBlocks: graceBlocks}, true, nil
}

// ReadActiveRoundSchedule combines the active-round-pointer lookup with
// ReadRoundSchedule so a settle-keeper poll can go straight from "asset" to
// "the latest round's fresh schedule" in one call, every cycle — this is
// what the keeper loop uses instead of being handed a cached round list
// (statelessness). found=false when no round has ever been created for
// asset; the returned schedule may be OPEN, SETTLED, or VOID — the caller
// (DecideKeeperAction) is responsible for no-op'ing on a non-OPEN round.
func ReadActiveRoundSchedule(r StateReader, contractID, asset string) (RoundSchedule, bool, error) {
	activeRaw, ok, err := r.Get(contractID, "active|"+asset)
	if err != nil {
		return RoundSchedule{}, false, fmt.Errorf("scheduler: read active|%s: %w", asset, err)
	}
	if !ok || activeRaw == "" || activeRaw == "0" {
		return RoundSchedule{}, false, nil // 0 (or unset) = no round ever created for this asset
	}
	activePlusOne, err := strconv.ParseUint(activeRaw, 10, 64)
	if err != nil {
		return RoundSchedule{}, false, fmt.Errorf("scheduler: active|%s = %q is not a valid uint64: %w", asset, activeRaw, err)
	}
	return ReadRoundSchedule(r, contractID, activePlusOne-1)
}

const getStateByKeysQuery = `query GetState($contractId: String!, $keys: [String!]!) {
  getStateByKeys(contractId: $contractId, keys: $keys)
}`

// GQLStateReader is the REAL StateReader, backed by a live VSC GraphQL
// endpoint's getStateByKeys query (schema verified against
// ~/go-vsc-node/modules/gql/schema.graphql:809-820, read 2026-07-19: `Map`
// scalar = "arbitrary key-value map, serialized as a JSON object",
// schema.graphql:16-19). Pure stdlib (net/http + encoding/json); exercised
// end-to-end in state_test.go against an httptest.Server returning the exact
// schema shape.
type GQLStateReader struct {
	Endpoint   string
	HTTPClient *http.Client
}

func (g *GQLStateReader) httpClient() *http.Client {
	if g.HTTPClient != nil {
		return g.HTTPClient
	}
	return http.DefaultClient
}

func (g *GQLStateReader) Get(contractID, key string) (string, bool, error) {
	reqBody := gqlRequest{
		Query: getStateByKeysQuery,
		Variables: map[string]interface{}{
			"contractId": contractID,
			"keys":       []string{key},
		},
	}
	body, err := json.Marshal(reqBody)
	if err != nil {
		return "", false, fmt.Errorf("scheduler: encode getStateByKeys query: %w", err)
	}
	httpReq, err := http.NewRequest(http.MethodPost, g.Endpoint, bytes.NewReader(body))
	if err != nil {
		return "", false, fmt.Errorf("scheduler: build getStateByKeys request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := g.httpClient().Do(httpReq)
	if err != nil {
		return "", false, fmt.Errorf("scheduler: getStateByKeys request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", false, fmt.Errorf("scheduler: getStateByKeys HTTP %d", resp.StatusCode)
	}

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", false, fmt.Errorf("scheduler: read getStateByKeys response: %w", err)
	}

	var errEnv gqlErrorEnvelope
	if err := json.Unmarshal(respBytes, &errEnv); err == nil && len(errEnv.Errors) > 0 {
		return "", false, fmt.Errorf("scheduler: GraphQL error: %s", errEnv.Errors[0].Message)
	}

	var gqlResp struct {
		Data struct {
			GetStateByKeys map[string]interface{} `json:"getStateByKeys"`
		} `json:"data"`
	}
	if err := json.Unmarshal(respBytes, &gqlResp); err != nil {
		return "", false, fmt.Errorf("scheduler: decode getStateByKeys response: %w", err)
	}
	v, ok := gqlResp.Data.GetStateByKeys[key]
	if !ok || v == nil {
		return "", false, nil
	}
	if s, ok := v.(string); ok {
		return s, true, nil
	}
	return fmt.Sprint(v), true, nil
}
