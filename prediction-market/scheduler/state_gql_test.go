package scheduler

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestGQLStateReader_Get_Found drives the REAL GQLStateReader end-to-end
// against an httptest.Server speaking the exact getStateByKeys shape
// (~/go-vsc-node/modules/gql/schema.graphql:809-820: Map scalar = "arbitrary
// key-value map, serialized as a JSON object").
func TestGQLStateReader_Get_Found(t *testing.T) {
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
		if !strings.Contains(query, "getStateByKeys") {
			t.Errorf("query missing getStateByKeys: %s", query)
		}
		vars, _ := gotBody["variables"].(map[string]interface{})
		if vars["contractId"] != "vsc1statetest" {
			t.Errorf("contractId = %v, want vsc1statetest", vars["contractId"])
		}
		keys, _ := vars["keys"].([]interface{})
		if len(keys) != 1 || keys[0] != "active|hive" {
			t.Errorf("keys = %v, want [active|hive]", keys)
		}

		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"getStateByKeys":{"active|hive":"3"}}}`))
	}))
	defer srv.Close()

	r := &GQLStateReader{Endpoint: srv.URL}
	v, ok, err := r.Get("vsc1statetest", "active|hive")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !ok || v != "3" {
		t.Fatalf("Get = (%q,%v), want (3,true)", v, ok)
	}
}

func TestGQLStateReader_Get_MissingKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// getStateByKeys omits/nulls keys that don't exist in contract state.
		w.Write([]byte(`{"data":{"getStateByKeys":{}}}`))
	}))
	defer srv.Close()

	r := &GQLStateReader{Endpoint: srv.URL}
	_, ok, err := r.Get("vsc1statetest", "rd|999|state")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if ok {
		t.Fatal("expected not found for a key absent from the returned Map")
	}
}

func TestGQLStateReader_Get_GraphQLError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"errors":[{"message":"bad contract id"}]}`))
	}))
	defer srv.Close()

	r := &GQLStateReader{Endpoint: srv.URL}
	if _, _, err := r.Get("bad", "active|hive"); err == nil {
		t.Fatal("expected an error on a GraphQL errors[] response")
	} else if !strings.Contains(err.Error(), "bad contract id") {
		t.Fatalf("error %q does not surface the GraphQL message", err.Error())
	}
}

func TestMockStateReader(t *testing.T) {
	m := MockStateReader{"foo": "bar"}
	v, ok, err := m.Get("ignored", "foo")
	if err != nil || !ok || v != "bar" {
		t.Fatalf("Get = (%q,%v,%v)", v, ok, err)
	}
	_, ok, _ = m.Get("ignored", "missing")
	if ok {
		t.Fatal("expected not found for missing key")
	}
}
