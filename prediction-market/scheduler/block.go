package scheduler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// BlockSource reads the CURRENT Hive L1 block height — the same clock
// settle()/voidStale() gate on via env "block.height" (contract/main.go's
// currentBlock(), read at execution time). This is the fund-safety-critical
// signal for the settle keeper: DecideKeeperAction (keeper.go) uses it,
// never the oracle tick, for every liveness boundary (has settleBlock been
// reached; has the outer settle window + grace fully lapsed) — because the
// oracle tick can freeze indefinitely if the pendulum feed itself goes fully
// dark (see keeper.go's doc), and the keeper's ultimate backstop (a bare
// settle() call always resolves a round once the outer window has passed,
// per DEPLOY-RUNBOOK's "Keeper note") must never depend on oracle health.
type BlockSource interface {
	CurrentHeight() (block uint64, err error)
}

// FixedBlockSource is a BlockSource test/dry-run double that always returns
// a configured height, or a configured error.
type FixedBlockSource struct {
	Block uint64
	Err   error
}

func (f FixedBlockSource) CurrentHeight() (uint64, error) {
	if f.Err != nil {
		return 0, f.Err
	}
	return f.Block, nil
}

const localNodeInfoQuery = `query LocalNodeInfo {
  localNodeInfo {
    last_processed_block
  }
}`

// GQLBlockSource is the REAL BlockSource, backed by go-vsc-node's own
// localNodeInfo query (schema verified against
// ~/go-vsc-node/modules/gql/schema.graphql:890-899,903, read 2026-07-21):
// `LocalNodeInfo.last_processed_block: Uint64!` — "Most recent Hive L1 block
// processed by this node" — the exact clock contract/main.go's currentBlock()
// reads via env "block.height". Pure stdlib (net/http + encoding/json),
// matching GQLPriceSource/GQLStateReader's existing pattern; exercised
// end-to-end in block_test.go against an httptest.Server, untested against a
// live deploy (same caveat every real client in this package carries).
//
// NOTE on encoding: unlike an *input* Uint64 (e.g. rc_limit in price.go,
// which the schema documents as string-serialized), a Uint64 *response*
// field is written by model.Uint64.MarshalGQL
// (go-vsc-node/modules/gql/model/Uint64.go:12: `fmt.Fprint(w, uint64(b))`,
// no quotes) — a bare JSON number, not a string. The response struct below
// parses last_processed_block as a plain uint64 accordingly.
type GQLBlockSource struct {
	Endpoint   string
	HTTPClient *http.Client
}

func (g *GQLBlockSource) httpClient() *http.Client {
	if g.HTTPClient != nil {
		return g.HTTPClient
	}
	return http.DefaultClient
}

func (g *GQLBlockSource) CurrentHeight() (uint64, error) {
	body, err := json.Marshal(gqlRequest{Query: localNodeInfoQuery})
	if err != nil {
		return 0, fmt.Errorf("scheduler: encode localNodeInfo query: %w", err)
	}
	httpReq, err := http.NewRequest(http.MethodPost, g.Endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, fmt.Errorf("scheduler: build localNodeInfo request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := g.httpClient().Do(httpReq)
	if err != nil {
		return 0, fmt.Errorf("scheduler: localNodeInfo request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("scheduler: localNodeInfo HTTP %d", resp.StatusCode)
	}

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, fmt.Errorf("scheduler: read localNodeInfo response: %w", err)
	}

	var errEnv gqlErrorEnvelope
	if err := json.Unmarshal(respBytes, &errEnv); err == nil && len(errEnv.Errors) > 0 {
		return 0, fmt.Errorf("scheduler: GraphQL error: %s", errEnv.Errors[0].Message)
	}

	var gqlResp struct {
		Data struct {
			LocalNodeInfo *struct {
				LastProcessedBlock uint64 `json:"last_processed_block"`
			} `json:"localNodeInfo"`
		} `json:"data"`
	}
	if err := json.Unmarshal(respBytes, &gqlResp); err != nil {
		return 0, fmt.Errorf("scheduler: decode localNodeInfo response: %w", err)
	}
	if gqlResp.Data.LocalNodeInfo == nil {
		return 0, fmt.Errorf("scheduler: localNodeInfo returned null (node not ready?)")
	}
	return gqlResp.Data.LocalNodeInfo.LastProcessedBlock, nil
}
