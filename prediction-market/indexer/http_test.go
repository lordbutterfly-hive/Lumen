package indexer

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPHandler_RoundBettors(t *testing.T) {
	ix := buildTestIndex(t)
	srv := httptest.NewServer(NewHTTPHandler(ix))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/rounds/1/bettors")
	if err != nil {
		t.Fatalf("GET failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var got RoundBettorsView
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if got.RoundID != "1" || got.Bettors != 5 {
		t.Fatalf("got %+v, want roundId=1 bettors=5", got)
	}
}

func TestHTTPHandler_RoundBettorsNotFound(t *testing.T) {
	ix := buildTestIndex(t)
	srv := httptest.NewServer(NewHTTPHandler(ix))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/rounds/404/bettors")
	if err != nil {
		t.Fatalf("GET failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
}

func TestHTTPHandler_RoundBettorsBadID(t *testing.T) {
	ix := buildTestIndex(t)
	srv := httptest.NewServer(NewHTTPHandler(ix))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/rounds/not-a-number/bettors")
	if err != nil {
		t.Fatalf("GET failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestHTTPHandler_RoundSummary(t *testing.T) {
	ix := buildTestIndex(t)
	srv := httptest.NewServer(NewHTTPHandler(ix))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/rounds/1/summary")
	if err != nil {
		t.Fatalf("GET failed: %v", err)
	}
	defer resp.Body.Close()
	var got roundSummaryJSON
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if got.Bettors != 5 || got.TotalBets != "15000" || got.State != "settled" {
		t.Fatalf("got %+v", got)
	}
}

func TestHTTPHandler_Positions(t *testing.T) {
	ix := buildTestIndex(t)
	srv := httptest.NewServer(NewHTTPHandler(ix))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/positions/hive:dave")
	if err != nil {
		t.Fatalf("GET failed: %v", err)
	}
	defer resp.Body.Close()
	var got []positionJSON
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if len(got) != 1 || got[0].RoundID != "1" || got[0].Claimed {
		t.Fatalf("got %+v", got)
	}
}

func TestHTTPHandler_Unclaimed(t *testing.T) {
	ix := buildTestIndex(t)
	srv := httptest.NewServer(NewHTTPHandler(ix))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/positions/hive:erin/unclaimed")
	if err != nil {
		t.Fatalf("GET failed: %v", err)
	}
	defer resp.Body.Close()
	var got UnclaimedView
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if got.Acct != "hive:erin" || len(got.RoundIDs) != 1 || got.RoundIDs[0] != "1" {
		t.Fatalf("got %+v", got)
	}
}

func TestHTTPHandler_House(t *testing.T) {
	ix := buildTestIndex(t)
	srv := httptest.NewServer(NewHTTPHandler(ix))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/house/hive")
	if err != nil {
		t.Fatalf("GET failed: %v", err)
	}
	defer resp.Body.Close()
	var got HouseTakenView
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if got.Asset != "hive" || got.Amount != "350" {
		t.Fatalf("got %+v", got)
	}
}
