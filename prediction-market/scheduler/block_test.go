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

// TestGQLBlockSource_CurrentHeight_Success drives the REAL GQLBlockSource
// end-to-end against an httptest.Server speaking the exact go-vsc-node
// localNodeInfo shape (schema verified against
// ~/go-vsc-node/modules/gql/schema.graphql:890-899,903, read 2026-07-21).
// last_processed_block comes back as a bare JSON NUMBER (model.Uint64's
// MarshalGQL writes no quotes on responses — see block.go's doc), which this
// fixture deliberately reflects (not a quoted string).
func TestGQLBlockSource_CurrentHeight_Success(t *testing.T) {
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		if err := json.Unmarshal(body, &gotBody); err != nil {
			t.Fatalf("body not JSON: %v", err)
		}
		query, _ := gotBody["query"].(string)
		if !strings.Contains(query, "localNodeInfo") {
			t.Errorf("query missing localNodeInfo: %s", query)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"localNodeInfo":{"last_processed_block":123456789}}}`))
	}))
	defer srv.Close()

	src := &GQLBlockSource{Endpoint: srv.URL}
	block, err := src.CurrentHeight()
	if err != nil {
		t.Fatalf("CurrentHeight: %v", err)
	}
	if block != 123456789 {
		t.Fatalf("block = %d, want 123456789", block)
	}
}

func TestGQLBlockSource_CurrentHeight_NullNode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"localNodeInfo":null}}`))
	}))
	defer srv.Close()

	src := &GQLBlockSource{Endpoint: srv.URL}
	if _, err := src.CurrentHeight(); err == nil {
		t.Fatal("expected an error when localNodeInfo is null")
	}
}

func TestGQLBlockSource_CurrentHeight_GraphQLError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"errors":[{"message":"node not synced"}]}`))
	}))
	defer srv.Close()

	src := &GQLBlockSource{Endpoint: srv.URL}
	if _, err := src.CurrentHeight(); err == nil {
		t.Fatal("expected an error on a GraphQL errors[] response")
	} else if !strings.Contains(err.Error(), "node not synced") {
		t.Fatalf("error %q does not surface the GraphQL message", err.Error())
	}
}

func TestGQLBlockSource_CurrentHeight_HTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	src := &GQLBlockSource{Endpoint: srv.URL}
	if _, err := src.CurrentHeight(); err == nil {
		t.Fatal("expected an error on HTTP 500")
	}
}

func TestFixedBlockSource(t *testing.T) {
	f := FixedBlockSource{Block: 42}
	b, err := f.CurrentHeight()
	if err != nil || b != 42 {
		t.Fatalf("CurrentHeight() = (%d,%v), want (42,nil)", b, err)
	}
}

func TestFixedBlockSource_Err(t *testing.T) {
	wantErr := errors.New("boom")
	f := FixedBlockSource{Err: wantErr}
	if _, err := f.CurrentHeight(); err != wantErr {
		t.Fatalf("CurrentHeight() err = %v, want %v", err, wantErr)
	}
}
