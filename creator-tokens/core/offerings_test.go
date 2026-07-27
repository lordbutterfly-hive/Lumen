package core

import (
	"math/big"
	"strings"
	"testing"
)

// offerings_test.go — the creator's shop (offerings.go, 2026-07-27).
//
// The claims under test, in the order they matter:
//  1. offering 0 IS the legacy face price (asserted here directly; the whole
//     pre-existing ask suite passing through harness_test.go's askAt0 shim is
//     the broader evidence);
//  2. an ask against a named offering settles at THAT offering's price;
//  3. a withdrawn or never-created offering cannot be bought;
//  4. deleting an offering NEVER touches an escrow already opened against it —
//     a creator must not be able to strand a buyer's funds by withdrawing a
//     service after being paid for it;
//  5. the price band is the SAME 2x/7d anti-rug band face gets, per offering;
//  6. re-registration leaks nothing across the epoch;
//  7. the catalogue is bounded, and a delete frees a slot;
//  8. ids are never reused, so an escrow's recorded id cannot be relabelled.

func offSetup(t *testing.T) (*MemStore, string) {
	t.Helper()
	s := NewMemStore()
	setupMarket(s, "offcreator", 1000, 1_000_000_000)
	// setupMarket does not post a face (it only seeds registeredAt/paidUntil/
	// cap), and offering id 0 IS the face price, so post one explicitly.
	setMoney(s, kFace("offcreator"), big.NewInt(2500))
	setU64(s, kFaceSetAt("offcreator"), 1000)
	return s, "offcreator"
}

// ---- 1. id 0 is the face price -------------------------------------------

func TestOfferings_IdZeroIsTheFacePrice(t *testing.T) {
	s, c := offSetup(t)
	face := getMoney(s, kFace(c))
	if face.Sign() <= 0 {
		t.Fatalf("setup: face = %s, want > 0", face)
	}
	if got := OfferingPrice(s, c, 0); got.Cmp(face) != 0 {
		t.Fatalf("OfferingPrice(id 0) = %s, want the face price %s", got, face)
	}
	// And id 0 is never allocated by CreateOffering.
	id, err := CreateOffering(s, c, c, 2000, "15-min call", 2500)
	if err != nil {
		t.Fatal(err)
	}
	if id == 0 {
		t.Fatal("CreateOffering allocated id 0 — id 0 is reserved for the face price")
	}
}

// ---- 2. an ask settles at the offering's own price ------------------------

func TestOfferings_AskSettlesAtTheOfferingPrice(t *testing.T) {
	s, c := offSetup(t)
	// Two offerings at clearly different prices, both far from the face.
	cheap, err := CreateOffering(s, c, c, 2000, "quick question", 40_000)
	if err != nil {
		t.Fatal(err)
	}
	dear, err := CreateOffering(s, c, c, 2000, "custom song", 800_000)
	if err != nil {
		t.Fatal(err)
	}
	if got := OfferingPrice(s, c, cheap); got.Cmp(big.NewInt(40_000)) != 0 {
		t.Fatalf("cheap offering price = %s, want 40000", got)
	}
	if got := OfferingPrice(s, c, dear); got.Cmp(big.NewInt(800_000)) != 0 {
		t.Fatalf("dear offering price = %s, want 800000", got)
	}

	// Fund a buyer and ask against each. The dear service must cost strictly
	// more credits than the cheap one at the same rate — that IS the feature.
	// 4,000 tokens, not 400: the settlement spend cap refuses an ask costing
	// more than 5% of supply, and the dear service deliberately costs ~20x the
	// cheap one, so the market has to be deep enough to clear it.
	if _, err := Buy(s, "buyer", c, 2000, big.NewInt(4000)); err != nil {
		t.Fatal(err)
	}
	// A settleable rate needs a genuinely spanning observation history (the
	// long ring samples at most once per LongObsSpacing) — seedSettleObs
	// builds one and returns the block to query at.
	qb := seedSettleObs(s, c, 2000, SpotRate(getMoney(s, kSupply(c))))
	setU64(s, kPaidUntil(c), qb+SubscriptionPeriod)
	cheapRes, err := Ask(s, "buyer", c, qb, big.NewInt(1_000_000), commissionOwedFor(big.NewInt(40_000)), "q1", MinAskDeadline, cheap)
	if err != nil {
		t.Fatalf("ask against the cheap offering: %v", err)
	}
	dearRes, err := Ask(s, "buyer", c, qb, big.NewInt(1_000_000), commissionOwedFor(big.NewInt(800_000)), "q2", MinAskDeadline, dear)
	if err != nil {
		t.Fatalf("ask against the dear offering: %v", err)
	}
	if dearRes.CreditsSpent.Cmp(cheapRes.CreditsSpent) <= 0 {
		t.Fatalf("dear ask spent %s credits, cheap spent %s — the offering price is not being used",
			dearRes.CreditsSpent, cheapRes.CreditsSpent)
	}
	// The commission leg follows the offering price too, not the face.
	if got := commissionOwedFor(big.NewInt(800_000)); dearRes.CommissionHbd.Cmp(got) != 0 {
		t.Fatalf("dear ask commission = %s, want commissionOwedFor(800000) = %s", dearRes.CommissionHbd, got)
	}
}

// ---- 3. unknown / withdrawn offerings cannot be bought --------------------

func TestOfferings_AskAgainstUnknownOrDeletedIsRefused(t *testing.T) {
	s, c := offSetup(t)
	if _, err := Buy(s, "buyer", c, 2000, big.NewInt(400)); err != nil {
		t.Fatal(err)
	}

	// Never created.
	_, err := Ask(s, "buyer", c, 2100, big.NewInt(1_000_000), commissionOwedFor(big.NewInt(600)), "q", MinAskDeadline, 99)
	if err == nil {
		t.Fatal("ask against a never-created offering succeeded, want refusal")
	}
	if e, ok := err.(*Err); !ok || e.Symbol != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}

	// Created then deleted.
	id, err := CreateOffering(s, c, c, 2000, "gone soon", 600)
	if err != nil {
		t.Fatal(err)
	}
	if err := DeleteOffering(s, c, c, id); err != nil {
		t.Fatal(err)
	}
	if got := OfferingPrice(s, c, id); got.Sign() != 0 {
		t.Fatalf("deleted offering still prices at %s, want 0", got)
	}
	if _, err := Ask(s, "buyer", c, 2100, big.NewInt(1_000_000), commissionOwedFor(big.NewInt(600)), "q", MinAskDeadline, id); err == nil {
		t.Fatal("ask against a deleted offering succeeded, want refusal")
	}
}

// ---- 4. deleting an offering never touches a live escrow ------------------

func TestOfferings_DeleteDoesNotStrandAnEscrow(t *testing.T) {
	s, c := offSetup(t)
	id, err := CreateOffering(s, c, c, 2000, "personalised video", 5000)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, "buyer", c, 2000, big.NewInt(400)); err != nil {
		t.Fatal(err)
	}
	qb := seedSettleObs(s, c, 2000, SpotRate(getMoney(s, kSupply(c))))
	setU64(s, kPaidUntil(c), qb+SubscriptionPeriod)
	res, err := Ask(s, "buyer", c, qb, big.NewInt(1_000_000), commissionOwedFor(big.NewInt(5000)), "make me a video", MinAskDeadline, id)
	if err != nil {
		t.Fatal(err)
	}
	escrowed := res.CreditsSpent

	// The creator withdraws the service AFTER being paid for it.
	if err := DeleteOffering(s, c, c, id); err != nil {
		t.Fatal(err)
	}

	// The escrow is untouched: same credits, same offering id recorded, and
	// the buyer can still reclaim in full once the deadline passes.
	rec, ok := loadEscrow(s, c, res.Seq)
	if !ok {
		t.Fatal("escrow vanished after the offering was deleted")
	}
	if rec.credits.Cmp(escrowed) != 0 {
		t.Fatalf("escrowed credits = %s, want %s unchanged by the delete", rec.credits, escrowed)
	}
	if rec.offeringID != id {
		t.Fatalf("escrow offeringID = %d, want %d — the record must name the service that was bought", rec.offeringID, id)
	}
	balBefore := getMoney(s, kBal(c, "buyer"))
	if _, err := Reclaim(s, "buyer", c, qb+MinAskDeadline+ReclaimGrace+1, res.Seq); err != nil {
		t.Fatalf("reclaim after the offering was deleted: %v", err)
	}
	balAfter := getMoney(s, kBal(c, "buyer"))
	if got := new(big.Int).Sub(balAfter, balBefore); got.Cmp(escrowed) != 0 {
		t.Fatalf("reclaimed %s credits, want the full escrowed %s — a deleted offering must not strand funds", got, escrowed)
	}
}

// ---- 5. the per-offering 2x/7d band --------------------------------------

func TestOfferings_PriceBandIsTheSameAsFaces(t *testing.T) {
	s, c := offSetup(t)
	id, err := CreateOffering(s, c, c, 2000, "call", 1000)
	if err != nil {
		t.Fatal(err)
	}
	// Inside the window: 2x up is the edge and must pass; beyond it must not.
	if err := SetOfferingPrice(s, c, c, 2001, id, 2000); err != nil {
		t.Fatalf("2x change inside the band: %v", err)
	}
	if err := SetOfferingPrice(s, c, c, 2002, id, 4001); err == nil {
		t.Fatal("a >2x change inside the window succeeded, want the band to refuse")
	}
	// Out of range is refused regardless of the band.
	if err := SetOfferingPrice(s, c, c, 2003, id, MinFace-1); err == nil {
		t.Fatal("a sub-MinFace price succeeded, want refusal")
	}
	if err := SetOfferingPrice(s, c, c, 2003, id, MaxFace+1); err == nil {
		t.Fatal("a super-MaxFace price succeeded, want refusal")
	}
	// A relabel must NOT move the price or its band window.
	before := OfferingPrice(s, c, id)
	if err := SetOfferingTitle(s, c, c, id, "renamed call"); err != nil {
		t.Fatal(err)
	}
	if after := OfferingPrice(s, c, id); after.Cmp(before) != 0 {
		t.Fatalf("relabel moved the price %s -> %s", before, after)
	}
	if got := OfferingTitle(s, c, id); got != "renamed call" {
		t.Fatalf("title = %q, want %q", got, "renamed call")
	}
}

// ---- 6. nothing leaks across a re-registration ---------------------------

func TestOfferings_ReRegistrationClearsTheCatalogue(t *testing.T) {
	s, c := offSetup(t)
	id, err := CreateOffering(s, c, c, 2000, "call", 1000)
	if err != nil {
		t.Fatal(err)
	}
	epochBefore := offerEpoch(s, c)

	// Wind the market all the way to CLOSED, then re-register.
	setStr(s, kState(c), StateClosed)
	if err := Register(s, c, c, 3000, 2500, 1000); err != nil {
		t.Fatalf("re-register: %v", err)
	}

	if got := offerEpoch(s, c); got == epochBefore {
		t.Fatalf("offering epoch %d unchanged by Register — the dead catalogue is still reachable", got)
	}
	if got := OfferingPrice(s, c, id); got.Sign() != 0 {
		t.Fatalf("old offering still prices at %s after re-registration, want 0", got)
	}
	if got := OfferingTitle(s, c, id); got != "" {
		t.Fatalf("old offering title %q survived re-registration", got)
	}
	if got := ListOfferings(s, c); len(got) != 0 {
		t.Fatalf("new incarnation lists %d offerings, want 0", len(got))
	}
	// And the fresh incarnation posts through the INITIAL-posting branch, so
	// it cannot be banded against the dead incarnation's anchor (the H4 class).
	newID, err := CreateOffering(s, c, c, 3001, "fresh", MaxFace)
	if err != nil {
		t.Fatalf("first offering of a new incarnation must accept any in-range price: %v", err)
	}
	if got := OfferingPrice(s, c, newID); got.Cmp(big.NewInt(MaxFace)) != 0 {
		t.Fatalf("fresh offering price = %s, want %d", got, MaxFace)
	}
}

// ---- 7. the catalogue is bounded, delete frees a slot ---------------------

func TestOfferings_CatalogueIsBoundedAndDeleteFreesASlot(t *testing.T) {
	s, c := offSetup(t)
	var last uint64
	for i := uint64(0); i < MaxOfferings; i++ {
		id, err := CreateOffering(s, c, c, 2000, "svc", 1000)
		if err != nil {
			t.Fatalf("create %d of %d: %v", i+1, MaxOfferings, err)
		}
		last = id
	}
	if _, err := CreateOffering(s, c, c, 2000, "one too many", 1000); err == nil {
		t.Fatalf("created offering %d, want the MaxOfferings=%d cap to refuse", MaxOfferings+1, MaxOfferings)
	}
	if got := ListOfferings(s, c); uint64(len(got)) != MaxOfferings {
		t.Fatalf("listed %d offerings, want %d", len(got), MaxOfferings)
	}
	if err := DeleteOffering(s, c, c, last); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateOffering(s, c, c, 2000, "back under the cap", 1000); err != nil {
		t.Fatalf("a delete must free a slot: %v", err)
	}
}

// ---- 8. ids are never reused --------------------------------------------

func TestOfferings_IdsAreNeverReused(t *testing.T) {
	s, c := offSetup(t)
	first, err := CreateOffering(s, c, c, 2000, "a", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if err := DeleteOffering(s, c, c, first); err != nil {
		t.Fatal(err)
	}
	second, err := CreateOffering(s, c, c, 2000, "b", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if second == first {
		t.Fatalf("id %d was reused after a delete — an escrow's recorded offeringID would be silently relabelled", second)
	}
}

// ---- authority, validation, and the CLOSED gate --------------------------

func TestOfferings_CreatorOnly(t *testing.T) {
	s, c := offSetup(t)
	if _, err := CreateOffering(s, "stranger", c, 2000, "not yours", 1000); err == nil {
		t.Fatal("a stranger created an offering on someone else's market")
	}
	id, err := CreateOffering(s, c, c, 2000, "mine", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if err := SetOfferingPrice(s, "stranger", c, 2001, id, 2000); err == nil {
		t.Fatal("a stranger repriced someone else's offering")
	}
	if err := SetOfferingTitle(s, "stranger", c, id, "hijacked"); err == nil {
		t.Fatal("a stranger relabelled someone else's offering")
	}
	if err := DeleteOffering(s, "stranger", c, id); err == nil {
		t.Fatal("a stranger deleted someone else's offering")
	}
}

func TestOfferings_TitleValidation(t *testing.T) {
	s, c := offSetup(t)
	bad := []struct {
		name  string
		title string
	}{
		{"empty", ""},
		{"pipe", "a|b"},  // the packed-record separator
		{"comma", "a,b"}, // the live-id list separator
		{"too long", strings.Repeat("x", MaxOfferTitleLen+1)},
	}
	for _, tc := range bad {
		if _, err := CreateOffering(s, c, c, 2000, tc.title, 1000); err == nil {
			t.Fatalf("%s title accepted, want refusal", tc.name)
		}
	}
	if _, err := CreateOffering(s, c, c, 2000, strings.Repeat("x", MaxOfferTitleLen), 1000); err != nil {
		t.Fatalf("a title of exactly MaxOfferTitleLen must be accepted: %v", err)
	}
}

// ---- the escrow layout gained a field: prove the round trip --------------

func TestOfferings_EscrowRoundTripsTheOfferingID(t *testing.T) {
	// Direct pack/unpack, because the field count is positional and load-
	// bearing: a 2026-07-24 audit found the PREVIOUS insertion had been made
	// without updating the parser, which silently shifted contentHash into
	// answerHash on every read.
	in := escrowRec{
		asker: "buyer", credits: big.NewInt(1234), deadline: 999,
		status: askPending, commissionHbd: big.NewInt(56),
		acqBlock: 4321, offeringID: 7,
		contentHash: "question-hash", answerHash: "answer-hash",
	}
	out, ok := unpackEscrow(packEscrow(in))
	if !ok {
		t.Fatal("unpackEscrow refused a record packEscrow produced")
	}
	if out.asker != in.asker || out.credits.Cmp(in.credits) != 0 || out.deadline != in.deadline ||
		out.status != in.status || out.commissionHbd.Cmp(in.commissionHbd) != 0 ||
		out.acqBlock != in.acqBlock || out.offeringID != in.offeringID ||
		out.contentHash != in.contentHash || out.answerHash != in.answerHash {
		t.Fatalf("round trip lost or shifted a field:\n in  %+v\n out %+v", in, out)
	}
	// A record with the OLD field count must be refused outright, never
	// silently reinterpreted with everything after the missing field shifted.
	oldLayout := "buyer|1234|999|" + askPending + "|56|4321|question-hash|answer-hash"
	if _, ok := unpackEscrow(oldLayout); ok {
		t.Fatal("an 8-field record parsed as a 9-field one — the exact count check is not doing its job")
	}
}
