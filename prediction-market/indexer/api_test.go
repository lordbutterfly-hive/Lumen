package indexer

import "testing"

func buildTestIndex(t *testing.T) *Index {
	t.Helper()
	ix := NewIndex()
	ix.Ingest(mustDrain(t, BuildCanonicalScenario()))
	return ix
}

func TestRoundBettorsView(t *testing.T) {
	ix := buildTestIndex(t)
	view, ok := ix.RoundBettorsView(1)
	if !ok {
		t.Fatal("expected round 1 to be found")
	}
	if view.RoundID != "1" || view.Bettors != 5 {
		t.Fatalf("got %+v, want roundId=1 bettors=5", view)
	}

	_, ok = ix.RoundBettorsView(404)
	if ok {
		t.Fatal("expected ok=false for an unknown round")
	}
}

func TestMyPositionView_MatchesFrontendShape(t *testing.T) {
	ix := buildTestIndex(t)

	// Claimed account (alice): payout must be present.
	alice, ok := ix.MyPositionView(1, "hive:alice")
	if !ok {
		t.Fatal("expected alice's position to be found")
	}
	if alice.RoundID != "1" {
		t.Errorf("RoundID = %q, want 1", alice.RoundID)
	}
	if alice.TotalStaked != "5000" {
		t.Errorf("TotalStaked = %q, want 5000", alice.TotalStaked)
	}
	if !alice.Claimed {
		t.Error("Claimed = false, want true")
	}
	if alice.Claimable {
		t.Error("Claimable = true for an already-claimed position, want false")
	}
	if alice.Payout == nil || *alice.Payout != "4900" {
		t.Errorf("Payout = %v, want 4900", alice.Payout)
	}
	// outcome 2 -> "flat" per BucketIDs/bucket-defs.ts.
	if got := alice.StakeByBucket["flat"]; got != "5000" {
		t.Errorf("StakeByBucket[flat] = %q, want 5000 (got map %v)", got, alice.StakeByBucket)
	}

	// Unclaimed account on a resolved round (dave): claimable=true, no payout.
	dave, ok := ix.MyPositionView(1, "hive:dave")
	if !ok {
		t.Fatal("expected dave's position to be found")
	}
	if dave.Claimed {
		t.Error("dave: Claimed = true, want false")
	}
	if !dave.Claimable {
		t.Error("dave: Claimable = false, want true (resolved round, staked, not claimed)")
	}
	if dave.Payout != nil {
		t.Errorf("dave: Payout = %v, want nil (never claimed)", dave.Payout)
	}

	// Account that never bet: not found.
	_, ok = ix.MyPositionView(1, "hive:nobody")
	if ok {
		t.Fatal("expected ok=false for an account with no bet in this round")
	}
}

func TestBucketID(t *testing.T) {
	cases := []struct {
		outcome int
		want    string
	}{
		{0, "down_20"},
		{1, "down_10"},
		{2, "flat"},
		{3, "up_10"},
		{4, "up_20"},
		{5, ""},  // out of range for the 5-bucket convention
		{-1, ""}, // defensively out of range
	}
	for _, c := range cases {
		if got := BucketID(c.outcome); got != c.want {
			t.Errorf("BucketID(%d) = %q, want %q", c.outcome, got, c.want)
		}
	}
}

func TestHouseTakenView(t *testing.T) {
	ix := buildTestIndex(t)
	view := ix.HouseTakenView("hive")
	if view.Asset != "hive" || view.Amount != "350" {
		t.Fatalf("got %+v, want asset=hive amount=350", view)
	}
	empty := ix.HouseTakenView("hbd")
	if empty.Amount != "0" {
		t.Fatalf("got %+v, want amount=0 for an asset never taken", empty)
	}
}

func TestUnclaimedView(t *testing.T) {
	ix := buildTestIndex(t)
	view := ix.UnclaimedView("hive:dave")
	if view.Acct != "hive:dave" || len(view.RoundIDs) != 1 || view.RoundIDs[0] != "1" {
		t.Fatalf("got %+v, want acct=hive:dave roundIds=[1]", view)
	}
	claimed := ix.UnclaimedView("hive:alice")
	if len(claimed.RoundIDs) != 0 {
		t.Fatalf("got %+v, want empty roundIds for a claimer", claimed)
	}
}
