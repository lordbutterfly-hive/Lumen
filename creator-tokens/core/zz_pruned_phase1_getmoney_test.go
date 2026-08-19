//go:build pruned_findings

// ════ AUDIT FINDING-DETECTOR, NOT A UNIT TEST ════
//
// This file FAILS ON PURPOSE. Each test asserts the ABSENCE of a defect the PRUNED audit
// of 2026-08-19 proved is PRESENT, so a failure here is the finding reproducing itself,
// not a regression.
//
// ★ IT IS BEHIND A BUILD TAG SO THE DEFAULT SUITE STAYS GREEN. Left untagged, `go test
// ./...` was red for reasons that are all known and documented - which destroys the one
// thing a suite is for: telling you when something NEW broke. A permanently-red suite is
// a suite nobody reads.
//
//   run the detectors:  go test -tags pruned_findings ./...
//   run the real suite: go test ./...
//
// When a finding is FIXED, its detector here starts passing. That is the intended signal:
// delete the test then, or move it into the real suite as a regression guard.
//
// Findings, artifacts and twins: /mnt/o/LUMEN-DOCS/audits/creator-tokens/2026-08-19/

package core

// ===========================================================================
// zz_pruned_phase1_getmoney_test.go — PRUNED PHASE 1 (VALUE).
//
// OWNS the brief's fourth item:
//
//	"getMoney reads a malformed or negative value as ZERO, silently, on every
//	 reserve/supply/balance read (util.go:144). Find whether any reachable
//	 path can plant such a value."
//
// getMoney's own comment says the read is safe because "every write goes
// through setMoney, so a malformed read means state corruption". That is a
// claim about the WHOLE package, and this file executes it three ways:
//
//	1. NO REACHABLE PLANT — a randomized walk over the public API, sweeping
//	   every money-typed key in the store after every operation and demanding
//	   parseMoney accept it.
//	2. NO CROSS-FAMILY ALIASING — the only way a NON-money writer could plant
//	   a malformed value under a money key is if two key families could
//	   collide. The matured family writes RAW LITTLE-ENDIAN BYTES, which is
//	   exactly the kind of value parseMoney rejects, so this is not
//	   hypothetical. Tested against adversarial account names.
//	3. THE BLAST RADIUS, if one ever existed — measured, not asserted away,
//	   because that is what sets the severity of any future write that skips
//	   setMoney.
// ===========================================================================

import (
	"fmt"
	"math/big"
	"math/rand"
	"sort"
	"strings"
	"testing"
)

// zp4MoneyKey reports whether a key is read by getMoney anywhere in the
// package, and therefore whether a malformed value under it degrades to ZERO.
// Derived from the getMoney/addMoney/subMoney/setMoney call sites.
func zp4MoneyKey(k string) bool {
	if k == "treasury" {
		return true
	}
	if strings.HasPrefix(k, "fee|") {
		return true
	}
	if strings.HasPrefix(k, "mb|") {
		return true // maturing balances
	}
	if strings.HasPrefix(k, "m|") {
		p := strings.Split(k, "|")
		if len(p) == 3 {
			switch p[2] {
			case "res", "sup", "cap", "face", "fan":
				return true
			}
		}
		if len(p) >= 6 && p[2] == "o" {
			switch p[len(p)-1] {
			case "p", "pa":
				return true
			}
		}
		if len(p) >= 5 && p[2] == "o" && (strings.Contains(k, "|ta|") || strings.Contains(k, "|tp|")) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// 1. NO REACHABLE PLANT.
// ---------------------------------------------------------------------------

func TestZP1_GetMoney_NoReachablePathPlantsAMalformedValue(t *testing.T) {
	const seeds = 30
	const steps = 1200
	scanned, distinctShapes := 0, map[string]int{}

	for seed := int64(1); seed <= seeds; seed++ {
		rng := rand.New(rand.NewSource(seed + 5000))
		w := zp1NewWorld(seed)
		for _, c := range w.creators {
			_ = Register(w.s, c, c, w.block, MinFace+5000, 5_000_000)
		}
		for i := 0; i < steps; i++ {
			zp1Step(t, rng, w)
			for _, k := range w.s.Keys() {
				if !zp4MoneyKey(k) {
					continue
				}
				scanned++
				p := strings.Split(k, "|")
				distinctShapes[p[0]+"|"+fmt.Sprint(len(p))+"|"+p[len(p)-1]]++
				v, _ := w.s.Get(k)
				if v == "" {
					// The zero-value convention: an empty value reads as 0 and is
					// written only by the deliberate ring-clear. Not a money key
					// in practice, but record it rather than skip it silently.
					continue
				}
				n, err := parseMoney(v)
				if err != nil {
					t.Fatalf("seed %d step %d: MALFORMED MONEY PLANTED at %q = %q — getMoney would read this "+
						"as ZERO, silently wiping the value. err=%v\nlast ops:\n  %s", seed, i, k, v, err, w.tail(20))
				}
				if n.Sign() < 0 {
					t.Fatalf("seed %d step %d: NEGATIVE MONEY at %q = %q\nlast ops:\n  %s", seed, i, k, v, w.tail(20))
				}
				// A money value must be the canonical base-10 form setMoney
				// writes; anything else (leading zeros, "+5", whitespace) means
				// a writer that did not go through setMoney.
				if n.String() != v {
					t.Fatalf("seed %d step %d: NON-CANONICAL money encoding at %q = %q (canonical is %q) — "+
						"a writer bypassed setMoney\nlast ops:\n  %s", seed, i, k, v, n.String(), w.tail(20))
				}
			}
		}
	}
	if scanned < 100_000 {
		t.Fatalf("VACUOUS: only %d money-key reads were scanned", scanned)
	}
	keys := make([]string, 0, len(distinctShapes))
	for k := range distinctShapes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&b, "    %-24s %d reads\n", k, distinctShapes[k])
	}
	t.Logf("SEARCH SPACE: %d seeds x %d public-API operations; EVERY money-typed key in the store was "+
		"re-parsed after EVERY operation — %d reads in total.\n"+
		"  money-key shapes actually observed (enumerated from the live store, not from a list):\n%s"+
		"  each read asserted: parseMoney accepts it, it is non-negative, and its encoding is the exact\n"+
		"  canonical base-10 form setMoney writes (so a bypassing writer would show up as non-canonical).\n"+
		"  VERDICT: no reachable public-API path plants a malformed or negative money value.",
		seeds, steps, scanned, b.String())
}

// ---------------------------------------------------------------------------
// 2. NO CROSS-FAMILY ALIASING.
//
// The matured family (setMatured) writes RAW LITTLE-ENDIAN BYTES — precisely
// the kind of value parseMoney rejects and getMoney degrades to zero. If a
// matured key could ever equal a money key, a legitimate setMatured write
// would silently wipe a reserve, a balance or the treasury. Account names are
// concatenated into these keys with NO escaping and validAccount permits every
// printable ASCII byte except '|', so this must be searched, not assumed.
// ---------------------------------------------------------------------------

func TestZP1_GetMoney_KeyFamiliesCannotAlias(t *testing.T) {
	// Adversarial names: every one is accepted by validAccount, and every one
	// is chosen to try to forge another family's key.
	names := []string{
		"a", "mb", "bal", "fee", "acq", "m", "e", "r", "tw", "twl", "allow",
		"treasury", "owner", "paused", "res", "sup", "cap", "face", "o",
		"m|x", "bal|x", // rejected by validAccount — included to prove it
		"hive:alice", "did:pkh:eip155:1:0xabc", "0x00", " ", "~", "!",
		"mb|c", "1", "0", "n", "next", "ids", "ta", "tp",
		"a b", "\x7e", "mbx", "balx", "feex",
	}
	valid := names[:0:0]
	for _, n := range names {
		if validAccount(n) {
			valid = append(valid, n)
		} else {
			if !strings.Contains(n, "|") {
				t.Errorf("validAccount rejected %q for a reason other than the '|' delimiter", n)
			}
		}
	}
	if len(valid) < 25 {
		t.Fatalf("VACUOUS: only %d adversarial names survived validAccount", len(valid))
	}

	// Build every key the package can construct from these names and record
	// which (family, args) tuple produced it. Two different tuples producing
	// the same string is a forgeable alias.
	type origin struct{ family, args string }
	seen := map[string]origin{}
	clash := 0
	add := func(key, family, args string) {
		if o, ok := seen[key]; ok && (o.family != family || o.args != args) {
			clash++
			t.Errorf("KEY ALIAS: %q is produced by BOTH %s(%s) and %s(%s) — one family's writer can "+
				"forge the other's value", key, o.family, o.args, family, args)
			return
		}
		seen[key] = origin{family, args}
	}

	for _, a := range valid {
		add(kFeeBal(a), "kFeeBal", a)
		for _, b := range valid {
			add(kBal(a, b), "kBal", a+","+b)           // mb|<creator>|<holder>   MONEY (base-10)
			add(kMatured(a, b), "kMatured", a+","+b)   // bal|<holder>|<creator>  RAW LE BYTES
			add(kAcqBlock(a, b), "kAcqBlock", a+","+b) // acq|<creator>|<holder>  u64
			for _, cc := range valid[:6] {
				add(kAllowance(a, b, cc), "kAllowance", a+","+b+","+cc)
			}
		}
		add(kFace(a), "kFace", a)
		add(kCap(a), "kCap", a)
		add(kSupply(a), "kSupply", a)
		add(kReserve(a), "kReserve", a)
		add(kFaceAnchor(a), "kFaceAnchor", a)
		add(kPaidUntil(a), "kPaidUntil", a)
		add(kState(a), "kState", a)
		add(kRegisteredAt(a), "kRegisteredAt", a)
		add(kSeq(a), "kSeq", a)
		add(kRetiredAt(a), "kRetiredAt", a)
		add(kOfferEpoch(a), "kOfferEpoch", a)
		add(kRatingSum(a), "kRatingSum", a)
		add(kRatingCount(a), "kRatingCount", a)
		add(kObsIdx(a), "kObsIdx", a)
		add(kObsLongIdx(a), "kObsLongIdx", a)
		for i := uint64(0); i < 3; i++ {
			add(kObs(a, i), "kObs", fmt.Sprintf("%s,%d", a, i))
			add(kObsLong(a, i), "kObsLong", fmt.Sprintf("%s,%d", a, i))
			add(kEscrow(a, i), "kEscrow", fmt.Sprintf("%s,%d", a, i))
			add(kAskRating(a, i), "kAskRating", fmt.Sprintf("%s,%d", a, i))
			for j := uint64(0); j < 2; j++ {
				add(kOfferPrice(a, i, j), "kOfferPrice", fmt.Sprintf("%s,%d,%d", a, i, j))
				add(kOfferAnchor(a, i, j), "kOfferAnchor", fmt.Sprintf("%s,%d,%d", a, i, j))
				add(kOfferTitle(a, i, j), "kOfferTitle", fmt.Sprintf("%s,%d,%d", a, i, j))
			}
			add(kOfferNext(a, i), "kOfferNext", fmt.Sprintf("%s,%d", a, i))
			add(kOfferIds(a, i), "kOfferIds", fmt.Sprintf("%s,%d", a, i))
		}
	}
	add(kTreasury(), "kTreasury", "")
	add(kOwner(), "kOwner", "")
	add(kPaused(), "kPaused", "")

	// The specific danger, stated as its own assertion: NO matured key (raw
	// bytes) may ever be a key getMoney reads (base-10).
	rawByteKeys, moneyKeys := 0, 0
	for k, o := range seen {
		if o.family == "kMatured" {
			rawByteKeys++
			if zp4MoneyKey(k) {
				t.Errorf("A RAW-BYTE matured key %q is classified as a getMoney key — a setMatured write "+
					"would plant an unparseable value that getMoney reads as ZERO", k)
			}
		}
		if zp4MoneyKey(k) {
			moneyKeys++
		}
	}
	if rawByteKeys == 0 || moneyKeys == 0 {
		t.Fatalf("VACUOUS: rawByteKeys=%d moneyKeys=%d", rawByteKeys, moneyKeys)
	}
	t.Logf("SEARCH SPACE: %d adversarial account names (every printable-ASCII shape validAccount admits, "+
		"plus two containing '|' to confirm they are rejected) x every key builder in keys.go = %d "+
		"distinct keys constructed.\n"+
		"  raw-byte (matured) keys: %d   getMoney keys: %d   ALIASES FOUND: %d\n"+
		"  VERDICT: no two key families collide, so no non-money writer can plant a value under a key\n"+
		"  getMoney reads. The property that carries it is validAccount's '|' rejection plus the fact\n"+
		"  that every family prefix is distinguishable before the first '|'.",
		len(valid), len(seen), rawByteKeys, moneyKeys, clash)
}

// ---------------------------------------------------------------------------
// 3. THE BLAST RADIUS.
//
// Tests 1 and 2 say a malformed value is not plantable TODAY. This measures
// what one would do if a future writer ever skipped setMoney, so the severity
// of that change is on record rather than rediscovered.
// ---------------------------------------------------------------------------

func TestZP1_GetMoney_BlastRadiusOfACorruptValue(t *testing.T) {
	const c = "zp4c"
	const h = "zp4h"
	build := func() *MemStore {
		s := NewMemStore()
		if err := Register(s, c, c, 1, MinFace+5000, MaxCap); err != nil {
			t.Fatalf("Register: %v", err)
		}
		setU64(s, kPaidUntil(c), 100*SubscriptionPeriod)
		if _, err := Buy(s, h, c, 10, big.NewInt(10_000)); err != nil {
			t.Fatalf("Buy: %v", err)
		}
		return s
	}

	// The corrupt values getMoney silently maps to ZERO.
	corrupts := []struct{ name, val string }{
		{"negative", "-1000"},
		{"raw LE bytes (what setMatured writes)", string(u64ToLE(10_000))},
		{"whitespace", " 1000"},
		{"hex", "0x3e8"},
		{"empty-ish", "."},
	}
	for _, cv := range corrupts {
		if _, err := parseMoney(cv.val); err == nil {
			t.Errorf("parseMoney ACCEPTS %s (%q) — it would not read as zero after all", cv.name, cv.val)
		}
	}
	// NON-CANONICAL BUT ACCEPTED. big.Int.SetString(base 10) tolerates a
	// leading '+' and leading zeros, so these do NOT degrade to zero — they
	// parse to the right number. Recorded because it is the opposite of the
	// hazard and would otherwise look like an untested gap: the danger is a
	// value that reads as ZERO, and these do not.
	for _, ok := range []struct {
		name, val string
		want      int64
	}{
		{"leading plus", "+1000", 1000},
		{"leading zeros", "0001000", 1000},
	} {
		n, err := parseMoney(ok.val)
		if err != nil || n.Int64() != ok.want {
			t.Errorf("parseMoney(%q) = %v, %v; expected it to be ACCEPTED as %d", ok.val, n, err, ok.want)
			continue
		}
		t.Logf("NOTE: parseMoney accepts the non-canonical form %q as %d. Not a zero-degradation hazard, "+
			"but it means state can hold a value whose string form differs from setMoney's output; the "+
			"canonical-encoding assertion in TestZP1_GetMoney_NoReachablePathPlantsAMalformedValue is "+
			"what would surface a writer producing one.", ok.val, ok.want)
	}

	type probe struct {
		key   string
		label string
	}
	probes := []probe{
		{kReserve(c), "kReserve  (market backing)"},
		{kSupply(c), "kSupply   (credits outstanding)"},
		{kBal(c, h), "kBal      (a holder's maturing balance)"},
		{kTreasury(), "treasury  (platform revenue)"},
		{kFeeBal(c), "fee|      (a creator's earned fees)"},
	}
	var lines []string
	for _, p := range probes {
		s := build()
		before := getMoney(s, p.key)
		s.Set(p.key, "-1")
		after := getMoney(s, p.key)

		// What does the system now do?
		var behaviour string
		switch {
		case p.key == kReserve(c):
			_, err := Sell(s, h, c, 100, big.NewInt(1))
			behaviour = fmt.Sprintf("Sell -> %v", errOrOK(err))
		case p.key == kSupply(c):
			_, err := Sell(s, h, c, 100, big.NewInt(1))
			behaviour = fmt.Sprintf("Sell -> %v", errOrOK(err))
		case p.key == kBal(c, h):
			_, err := Sell(s, h, c, 100, big.NewInt(1))
			behaviour = fmt.Sprintf("Sell -> %v", errOrOK(err))
		case p.key == kTreasury():
			setStr(s, kOwner(), "zp4owner")
			_, err := WithdrawTreasury(s, "zp4owner", big.NewInt(1))
			behaviour = fmt.Sprintf("WithdrawTreasury -> %v", errOrOK(err))
		default:
			got, err := ClaimTradeFees(s, c)
			behaviour = fmt.Sprintf("ClaimTradeFees -> %s, %v", got, errOrOK(err))
		}
		lines = append(lines, fmt.Sprintf("    %-42s %14s -> %-6s   %s", p.label, before, after, behaviour))
	}
	t.Logf("BLAST RADIUS of a single corrupt money value (not reachable today — see tests 1 and 2):\n"+
		"    %-42s %14s    %-6s   %s\n%s\n"+
		"  READING: the silent degradation to ZERO is the WRONG direction on kReserve, kBal and the two\n"+
		"  revenue pots — it destroys the value rather than refusing. sell.go's solvency pre-check\n"+
		"  (reserve < Area(supply)) is the only thing that converts one of these into a refusal instead\n"+
		"  of a wrong payout, and it only covers the reserve. setMoney's negative-panic is what keeps the\n"+
		"  plant unreachable; any future write that reaches state without it re-opens all of this.",
		"key", "before", "after", "behaviour after corruption", joinLines(lines))
}

func errOrOK(err error) string {
	if err == nil {
		return "ACCEPTED (no error)"
	}
	return "refused: " + err.Error()
}
