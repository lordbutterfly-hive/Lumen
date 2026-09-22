package core

import (
	"encoding/json"
	"math/big"
	"os"
	"strings"
	"testing"
)

// A6 — the v5.1 MAINNET state, read key-for-key from the primary node
// (testdata/mainnet-v5-110125225.json: 8 markets, 13 positions, the one answered
// escrow, TWAP rings, offerings), loaded raw and driven through the unit wrapper
// exactly as the wasm wrapper does (contract/main.go: core.WrapUnits(sdkStore{})).
//
// What it proves: the migration scales every token-denominated key by exactly
// TokenScale, once, touches nothing else (reserve, clocks, fees, offerings), keeps
// supply == Σpositions + Σpending-escrow before and after, keeps R == Area(S) on
// the real curve, and every entrypoint then runs on the migrated state with the
// invariants intact — including the two legacy positions that never had a
// `lots|` ledger (dlmmqb and godfish markets) and a mixed state where one holder
// has migrated and another has not.

type mnFixture struct {
	Head    uint64            `json:"head"`
	Markets []string          `json:"markets"`
	Holders []string          `json:"holders"`
	State   map[string]string `json:"state"`
}

func loadMainnetV5(t *testing.T) (*MemStore, Store, mnFixture) {
	t.Helper()
	b, err := os.ReadFile("testdata/mainnet-v5-110125225.json")
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	var f mnFixture
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatalf("fixture json: %v", err)
	}
	raw := NewMemStore()
	for k, v := range f.State {
		raw.Set(k, v)
	}
	return raw, WrapUnits(raw), f
}

// mnHolders enumerates every account with a maturing or matured position on c,
// from the RAW key set (the wrapper has no key scan).
func mnHolders(raw *MemStore, c string) []string {
	seen := map[string]bool{}
	var out []string
	for _, k := range raw.Keys() {
		switch {
		case strings.HasPrefix(k, "mb|"+c+"|"):
			h := k[len("mb|"+c+"|"):]
			if !seen[h] {
				seen[h] = true
				out = append(out, h)
			}
		case strings.HasPrefix(k, "bal|") && strings.HasSuffix(k, "|"+c):
			h := k[4 : len(k)-len("|"+c)]
			if !seen[h] {
				seen[h] = true
				out = append(out, h)
			}
		}
	}
	return out
}

// mnPendingEscrow sums the credits still held in PENDING escrows of c.
func mnPendingEscrow(s Store, c string) *big.Int {
	total := mZero()
	for seq := uint64(0); seq < EscrowSeq(s, c)+2; seq++ {
		v, ok := s.Get(kEscrow(c, seq))
		if !ok || v == "" {
			continue
		}
		rec, ok := unpackEscrow(v)
		if !ok {
			continue
		}
		if rec.status == "PENDING" {
			total = mAdd(total, rec.credits)
		}
	}
	return total
}

// mnAssertI3 — supply == Σ(maturing + matured) + Σpending escrow, per market,
// and R == Area(S) on every market that is still on the curve.
func mnAssertI3(t *testing.T, raw *MemStore, s Store, markets []string, label string) {
	t.Helper()
	for _, c := range markets {
		total := mnPendingEscrow(s, c)
		for _, h := range mnHolders(raw, c) {
			total = mAdd(total, totalBalance(s, c, h))
		}
		if total.Cmp(Supply(s, c)) != 0 {
			t.Fatalf("%s: %s: Σpositions+escrow=%s != supply=%s", label, c, total, Supply(s, c))
		}
		if _, retired := RetiredAt(s, c); !retired && getStr(s, kState(c)) == "ACTIVE" {
			if res, area := Reserve(s, c), Area(Supply(s, c)); res.Cmp(area) != 0 {
				t.Fatalf("%s: %s: reserve=%s != Area(%s)=%s", label, c, res, Supply(s, c), area)
			}
		}
	}
}

func TestV6Mainnet_MigrationScalesOnceAndTouchesNothingElse(t *testing.T) {
	raw, s, f := loadMainnetV5(t)
	t.Logf("fixture head %d, %d keys, %d markets, %d accounts", f.Head, len(f.State), len(f.Markets), len(f.Holders))

	// ── Before: the raw v5.1 numbers are whole tokens and already satisfy the
	// invariants in tokens (this is the state the chain holds today).
	for _, c := range f.Markets {
		sup, _ := new(big.Int).SetString(f.State[kSupply(c)], 10)
		sum := mZero()
		for _, h := range f.Holders {
			if v, ok := f.State[kBal(c, h)]; ok {
				n, _ := new(big.Int).SetString(v, 10)
				sum = mAdd(sum, n)
			}
		}
		if sum.Cmp(sup) != 0 {
			t.Fatalf("raw %s: Σmb=%s != sup=%s (the fixture itself is inconsistent)", c, sum, sup)
		}
		res, _ := new(big.Int).SetString(f.State[kReserve(c)], 10)
		if res.Cmp(AreaTokens(sup)) != 0 {
			t.Fatalf("raw %s: reserve %s != AreaTokens(%s)=%s", c, res, sup, AreaTokens(sup))
		}
	}
	rawBefore := map[string]string{}
	for _, k := range raw.Keys() {
		rawBefore[k], _ = raw.Get(k)
	}

	// ── Read everything through the wrapper (no writes yet).
	mnAssertI3(t, raw, s, f.Markets, "first read")
	for _, c := range f.Markets {
		want, _ := new(big.Int).SetString(f.State[kSupply(c)], 10)
		if got := Supply(s, c); got.Cmp(tk(want.Int64())) != 0 {
			t.Fatalf("%s supply=%s want %s units", c, got, tk(want.Int64()))
		}
		if got := Cap(s, c); got.Cmp(big.NewInt(MaxCap)) != 0 {
			t.Fatalf("%s cap=%s want MaxCap=%d (1e9 tokens x100)", c, got, MaxCap)
		}
		for _, h := range f.Holders {
			v, ok := f.State[kBal(c, h)]
			if !ok {
				if BalanceOf(s, c, h).Sign() != 0 {
					t.Fatalf("%s/%s: balance appeared from nowhere", c, h)
				}
				continue
			}
			n, _ := new(big.Int).SetString(v, 10)
			if got := BalanceOf(s, c, h); got.Cmp(tk(n.Int64())) != 0 {
				t.Fatalf("%s/%s: balance=%s want %s", c, h, got, tk(n.Int64()))
			}
			if MaturedOf(s, c, h).Sign() != 0 {
				t.Fatalf("%s/%s: matured bucket must be empty (none existed on chain)", c, h)
			}
			// Lots: same cohorts, counts x100, same acq blocks; legacy positions
			// (no ledger on chain) synthesise ONE cohort at the acq clock.
			lots := getLots(s, c, h)
			if rawLots, had := f.State[kLots(c, h)]; had {
				parts := strings.Split(rawLots, ";")
				if len(lots) != len(parts) {
					t.Fatalf("%s/%s: %d lots, raw had %d (%q)", c, h, len(lots), len(parts), rawLots)
				}
				sum := mZero()
				for _, l := range lots {
					sum = mAdd(sum, l.count)
					if l.count.Int64()%TokenScale != 0 {
						t.Fatalf("%s/%s: cohort %s is not a whole-token multiple after migration", c, h, l.count)
					}
					if !strings.Contains(rawLots, ","+itoa(l.acq)) {
						t.Fatalf("%s/%s: cohort acq %d not in raw %q", c, h, l.acq, rawLots)
					}
				}
				if sum.Cmp(tk(n.Int64())) != 0 {
					t.Fatalf("%s/%s: Σlots=%s != balance %s", c, h, sum, tk(n.Int64()))
				}
			} else {
				acq, _ := new(big.Int).SetString(f.State[kAcqBlock(c, h)], 10)
				if len(lots) != 1 || lots[0].count.Cmp(tk(n.Int64())) != 0 || lots[0].acq != acq.Uint64() {
					t.Fatalf("%s/%s: legacy synthesis = %+v, want one cohort {%s,%s}", c, h, lots, tk(n.Int64()), acq)
				}
			}
		}
	}
	// The answered escrow (hbd-temp seq 0): 9 raw fields -> 10, credits x100,
	// everything else byte-identical.
	rec, ok := unpackEscrow(getStr(s, kEscrow("hive:hbd-temp", 0)))
	if !ok || rec.credits.Cmp(tk(1)) != 0 || rec.status != "ANSWERED" || rec.asker != "hive:lordbutterfly" ||
		rec.acqBlock != 110111621 || rec.offeringID != 1 || rec.contentHash != "ask-14woy0" || rec.answerHash != "TESTING TEST" || rec.commissionCredits.Sign() != 0 {
		t.Fatalf("escrow 0 after migration = %+v (ok=%v)", rec, ok)
	}
	if v, _ := raw.Get(kEscrow("hive:hbd-temp", 0)); strings.Count(v, "|") != escrowFieldsV6-1 || !strings.Contains(v, "|"+escrowUnitsMarker+"|") {
		t.Fatalf("raw escrow not rewritten to the 10-field form: %q", v)
	}
	if RatingOf(s, "hive:hbd-temp", 0) != 5 {
		t.Fatal("rating lost")
	}

	// ── After: only token-denominated keys changed, each by exactly x100, and
	// each carries its flag; everything else is byte-identical.
	changed := 0
	for k, before := range rawBefore {
		after, _ := raw.Get(k)
		if before == after {
			continue
		}
		changed++
		switch {
		case strings.HasPrefix(k, "mb|"), strings.HasPrefix(k, "lots|"), strings.HasSuffix(k, "|sup"), strings.HasSuffix(k, "|cap"):
			if !mnIsScaled(before, after) {
				t.Fatalf("%s: %q -> %q is not a x100", k, before, after)
			}
		case strings.HasPrefix(k, "e|"):
		default:
			t.Fatalf("%s changed (%q -> %q) but is not a token key", k, before, after)
		}
	}
	for _, c := range f.Markets {
		if v, _ := raw.Get(kUnitsMarket(c)); v != "1" {
			t.Fatalf("%s: market flag missing", c)
		}
		for _, h := range f.Holders {
			if _, had := f.State[kBal(c, h)]; had {
				if v, _ := raw.Get(kUnitsHolder(c, h)); v != "1" {
					t.Fatalf("%s/%s: holder flag missing", c, h)
				}
			}
		}
	}
	t.Logf("migration rewrote %d of %d keys; reserves, clocks, fees, TWAP rings, offerings untouched", changed, len(rawBefore))

	// Idempotent: reading everything again changes no raw value.
	snapshot := map[string]string{}
	for _, k := range raw.Keys() {
		snapshot[k], _ = raw.Get(k)
	}
	mnAssertI3(t, raw, s, f.Markets, "second read")
	for k, v := range snapshot {
		if now, _ := raw.Get(k); now != v {
			t.Fatalf("second pass rewrote %s: %q -> %q", k, v, now)
		}
	}
}

func mnIsScaled(before, after string) bool {
	if strings.Contains(before, ",") { // lots ledger
		bp, ap := strings.Split(before, ";"), strings.Split(after, ";")
		if len(bp) != len(ap) {
			return false
		}
		for i := range bp {
			b, a := strings.SplitN(bp[i], ",", 2), strings.SplitN(ap[i], ",", 2)
			if len(b) != 2 || len(a) != 2 || b[1] != a[1] || !mnIsScaled(b[0], a[0]) {
				return false
			}
		}
		return true
	}
	b, ok1 := new(big.Int).SetString(before, 10)
	a, ok2 := new(big.Int).SetString(after, 10)
	return ok1 && ok2 && new(big.Int).Mul(b, unitsScale).Cmp(a) == 0
}

func itoa(u uint64) string { return new(big.Int).SetUint64(u).String() }

func TestV6Mainnet_MixedStateKeepsI3(t *testing.T) {
	raw, s, f := loadMainnetV5(t)
	const c, migrated, legacy = "hive:stayoutoftherz", "hive:daveks", "hive:lordbutterfly"
	// Touch ONE holder and the market; the other holder stays in v5.1 form on disk.
	if got := BalanceOf(s, c, migrated); got.Cmp(tk(1)) != 0 {
		t.Fatalf("migrated holder = %s", got)
	}
	if v, _ := raw.Get(kBal(c, legacy)); v != "4" {
		t.Fatalf("legacy holder should still be raw v5.1: %q", v)
	}
	if v, _ := raw.Get(kSupply(c)); v != "5" {
		t.Fatalf("supply must not be touched by a balance read: %q", v)
	}
	// I3 through the wrapper holds in the mixed state; the read migrates the
	// legacy holder and the market as it goes.
	mnAssertI3(t, raw, s, []string{c}, "mixed")
	if v, _ := raw.Get(kBal(c, legacy)); v != "400" {
		t.Fatalf("legacy holder not migrated on read: %q", v)
	}
	if v, _ := raw.Get(kSupply(c)); v != "500" {
		t.Fatalf("supply not migrated on read: %q", v)
	}
	// A WRITE to a still-raw key converts first (the other market's holder).
	const c2, h2 = "hive:dlmmqb", "hive:lordbutterfly"
	if v, _ := raw.Get(kBal(c2, h2)); v != "4" {
		t.Fatalf("precondition: %q", v)
	}
	if err := TransferCredits(s, h2, c2, h2, "hive:daveks", f.Head+5, tk(1)); err != nil {
		t.Fatalf("transfer on a raw position: %v", err)
	}
	if got := BalanceOf(s, c2, h2); got.Cmp(tk(3)) != 0 {
		t.Fatalf("after transfer sender=%s want 300", got)
	}
	if got := BalanceOf(s, c2, "hive:daveks"); got.Cmp(tk(1)) != 0 {
		t.Fatalf("receiver=%s want 100", got)
	}
	mnAssertI3(t, raw, s, f.Markets, "after write on raw position")
}

// Every entrypoint, on the migrated mainnet state, with I3 and R==Area(S)
// re-checked after each one. Blocks advance monotonically from the fixture head.
func TestV6Mainnet_EveryEntrypointOnMigratedState(t *testing.T) {
	raw, s, f := loadMainnetV5(t)
	check := func(label string) {
		t.Helper()
		mnAssertI3(t, raw, s, f.Markets, label)
	}
	b := f.Head + 10
	const lb, dl, dv, hb, so, gf, sink = "hive:lordbutterfly", "hive:dlmmqb", "hive:daveks", "hive:hbd-temp", "hive:stayoutoftherz", "hive:godfish", "hive:v6sink"

	// QuoteBuy / Buy 1.50 tokens by a brand-new holder on lordbutterfly's market.
	q, err := QuoteBuy(s, lb, b, big.NewInt(150))
	if err != nil {
		t.Fatalf("quote: %v", err)
	}
	wantCost := BuyCost(Supply(s, lb), big.NewInt(150))
	r, err := Buy(s, sink, lb, b, big.NewInt(150))
	if err != nil {
		t.Fatalf("buy 1.50: %v", err)
	}
	if r.Cost.Cmp(wantCost) != 0 || r.TotalDue.Cmp(q.TotalDue) != 0 || r.Minted.Cmp(big.NewInt(150)) != 0 || BalanceOf(s, lb, sink).Cmp(big.NewInt(150)) != 0 {
		t.Fatalf("buy 1.50: cost %s want %s, due %s quote %s, minted %s", r.Cost, wantCost, r.TotalDue, q.TotalDue, r.Minted)
	}
	check("after buy 1.50")
	// Buy 0.01 on hbd-temp: one unit, fee lifted to the one-base-unit minimum.
	r, err = Buy(s, sink, hb, b+1, big.NewInt(1))
	if err != nil {
		t.Fatalf("buy 0.01: %v", err)
	}
	if r.Fee.Cmp(big.NewInt(MinFeeBaseUnits)) < 0 {
		t.Fatalf("dust buy fee %s below the minimum", r.Fee)
	}
	check("after buy 0.01")
	if _, err := Buy(s, sink, hb, b+1, big.NewInt(0)); err == nil {
		t.Fatal("buy 0 must be refused")
	}

	// Sell 0.50 by a LEGACY (no-ledger) position: dlmmqb on dlmmqb's market.
	supBefore := new(big.Int).Set(Supply(s, dl))
	sr, err := Sell(s, dl, dl, b+2, big.NewInt(50))
	if err != nil {
		t.Fatalf("legacy sell: %v", err)
	}
	if wantGross, _ := SellProceeds(supBefore, big.NewInt(50)); sr.Gross.Cmp(wantGross) != 0 {
		t.Fatalf("legacy sell gross %s want %s", sr.Gross, wantGross)
	}
	if sr.TaxBps == 0 || sr.TaxBps > MaxExitTaxBps {
		t.Fatalf("legacy sell taxBps=%d, want a partial-maturity rate", sr.TaxBps)
	}
	if mAdd(mAdd(sr.Net, sr.Tax), sr.Fee).Cmp(sr.Gross) != 0 {
		t.Fatalf("sell legs do not re-sum: %s+%s+%s != %s", sr.Net, sr.Tax, sr.Fee, sr.Gross)
	}
	if lots := getLots(s, dl, dl); len(lots) != 1 || lots[0].count.Cmp(big.NewInt(50)) != 0 || lots[0].acq != 109775600 {
		t.Fatalf("legacy cohort after partial sell = %+v", lots)
	}
	check("after legacy sell 0.50")

	// Transfer 0.25 from a two-cohort position: freshest lot leaves first, clock carried.
	if err := TransferCredits(s, lb, so, lb, dl, b+3, big.NewInt(25)); err != nil {
		t.Fatalf("transfer 0.25: %v", err)
	}
	sl := getLots(s, so, lb)
	if len(sl) != 2 || sl[0].count.Cmp(big.NewInt(75)) != 0 || sl[0].acq != 109951631 || sl[1].count.Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("sender lots after 0.25 out = %+v", sl)
	}
	rl := getLots(s, so, dl)
	if len(rl) != 1 || rl[0].count.Cmp(big.NewInt(25)) != 0 || rl[0].acq != 109951631 {
		t.Fatalf("receiver lots = %+v, want the freshest cohort's clock carried", rl)
	}
	check("after transfer 0.25")

	// Ask -> Answer -> Rate on hbd-temp (face 1.000 HBD; the asker holds 1.00 token).
	// The short TWAP ring has 3 observations on chain (MinObsCount is 8), so the
	// settlement rate falls back to spot exactly as it did for the live ask at
	// block 110112084; the quote is the contract's own.
	sq, err := SettleSpend(s, hb, b+4, OfferingPrice(s, hb, 1))
	if err != nil {
		t.Fatalf("settle quote: %v", err)
	}
	wantCredits := sq.Credits
	ar, err := Ask(s, lb, hb, b+4, big.NewInt(100), "ask-v6fixture1", MinAskDeadline, 1)
	if err != nil {
		t.Fatalf("ask: %v", err)
	}
	if ar.CreditsSpent.Cmp(wantCredits) != 0 || ar.CreditsSpent.Cmp(tk(1)) > 0 {
		t.Fatalf("ask credits %s want %s (<= 100)", ar.CreditsSpent, wantCredits)
	}
	if got := BalanceOf(s, hb, lb); got.Cmp(new(big.Int).Sub(tk(1), ar.CreditsSpent)) != 0 {
		t.Fatalf("asker balance after ask = %s", got)
	}
	check("after ask")
	creatorBefore := totalBalance(s, hb, hb)
	an, err := Answer(s, hb, hb, b+5, ar.Seq, "ans-v6fixture1")
	if err != nil {
		t.Fatalf("answer: %v", err)
	}
	if mAdd(an.CreditsToCreator, an.CommissionToOwner).Cmp(ar.CreditsSpent) != 0 {
		t.Fatalf("answer split %s+%s != %s", an.CreditsToCreator, an.CommissionToOwner, ar.CreditsSpent)
	}
	if got := totalBalance(s, hb, hb); got.Cmp(mAdd(creatorBefore, an.CreditsToCreator)) != 0 {
		t.Fatalf("creator balance after answer = %s", got)
	}
	if err := Rate(s, lb, hb, ar.Seq, 4); err != nil {
		t.Fatalf("rate: %v", err)
	}
	check("after answer+rate")

	// Ask -> Decline on lordbutterfly's market (dlmmqb holds 1.00).
	ar2, err := Ask(s, dl, lb, b+6, big.NewInt(100), "ask-v6fixture2", MinAskDeadline, 0)
	if err != nil {
		t.Fatalf("ask2: %v", err)
	}
	dr, err := Decline(s, lb, lb, b+7, ar2.Seq)
	if err != nil {
		t.Fatalf("decline: %v", err)
	}
	if dr.CreditsReturned.Cmp(ar2.CreditsSpent) != 0 || BalanceOf(s, lb, dl).Cmp(tk(1)) != 0 {
		t.Fatalf("decline returned %s of %s; balance %s", dr.CreditsReturned, ar2.CreditsSpent, BalanceOf(s, lb, dl))
	}
	check("after decline")

	// Ask -> Reclaim on stayoutoftherz (lordbutterfly holds 3.75 after the transfer).
	ar3, err := Ask(s, lb, so, b+8, big.NewInt(200), "ask-v6fixture3", MinAskDeadline, 0)
	if err != nil {
		t.Fatalf("ask3: %v", err)
	}
	if _, err := Reclaim(s, sink, so, b+8+MinAskDeadline+ReclaimGrace, ar3.Seq); err == nil {
		t.Fatal("reclaim inside the grace window must be refused")
	}
	rc, err := Reclaim(s, sink, so, b+8+MinAskDeadline+ReclaimGrace+1, ar3.Seq)
	if err != nil {
		t.Fatalf("reclaim: %v", err)
	}
	if mAdd(rc.CreditsReturned, rc.CommissionRetainedCredits).Cmp(ar3.CreditsSpent) != 0 {
		t.Fatalf("reclaim split %s+%s != %s", rc.CreditsReturned, rc.CommissionRetainedCredits, ar3.CreditsSpent)
	}
	slice := mMulDiv(mMulDiv(ar3.CreditsSpent, big.NewInt(int64(CommissionBps)), big.NewInt(10000)), big.NewInt(2500), big.NewInt(10000))
	if slice.Cmp(big.NewInt(MissReclaimFloorUnits)) < 0 {
		slice = big.NewInt(MissReclaimFloorUnits)
	}
	if slice.Cmp(ar3.CreditsSpent) > 0 {
		slice = ar3.CreditsSpent
	}
	if rc.CommissionRetainedCredits.Cmp(slice) != 0 {
		t.Fatalf("miss slice %s want %s (max(25%% of 12%%, one-token floor), clamped)", rc.CommissionRetainedCredits, slice)
	}
	b = b + 8 + MinAskDeadline + ReclaimGrace + 2
	check("after reclaim")

	// Cap: existing caps read as MaxCap; a new cap in units below MinCap is refused.
	if err := SetCap(s, lb, lb, b, MinCap-1); err == nil {
		t.Fatal("cap below 1.00 token must be refused")
	}
	if err := SetCap(s, lb, lb, b, 50_000_00); err != nil {
		t.Fatalf("set cap 50000.00: %v", err)
	}
	if Cap(s, lb).Cmp(big.NewInt(5_000_000)) != 0 {
		t.Fatalf("cap = %s", Cap(s, lb))
	}
	check("after set cap")

	// Wind-down: Retire godfish, pro-rata Refund of 0.33 tokens, RefundHolder the
	// rest, CloseIfDrained at supply 0.
	if err := Retire(s, gf, gf, b); err != nil {
		t.Fatalf("retire: %v", err)
	}
	b += GraceBlocks + 1
	resBefore := new(big.Int).Set(Reserve(s, gf))
	supGf := new(big.Int).Set(Supply(s, gf))
	if price := RefundPrice(s, gf); price.Cmp(mMulDiv(resBefore, unitsScale, supGf)) != 0 {
		t.Fatalf("refund price per whole token = %s, want floor(%s x 100 / %s)", price, resBefore, supGf)
	}
	net, err := Refund(s, lb, gf, b, big.NewInt(33))
	if err != nil {
		t.Fatalf("refund 0.33: %v", err)
	}
	// Pro-rata on units, floored: gross == floor(reserve x 33 / supply).
	gross := new(big.Int).Sub(resBefore, Reserve(s, gf))
	if gross.Cmp(mMulDiv(resBefore, big.NewInt(33), supGf)) != 0 || net.Cmp(gross) > 0 || net.Sign() <= 0 {
		t.Fatalf("refund 0.33: gross %s want %s, net %s", gross, mMulDiv(resBefore, big.NewInt(33), supGf), net)
	}
	if BalanceOf(s, gf, lb).Cmp(big.NewInt(167)) != 0 {
		t.Fatalf("after refund 0.33 balance = %s want 167", BalanceOf(s, gf, lb))
	}
	check("after refund 0.33")
	// A still-taxed holder cannot be pushed out by a third party (RefundHolder is
	// gated until their tax has decayed or the wind-down has lasted a full window);
	// they exit the rest themselves.
	if _, err := RefundHolder(s, sink, gf, lb, b+1); err == nil {
		t.Fatal("permissionless refund of a still-taxed holder must be refused")
	}
	if _, err := Refund(s, lb, gf, b+1, big.NewInt(167)); err != nil {
		t.Fatalf("refund remainder: %v", err)
	}
	if Supply(s, gf).Sign() != 0 {
		t.Fatalf("godfish supply after full refund = %s", Supply(s, gf))
	}
	if !CloseIfDrained(s, gf, b+2) {
		t.Fatal("CloseIfDrained must fire at supply 0")
	}
	check("after close")

	// Maturity: the legacy dlmmqb position on lordbutterfly's market (acq
	// 109772089, never ledgered) matures at acq+ExitTaxDecayBlocks; Graduate moves
	// the whole 1.00 token; then Approve + TransferMatured 0.50 of it.
	b = 109772089 + ExitTaxDecayBlocks
	if !maturedNow(s, lb, dl, b) {
		t.Fatal("legacy position should read matured at acq+window")
	}
	if moved := Graduate(s, lb, dl, b); moved.Cmp(tk(1)) != 0 {
		t.Fatalf("graduate moved %s want 100", moved)
	}
	if MaturedOf(s, lb, dl).Cmp(tk(1)) != 0 || MaturingOf(s, lb, dl).Sign() != 0 || BalanceOf(s, lb, dl).Cmp(tk(1)) != 0 {
		t.Fatalf("after graduate: matured %s maturing %s total %s", MaturedOf(s, lb, dl), MaturingOf(s, lb, dl), BalanceOf(s, lb, dl))
	}
	check("after graduate")
	if err := Approve(s, dl, sink, lb, big.NewInt(0), big.NewInt(50)); err != nil {
		t.Fatalf("approve: %v", err)
	}
	if err := TransferMatured(s, lb, dl, dv, sink, big.NewInt(50)); err != nil {
		t.Fatalf("transfer matured via allowance: %v", err)
	}
	if MaturedOf(s, lb, dv).Cmp(big.NewInt(50)) != 0 || MaturedOf(s, lb, dl).Cmp(big.NewInt(50)) != 0 || AllowanceOf(s, dl, sink, lb).Sign() != 0 {
		t.Fatalf("matured transfer: dv=%s dl=%s allowance=%s", MaturedOf(s, lb, dv), MaturedOf(s, lb, dl), AllowanceOf(s, dl, sink, lb))
	}
	check("after matured transfer")
	// A matured sell pays no exit tax.
	msr, err := Sell(s, dv, lb, b+1, big.NewInt(50))
	if err != nil {
		t.Fatalf("matured sell: %v", err)
	}
	if msr.Tax.Sign() != 0 || msr.MaturedBurned.Cmp(big.NewInt(50)) != 0 {
		t.Fatalf("matured sell tax=%s burned=%s", msr.Tax, msr.MaturedBurned)
	}
	check("after matured sell")

	// RefundHolder (permissionless push-out) once the wind-down has lasted a full
	// tax window: retire hbd-temp, wait, push every holder out, close.
	b += 3
	if err := Retire(s, hb, hb, b); err != nil {
		t.Fatalf("retire hbd-temp: %v", err)
	}
	b += GraceBlocks + ExitTaxDecayBlocks + 1
	for _, h := range mnHolders(raw, hb) {
		if totalBalance(s, hb, h).Sign() == 0 {
			continue
		}
		if _, err := RefundHolder(s, sink, hb, h, b); err != nil {
			t.Fatalf("refund holder %s: %v", h, err)
		}
		if totalBalance(s, hb, h).Sign() != 0 {
			t.Fatalf("holder %s still holds %s after push-out", h, totalBalance(s, hb, h))
		}
	}
	if Supply(s, hb).Sign() != 0 || !CloseIfDrained(s, hb, b) {
		t.Fatalf("hbd-temp not drained/closed: supply %s", Supply(s, hb))
	}
	check("after push-out and close")

	// A brand-new market on the migrated store is born in units and untouched by
	// the migration (no flag needed, no x100).
	rr, err := RegisterWithFirstBuy(s, "hive:newcomer", "hive:newcomer", b+2, 1000, MaxCap, big.NewInt(250))
	if err != nil {
		t.Fatalf("register with first buy 2.50: %v", err)
	}
	if rr.TotalDue.Sign() <= 0 || Supply(s, "hive:newcomer").Cmp(big.NewInt(250)) != 0 || Reserve(s, "hive:newcomer").Cmp(Area(big.NewInt(250))) != 0 {
		t.Fatalf("new market: due %s supply %s reserve %s", rr.TotalDue, Supply(s, "hive:newcomer"), Reserve(s, "hive:newcomer"))
	}
	all := append(append([]string{}, f.Markets...), "hive:newcomer")
	mnAssertI3(t, raw, s, all, "after new market")

	// HBD pots are untouched by the unit change and still pull.
	if _, err := ClaimTradeFees(s, lb); err != nil {
		t.Fatalf("claim trade fees: %v", err)
	}
	if _, err := WithdrawTreasury(s, Owner(s), big.NewInt(1)); err != nil {
		t.Fatalf("withdraw treasury: %v", err)
	}
	mnAssertI3(t, raw, s, all, "end")
}
