package scheduler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// PriceSource reads the live oracle price the contract will settle
// against — exposed READ-ONLY via the contract's own peekPrice action
// (contract/main.go:500-517, DUMB-QUESTIONS-RESOLVED B5) through VSC's
// simulateContractCalls GraphQL query. No broadcast, no fee, no state write.
type PriceSource interface {
	// Peek returns the live HBD/HIVE feed price in bps (10000=1.0,
	// market.SettleUnit), the pendulum's last-recorded tick_block_height, and
	// whether the feed is currently healthy. tick/feedOK mirror EXACTLY what
	// contract/main.go's Settle handler reads fresh at execution time
	// (pendulum.tick_block_height, hive_ma_ok && trusted_hive_mean_ok,
	// main.go:473-475) — the settle keeper (keeper.go's DecideKeeperAction)
	// uses both to target the narrow ~100-block qualifying-tick window
	// (market.MaxSettleTickLag) instead of firing settle blindly on every
	// poll once block>=settleBlock.
	Peek() (priceBps uint64, tick uint64, feedOK bool, err error)
}

// FixedPriceSource is a PriceSource test/dry-run double that always returns a
// configured price/tick/health, or a configured error.
type FixedPriceSource struct {
	PriceBps uint64
	Tick     uint64
	FeedOK   bool
	Err      error
}

func (f FixedPriceSource) Peek() (uint64, uint64, bool, error) {
	if f.Err != nil {
		return 0, 0, false, f.Err
	}
	return f.PriceBps, f.Tick, f.FeedOK, nil
}

// gqlRequest is the standard GraphQL-over-HTTP request envelope, shared by
// every real (GQL-backed) client in this package.
type gqlRequest struct {
	Query     string                 `json:"query"`
	Variables map[string]interface{} `json:"variables"`
}

type gqlErrorEnvelope struct {
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

// simulateCallInput mirrors go-vsc-node's SimulateContractCallInput
// (modules/gql/schema.graphql:757-771, verified 2026-07-19): {contract_id,
// action, payload, rc_limit, intents}. rc_limit is the Uint64 scalar, which
// the schema documents as "serialized as a string to avoid precision loss"
// (schema.graphql:6-9) — so it MUST be sent as a JSON string, not a number.
type simulateCallInput struct {
	ContractID string   `json:"contract_id"`
	Action     string   `json:"action"`
	Payload    string   `json:"payload"`
	RCLimit    string   `json:"rc_limit"`
	Intents    []Intent `json:"intents"`
}

const peekPriceQuery = `query Peek($input: SimulateContractCallsInput!) {
  simulateContractCalls(input: $input) {
    success
    err
    err_msg
    ret
  }
}`

// GQLPriceSource is the REAL PriceSource, backed by a live VSC GraphQL
// endpoint's simulateContractCalls query (schema verified against
// ~/go-vsc-node/modules/gql/schema.graphql:757-807,998-1004, read
// 2026-07-19; endpoint route confirmed at modules/gql/gql.go:63,
// "POST /api/v1/graphql"). It is pure stdlib (net/http + encoding/json) and
// is exercised end-to-end in price_test.go against an httptest.Server
// returning the exact schema shape — the HTTP/JSON plumbing is genuinely
// tested, not stubbed. What's untested (E1: not deployed) is a live endpoint
// with a real contract behind it.
//
// Known testnet endpoints (reference_magi_testnet_endpoints, 2026-07):
//
//	https://magi-test.techcoderx.com/api/v1/graphql   (magi.test1)
//	https://testnet.magi.milohpr.com/api/v1/graphql   (milo.magi)
type GQLPriceSource struct {
	Endpoint   string
	ContractID string
	RCLimit    uint64 // rc_limit for the simulated call; peekPrice writes no state, so any small value works. Defaults to 1000.
	HTTPClient *http.Client

	// TxIDFunc optionally supplies the simulation's tx_id
	// (SimulateContractCallsInput.tx_id is a required, non-empty String! —
	// schema.graphql:778 — its exact semantics beyond "simulation context"
	// are undocumented pre-deploy). Defaults to a timestamp-based
	// placeholder; tests inject a deterministic value.
	TxIDFunc func() string
}

func (g *GQLPriceSource) httpClient() *http.Client {
	if g.HTTPClient != nil {
		return g.HTTPClient
	}
	return http.DefaultClient
}

func (g *GQLPriceSource) txID() string {
	if g.TxIDFunc != nil {
		return g.TxIDFunc()
	}
	return "scheduler-peek-" + strconv.FormatInt(time.Now().UnixNano(), 10)
}

func (g *GQLPriceSource) rcLimit() uint64 {
	if g.RCLimit != 0 {
		return g.RCLimit
	}
	return 1000
}

func (g *GQLPriceSource) Peek() (uint64, uint64, bool, error) {
	reqBody := gqlRequest{
		Query: peekPriceQuery,
		Variables: map[string]interface{}{
			"input": map[string]interface{}{
				"tx_id":                  g.txID(),
				"required_auths":         []string{},
				"required_posting_auths": []string{},
				"calls": []simulateCallInput{{
					ContractID: g.ContractID,
					Action:     "peekPrice",
					Payload:    "{}",
					RCLimit:    strconv.FormatUint(g.rcLimit(), 10),
					Intents:    []Intent{},
				}},
			},
		},
	}
	body, err := json.Marshal(reqBody)
	if err != nil {
		return 0, 0, false, fmt.Errorf("scheduler: encode peekPrice query: %w", err)
	}
	httpReq, err := http.NewRequest(http.MethodPost, g.Endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, 0, false, fmt.Errorf("scheduler: build peekPrice request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := g.httpClient().Do(httpReq)
	if err != nil {
		return 0, 0, false, fmt.Errorf("scheduler: peekPrice request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, 0, false, fmt.Errorf("scheduler: peekPrice HTTP %d", resp.StatusCode)
	}

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, 0, false, fmt.Errorf("scheduler: read peekPrice response: %w", err)
	}

	var errEnv gqlErrorEnvelope
	if err := json.Unmarshal(respBytes, &errEnv); err == nil && len(errEnv.Errors) > 0 {
		return 0, 0, false, fmt.Errorf("scheduler: GraphQL error: %s", errEnv.Errors[0].Message)
	}

	var gqlResp struct {
		Data struct {
			SimulateContractCalls []struct {
				Success bool    `json:"success"`
				Err     *string `json:"err"`
				ErrMsg  *string `json:"err_msg"`
				Ret     *string `json:"ret"`
			} `json:"simulateContractCalls"`
		} `json:"data"`
	}
	if err := json.Unmarshal(respBytes, &gqlResp); err != nil {
		return 0, 0, false, fmt.Errorf("scheduler: decode peekPrice response: %w", err)
	}
	if len(gqlResp.Data.SimulateContractCalls) != 1 {
		return 0, 0, false, fmt.Errorf("scheduler: expected 1 simulateContractCalls result, got %d", len(gqlResp.Data.SimulateContractCalls))
	}
	result := gqlResp.Data.SimulateContractCalls[0]
	if !result.Success {
		msg := "unknown error"
		if result.ErrMsg != nil {
			msg = *result.ErrMsg
		} else if result.Err != nil {
			msg = *result.Err
		}
		return 0, 0, false, fmt.Errorf("scheduler: peekPrice call failed: %s", msg)
	}
	if result.Ret == nil {
		return 0, 0, false, fmt.Errorf("scheduler: peekPrice returned no ret payload")
	}

	// Parses contract/main.go:516's exact PeekPrice response shape:
	// {"priceBps":u64,"tick":u64,"feedOK":bool,"unit":"HBD/HIVE"}.
	var ret struct {
		PriceBps uint64 `json:"priceBps"`
		Tick     uint64 `json:"tick"`
		FeedOK   bool   `json:"feedOK"`
		Unit     string `json:"unit"`
	}
	if err := json.Unmarshal([]byte(*result.Ret), &ret); err != nil {
		return 0, 0, false, fmt.Errorf("scheduler: parse peekPrice ret %q: %w", *result.Ret, err)
	}
	return ret.PriceBps, ret.Tick, ret.FeedOK, nil
}
