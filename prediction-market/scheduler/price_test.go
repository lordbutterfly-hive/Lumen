package scheduler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestGQLPriceSource_Peek_Success drives the REAL GQLPriceSource end-to-end
// (real net/http.Client, real HTTP round trip) against an httptest.Server
// that speaks the EXACT go-vsc-node GraphQL schema shape for
// simulateContractCalls (verified against
// ~/go-vsc-node/modules/gql/schema.graphql:757-807,998-1004), including the
// Uint64-as-string encoding for rc_limit (schema.graphql:6-9). This proves
// the request-building AND response-parsing halves of the client actually
// work, not just that they compile.
func TestGQLPriceSource_Peek_Success(t *testing.T) {
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read request body: %v", err)
		}
		if err := json.Unmarshal(body, &gotBody); err != nil {
			t.Fatalf("request body not JSON: %v (%s)", err, body)
		}

		query, _ := gotBody["query"].(string)
		if !strings.Contains(query, "simulateContractCalls") {
			t.Errorf("query does not reference simulateContractCalls: %s", query)
		}
		vars, _ := gotBody["variables"].(map[string]interface{})
		input, _ := vars["input"].(map[string]interface{})
		if input["tx_id"] == nil || input["tx_id"] == "" {
			t.Errorf("tx_id missing/empty (schema requires non-empty String!): %+v", input)
		}
		calls, _ := input["calls"].([]interface{})
		if len(calls) != 1 {
			t.Fatalf("calls = %v, want exactly 1", calls)
		}
		call, _ := calls[0].(map[string]interface{})
		if call["action"] != "peekPrice" {
			t.Errorf("action = %v, want peekPrice", call["action"])
		}
		if call["contract_id"] != "vsc1peektest" {
			t.Errorf("contract_id = %v, want vsc1peektest", call["contract_id"])
		}
		if _, ok := call["rc_limit"].(string); !ok {
			t.Errorf("rc_limit = %v (%T), want a JSON STRING (Uint64 scalar is string-serialized)", call["rc_limit"], call["rc_limit"])
		}

		w.Header().Set("Content-Type", "application/json")
		// The exact peekPrice ret shape from contract/main.go:516.
		resp := `{"data":{"simulateContractCalls":[{"success":true,"err":null,"err_msg":null,"ret":"{\"priceBps\":2940,\"tick\":4200,\"feedOK\":true,\"unit\":\"HBD/HIVE\"}"}]}}`
		w.Write([]byte(resp))
	}))
	defer srv.Close()

	src := &GQLPriceSource{
		Endpoint:   srv.URL,
		ContractID: "vsc1peektest",
		TxIDFunc:   func() string { return "test-tx-id" },
	}
	priceBps, tick, feedOK, err := src.Peek()
	if err != nil {
		t.Fatalf("Peek: %v", err)
	}
	if priceBps != 2940 {
		t.Fatalf("priceBps = %d, want 2940", priceBps)
	}
	if tick != 4200 {
		t.Fatalf("tick = %d, want 4200", tick)
	}
	if !feedOK {
		t.Fatal("feedOK = false, want true")
	}
}

func TestGQLPriceSource_Peek_ContractCallFailed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"simulateContractCalls":[{"success":false,"err":"ORACLE","err_msg":"price feed not ok","ret":null}]}}`))
	}))
	defer srv.Close()

	src := &GQLPriceSource{Endpoint: srv.URL, ContractID: "vsc1x"}
	if _, _, _, err := src.Peek(); err == nil {
		t.Fatal("expected an error when the simulated call itself failed (success:false)")
	} else if !strings.Contains(err.Error(), "price feed not ok") {
		t.Fatalf("error %q does not surface the contract's err_msg", err.Error())
	}
}

func TestGQLPriceSource_Peek_GraphQLError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"errors":[{"message":"contract not found"}]}`))
	}))
	defer srv.Close()

	src := &GQLPriceSource{Endpoint: srv.URL, ContractID: "vsc1missing"}
	if _, _, _, err := src.Peek(); err == nil {
		t.Fatal("expected an error on a top-level GraphQL errors[] response")
	} else if !strings.Contains(err.Error(), "contract not found") {
		t.Fatalf("error %q does not surface the GraphQL error message", err.Error())
	}
}

func TestGQLPriceSource_Peek_HTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	src := &GQLPriceSource{Endpoint: srv.URL, ContractID: "vsc1x"}
	if _, _, _, err := src.Peek(); err == nil {
		t.Fatal("expected an error on HTTP 500")
	}
}

func TestFixedPriceSource(t *testing.T) {
	f := FixedPriceSource{PriceBps: 1234, Tick: 5678, FeedOK: true}
	p, tick, ok, err := f.Peek()
	if err != nil || p != 1234 || tick != 5678 || !ok {
		t.Fatalf("Peek() = (%d,%d,%v,%v), want (1234,5678,true,nil)", p, tick, ok, err)
	}
}

func TestFixedPriceSource_Err(t *testing.T) {
	wantErr := errors.New("boom")
	f := FixedPriceSource{Err: wantErr}
	if _, _, _, err := f.Peek(); err != wantErr {
		t.Fatalf("Peek() err = %v, want %v", err, wantErr)
	}
}
