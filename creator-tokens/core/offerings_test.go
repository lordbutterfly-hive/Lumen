package core

import (
	"encoding/json"
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
	cheap, err := CreateOffering(s, c, c, 2000, "quick question", 50_000)
	if err != nil {
		t.Fatal(err)
	}
	dear, err := CreateOffering(s, c, c, 2000, "custom song", 800_000)
	if err != nil {
		t.Fatal(err)
	}
	if got := OfferingPrice(s, c, cheap); got.Cmp(big.NewInt(50_000)) != 0 {
		t.Fatalf("cheap offering price = %s, want 50000", got)
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
	cheapRes, err := Ask(s, "buyer", c, qb, big.NewInt(1_000_000), commissionOwedFor(big.NewInt(50_000)), "q1", MinAskDeadline, cheap)
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
		// Distinct titles: as of 2026-07-28 one live offering per normalized
		// title is enforced (liveTitleOwner), because a duplicate lets the
		// title-scoped price band be ratcheted by a throwaway listing. This
		// loop only ever cared about the MaxOfferings cap, so the repeated
		// "svc" was incidental fixture, not the property under test — every
		// assertion below is unchanged.
		id, err := CreateOffering(s, c, c, 2000, "svc-"+evU64(i), 1000)
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

// ---- DEFECT FIX: the band survives delete+recreate (2026-07-27) ----------
//
// The proven bypass, restated: CreateOffering routed a brand-new id through
// setBandedPrice's initial-posting branch unconditionally, because a fresh
// id's OWN price key always reads 0. DeleteOffering frees that id's price/
// anchor, and ids are never reused (kSeq's reason) — so create at MinFace, get
// correctly refused jumping straight to 10,000,000, delete, recreate FRESH
// under the SAME title at 10,000,000, and it succeeded: a ~19,685x jump with
// zero elapsed time. The fix anchors the band to the (creator, epoch,
// NORMALIZED title) instead of the id — the tests below prove the bypass is
// closed, that the fix does not fire on a genuinely new or genuinely expired
// title, and that a rename cannot be used to launder around it either.

func TestOfferings_DeleteRecreateCannotBypassTheBand(t *testing.T) {
	s, c := offSetup(t)
	id, err := CreateOffering(s, c, c, 2000, "custom song", MinFace)
	if err != nil {
		t.Fatal(err)
	}
	// Sanity: the direct jump is refused on the LIVE id (unchanged behaviour).
	if err := SetOfferingPrice(s, c, c, 2001, id, 10_000_000); err == nil {
		t.Fatal("a >2x jump on the live id succeeded, want the band to refuse")
	}
	if err := DeleteOffering(s, c, c, id); err != nil {
		t.Fatal(err)
	}
	// THE PROVEN BYPASS: recreate fresh under the identical title at the
	// price that was just correctly refused.
	if _, err := CreateOffering(s, c, c, 2002, "custom song", 10_000_000); err == nil {
		t.Fatal("BYPASS: delete+recreate accepted a price the live id had just refused")
	} else if e, ok := err.(*Err); !ok || e.Symbol != ErrInput {
		t.Fatalf("want ErrInput, got %v", err)
	}
}

func TestOfferings_TitleAnchorSurvivesCaseAndWhitespaceDodge(t *testing.T) {
	s, c := offSetup(t)
	id, err := CreateOffering(s, c, c, 2000, "Custom Song", MinFace)
	if err != nil {
		t.Fatal(err)
	}
	if err := DeleteOffering(s, c, c, id); err != nil {
		t.Fatal(err)
	}
	// A cosmetically different spelling of the SAME title must not dodge the
	// anchor: different case, and leading/trailing whitespace.
	if _, err := CreateOffering(s, c, c, 2001, "  custom song  ", 10_000_000); err == nil {
		t.Fatal("BYPASS: whitespace-padded retitle dodged the anchor")
	}
	if _, err := CreateOffering(s, c, c, 2002, "CUSTOM SONG", 10_000_000); err == nil {
		t.Fatal("BYPASS: upper-cased retitle dodged the anchor")
	}
}

func TestOfferings_HonestFirstTimePostingStillFree(t *testing.T) {
	s, c := offSetup(t)
	// Two titles NEVER used before in this epoch: any in-range price must be
	// accepted, at both ends of [MinFace, MaxFace] — the fix must not turn
	// honest first-time posting into a false positive.
	if _, err := CreateOffering(s, c, c, 2000, "brand new service never seen before", MinFace); err != nil {
		t.Fatalf("first-ever posting at MinFace refused: %v", err)
	}
	if _, err := CreateOffering(s, c, c, 2000, "another brand new service", MaxFace); err != nil {
		t.Fatalf("first-ever posting at MaxFace refused: %v", err)
	}
}

func TestOfferings_DeleteRecreateWithinBandStillSucceeds(t *testing.T) {
	s, c := offSetup(t)
	id, err := CreateOffering(s, c, c, 2000, "call", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if err := DeleteOffering(s, c, c, id); err != nil {
		t.Fatal(err)
	}
	// Exactly 2x, the legitimate edge, via delete+recreate instead of
	// SetOfferingPrice: must be treated identically to an in-place reprice.
	id2, err := CreateOffering(s, c, c, 2001, "call", 2000)
	if err != nil {
		t.Fatalf("a legitimate 2x change via delete+recreate was refused: %v", err)
	}
	// WINDOW CONTINUITY: the anchor's ORIGIN must not have moved to the
	// recreate block, or a second delete+recreate would wrongly earn a
	// SECOND 2x on top of the first (4x total) with zero elapsed time. The
	// anchor is still 1000 (from the original create), so 2001 is already at
	// the ceiling — one more unit must be refused.
	if err := DeleteOffering(s, c, c, id2); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateOffering(s, c, c, 2002, "call", 2001); err == nil {
		t.Fatal("BYPASS: a second delete+recreate compounded past the original window's 2x ceiling")
	}
}

// TestOfferings_ExpiredWindowRecreateCannotJumpUnbounded — DEFECT 3,
// corrected (2026-07-27). This test previously asserted the OPPOSITE of its
// current name: that a recreate after the title's window "expired" must
// succeed at ANY price, including a ~17,331x jump from MinFace to MaxFace,
// "exactly like first-time posting". That assertion was pinning the exact
// defect-3 bypass an independent review found: a price that had been posted
// once and then deleted, with nothing repricing it since, "expires" exactly
// like a price that had been LIVE and STABLE for the same 7 days — and the
// old code could not tell the two apart, so it let BOTH recreate completely
// unbanded. "Any price stable for 7 days... can therefore be deleted and
// recreated at any price" is not first-time posting, it's a rug with a
// built-in 7-day fuse. The corrected behaviour: an expired window is banded
// against the LAST KNOWN price, exactly like a live id's own reprice after
// its window rolls over (setBandedPrice's own "window expired" branch) — a
// delete+recreate can never do BETTER than simply holding the id would have.
func TestOfferings_ExpiredWindowRecreateCannotJumpUnbounded(t *testing.T) {
	s, c := offSetup(t)
	const start = 2000
	id, err := CreateOffering(s, c, c, start, "call", MinFace)
	if err != nil {
		t.Fatal(err)
	}
	if err := DeleteOffering(s, c, c, id); err != nil {
		t.Fatal(err)
	}
	// One block short of the window: still active, still banded against the
	// original anchor.
	if _, err := CreateOffering(s, c, c, start+FaceBandWindow-1, "call", MaxFace); err == nil {
		t.Fatal("a recreate one block before the window elapsed was NOT banded")
	}
	// THE PROVEN BYPASS: the window has now genuinely elapsed, but that is
	// NOT a license to jump anywhere — a ~17,331x move must still be refused.
	if _, err := CreateOffering(s, c, c, start+FaceBandWindow, "call", MaxFace); err == nil {
		t.Fatal("BYPASS: an expired title window granted a fully unbanded recreate — the exact 'stable price is one delete away from unbounded' exploit")
	} else if e, ok := err.(*Err); !ok || e.Symbol != ErrInput {
		t.Fatalf("want ErrInput, got %v", err)
	}
	// The honest counterpart: exactly like a LIVE id whose window just rolled
	// over, a legitimate 2x change from the last known price still succeeds —
	// the window reopens, it does not vanish.
	if _, err := CreateOffering(s, c, c, start+FaceBandWindow+1, "call", MinFace*2); err != nil {
		t.Fatalf("a legitimate 2x recreate after the window expired was refused: %v", err)
	}
}

func TestOfferings_ReRegistrationWipesTitleAnchorsToo(t *testing.T) {
	s, c := offSetup(t)
	id, err := CreateOffering(s, c, c, 2000, "call", MinFace)
	if err != nil {
		t.Fatal(err)
	}
	// Sanity: still banded pre-registration.
	if _, err := CreateOffering(s, c, c, 2001, "call", 10_000_000); err == nil {
		t.Fatal("a second live 'call' at 10,000,000 should have been refused by the shared anchor")
	}
	if err := DeleteOffering(s, c, c, id); err != nil {
		t.Fatal(err)
	}

	setStr(s, kState(c), StateClosed)
	if err := Register(s, c, c, 3000, 2500, 1000); err != nil {
		t.Fatalf("re-register: %v", err)
	}

	// The SAME title, in the NEW epoch, must be freely priceable — a
	// re-registration is a fresh start (SPEC §1.7.5), and the title anchor is
	// epoch-scoped exactly like the rest of the catalogue (kOfferEpoch).
	if _, err := CreateOffering(s, c, c, 3001, "call", 10_000_000); err != nil {
		t.Fatalf("a title anchor survived re-registration: %v", err)
	}
}

func TestOfferings_RenameCannotLaunderAFreshTitleClaim(t *testing.T) {
	s, c := offSetup(t)
	// The second-order variant of the same bypass: relabel a banded
	// offering to a title that has never been used, delete it, and try to
	// recreate FRESH under the new name — must be refused exactly as if the
	// creator had never renamed at all.
	id, err := CreateOffering(s, c, c, 2000, "foo", MinFace)
	if err != nil {
		t.Fatal(err)
	}
	if err := SetOfferingTitle(s, c, c, id, "bar"); err != nil {
		t.Fatal(err)
	}
	if err := DeleteOffering(s, c, c, id); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateOffering(s, c, c, 2001, "bar", 10_000_000); err == nil {
		t.Fatal("BYPASS: rename-then-delete-then-recreate dodged the anchor")
	}
	// The honest in-band price must still work under the new name.
	if _, err := CreateOffering(s, c, c, 2002, "bar", 900); err != nil {
		t.Fatalf("an honest in-band recreate under the renamed title was refused: %v", err)
	}
}

// ---- DEFECT 1: a rename ONTO an already-anchored title bypassed the band --
//
// The proven attack: MinFace correctly refuses a direct >2x jump on the live
// id. Post a THROWAWAY offering under a virgin title at MaxFace (free — first
// -time posting takes no band at all). Delete the REAL, protected offering.
// Rename the throwaway ONTO the real title. The old code inherited the
// destination's band ONLY when that title's slot was virgin; when it was
// ALREADY anchored (as here), the whole `if` was skipped — no check on the
// price moving in, at all — so the throwaway's MaxFace lands under the
// protected name, a jump the direct path had just correctly refused.

func TestOfferings_RenameOntoAnchoredTitleCannotLaunderThePrice(t *testing.T) {
	s, c := offSetup(t)
	real, err := CreateOffering(s, c, c, 2000, "custom song", MinFace)
	if err != nil {
		t.Fatal(err)
	}
	// Sanity: the direct jump is refused on the live id.
	if err := SetOfferingPrice(s, c, c, 2001, real, MaxFace); err == nil {
		t.Fatal("a direct jump on the live id succeeded, want the band to refuse")
	}
	// The throwaway: a virgin title, so posting is free.
	tmp, err := CreateOffering(s, c, c, 2002, "tmp throwaway", MaxFace)
	if err != nil {
		t.Fatalf("first-time posting of the throwaway: %v", err)
	}
	if err := DeleteOffering(s, c, c, real); err != nil {
		t.Fatal(err)
	}
	// THE PROVEN BYPASS: rename the throwaway onto the now-freed, protected
	// title.
	if err := SetOfferingTitle(s, c, c, tmp, "custom song"); err == nil {
		t.Fatal("BYPASS: renaming a throwaway onto an anchored title moved an unbanded price in")
	} else if e, ok := err.(*Err); !ok || e.Symbol != ErrInput {
		t.Fatalf("want ErrInput, got %v", err)
	}
	// The refused rename must not have moved anything: the throwaway keeps
	// its own price and title untouched.
	if got := OfferingPrice(s, c, tmp); got.Cmp(big.NewInt(MaxFace)) != 0 {
		t.Fatalf("the throwaway's own price changed as a side effect of a refused rename: got %s", got)
	}
	if got := OfferingTitle(s, c, tmp); got != "tmp throwaway" {
		t.Fatalf("the throwaway's own title changed as a side effect of a refused rename: got %q", got)
	}
}

// TestOfferings_RenameOntoAnchoredTitleSucceedsWithinBand is the honest
// counterpart: the fix must not "refuse every rename onto an anchored title",
// only ones that would move a price outside that title's own band.
func TestOfferings_RenameOntoAnchoredTitleSucceedsWithinBand(t *testing.T) {
	s, c := offSetup(t)
	real, err := CreateOffering(s, c, c, 2000, "custom song", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if err := DeleteOffering(s, c, c, real); err != nil {
		t.Fatal(err)
	}
	// A different offering, priced legitimately WITHIN "custom song"'s band
	// (anchor 1000, so up to 2000).
	other, err := CreateOffering(s, c, c, 2001, "other service", 1900)
	if err != nil {
		t.Fatal(err)
	}
	if err := SetOfferingTitle(s, c, c, other, "custom song"); err != nil {
		t.Fatalf("an honest in-band rename onto an anchored title was refused: %v", err)
	}
	if got := OfferingTitle(s, c, other); got != "custom song" {
		t.Fatalf("title = %q, want %q", got, "custom song")
	}
	// The rename must still never move the price.
	if got := OfferingPrice(s, c, other); got.Cmp(big.NewInt(1900)) != 0 {
		t.Fatalf("rename moved the price: got %s, want unchanged 1900", got)
	}
}

// TestOfferings_RenameCheckUsesTheTighterOfAnchorAndLastPrice pins a
// second-order gap this fix deliberately closed while designing the DEFECT-1
// rename check: SetOfferingTitle cannot see the current block (no signature
// change — see its own doc), so it cannot tell an ACTIVE window (which
// setBandedPrice would band against the ANCHOR) from an EXPIRED one (which it
// would band against the title's LAST KNOWN PRICE instead). Checking against
// the anchor ALONE is not safe: if the last known price has legitimately
// drifted to the bottom of the anchor's own band (still valid — cur can be
// anywhere in [anchor/2, anchor*2] mid-window), an anchor-only check can admit
// a price a same-moment EXPIRED check would refuse. The fix checks against the
// INTERSECTION of both possible true bands, which can never be looser than
// either.
func TestOfferings_RenameCheckUsesTheTighterOfAnchorAndLastPrice(t *testing.T) {
	s, c := offSetup(t)
	// "custom song" opens its window at 2000 (anchor=2000), then legitimately
	// drops to 1000 within the SAME window — still valid: 1000 = anchor/2,
	// the exact floor of the 2x band (and still >= MinFace).
	real, err := CreateOffering(s, c, c, 2000, "custom song", 2000)
	if err != nil {
		t.Fatal(err)
	}
	if err := SetOfferingPrice(s, c, c, 2001, real, 1000); err != nil {
		t.Fatalf("a legitimate in-window drop to the band floor was refused: %v", err)
	}
	if err := DeleteOffering(s, c, c, real); err != nil {
		t.Fatal(err)
	}
	// A throwaway priced at 3000: within the STALE anchor's own band
	// ([1000,4000]), but OUTSIDE what an expired check against the real last
	// price (1000, band [500,2000]) would allow.
	tmp, err := CreateOffering(s, c, c, 2002, "tmp throwaway", 3000)
	if err != nil {
		t.Fatal(err)
	}
	if err := SetOfferingTitle(s, c, c, tmp, "custom song"); err == nil {
		t.Fatal("BYPASS: an anchor-only check let a price through that the title's real last-known-price band would refuse")
	} else if e, ok := err.(*Err); !ok || e.Symbol != ErrInput {
		t.Fatalf("want ErrInput, got %v", err)
	}
	// The honest counterpart: a price that fits BOTH the anchor's band AND
	// the last-known-price's band must still be allowed.
	tmp2, err := CreateOffering(s, c, c, 2003, "tmp2 throwaway", 1800)
	if err != nil {
		t.Fatal(err)
	}
	if err := SetOfferingTitle(s, c, c, tmp2, "custom song"); err != nil {
		t.Fatalf("a price within BOTH possible bands was wrongly refused: %v", err)
	}
}

// ---- DEFECT 2: an ordinary reprice laundered a foreign anchor -------------
//
// The proven chain in the original review was rename (defect 1) THEN an
// ordinary reprice, which unconditionally copied the id's OWN anchor onto the
// title. Defect 1's fix above already refuses the rename step, so that exact
// two-step chain can no longer reach the vulnerable state through the normal
// API. This test isolates defect 2's OWN mechanism directly — by writing to
// this id's cached anchor the way a successful-but-now-refused rename used
// to, bypassing the normal entry points on purpose — to prove SetOfferingPrice
// itself no longer trusts an id's own (possibly foreign, possibly stale)
// cached anchor for anything: it bands against, and only ever refreshes, the
// TITLE's own persistent state. This is a second, independent guard: even if
// some other future code path ever got a foreign value into an id's cache,
// this test proves SetOfferingPrice cannot be tricked into laundering it.
func TestOfferings_OrdinaryRepriceCannotLaunderAForeignAnchor(t *testing.T) {
	s, c := offSetup(t)
	id, err := CreateOffering(s, c, c, 2000, "custom song", 1000)
	if err != nil {
		t.Fatal(err)
	}

	// Simulate an id whose OWN cached anchor has, by some means outside the
	// normal API, come to carry a foreign, much looser value than the
	// title's real anchor (1000) — exactly what the old rename-then-reprice
	// chain produced. defect 1's own fix means this can no longer happen via
	// SetOfferingTitle; this line reproduces the resulting STATE directly so
	// defect 2's mechanism is tested in isolation.
	epoch := offerEpoch(s, c)
	setMoney(s, kOfferAnchor(c, epoch, id), big.NewInt(MaxFace))
	setU64(s, kOfferAnchorAt(c, epoch, id), 2000)

	// An ordinary, honest, in-band reprice (against the TITLE's real 1000
	// anchor) must still succeed...
	if err := SetOfferingPrice(s, c, c, 2001, id, 1900); err != nil {
		t.Fatalf("an honest in-band reprice was refused: %v", err)
	}
	// ...and must NOT have laundered the tampered MaxFace anchor onto the
	// title: a follow-up jump that only the foreign anchor would permit must
	// still be refused.
	if err := SetOfferingPrice(s, c, c, 2002, id, MaxFace); err == nil {
		t.Fatal("BYPASS: an ordinary reprice laundered a foreign anchor into the title, then a follow-up jump used it")
	}
}

// ---- DEFECT 4: a visually identical title dodged the anchor --------------
//
// normalizeOfferTitle used to be ToLower(TrimSpace) only: no internal
// whitespace collapse, no zero-width/format-character stripping. A buyer
// sees "custom song" and "custom  song" (two spaces) — or "custom song" with
// an invisible zero-width joiner spliced in — as the IDENTICAL service, but
// the old normalization keyed them to different anchors, each starting
// virgin.

func TestOfferings_InternalWhitespaceAndZeroWidthCannotDodgeTheAnchor(t *testing.T) {
	s, c := offSetup(t)
	id, err := CreateOffering(s, c, c, 2000, "custom song", MinFace)
	if err != nil {
		t.Fatal(err)
	}
	if err := DeleteOffering(s, c, c, id); err != nil {
		t.Fatal(err)
	}

	// Two internal spaces where the original had one.
	if _, err := CreateOffering(s, c, c, 2001, "custom  song", MaxFace); err == nil {
		t.Fatal("BYPASS: an internal-whitespace-run variant dodged the anchor")
	}
	// A zero-width joiner (U+200D) spliced into the middle — visually
	// identical to a buyer, byte-different without normalization.
	if _, err := CreateOffering(s, c, c, 2002, "custom‍ song", MaxFace); err == nil {
		t.Fatal("BYPASS: a zero-width-joiner variant dodged the anchor")
	}
	// A leading zero-width space.
	if _, err := CreateOffering(s, c, c, 2003, "​custom song", MaxFace); err == nil {
		t.Fatal("BYPASS: a leading zero-width-space variant dodged the anchor")
	}
	// A tab in place of the internal space.
	if _, err := CreateOffering(s, c, c, 2004, "custom\tsong", MaxFace); err == nil {
		t.Fatal("BYPASS: a tab-for-space variant dodged the anchor")
	}
}

// TestOfferings_NormalizationDoesNotCollapseGenuinelyDifferentTitles is the
// honest counterpart: the fix must narrow collisions, not homogenize
// everything. A genuinely different title (even one that also happens to
// have a double space) is its own, freely-priceable title, and legitimate
// unicode/emoji/punctuation titles are unaffected.
func TestOfferings_NormalizationDoesNotCollapseGenuinelyDifferentTitles(t *testing.T) {
	s, c := offSetup(t)
	if _, err := CreateOffering(s, c, c, 2000, "custom song", MinFace); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateOffering(s, c, c, 2000, "custom  poem", MaxFace); err != nil {
		t.Fatalf("a genuinely different title was wrongly banded: %v", err)
	}
	if _, err := CreateOffering(s, c, c, 2000, "🎵 custom song — ₿ special €dition 日本語", MaxFace); err != nil {
		t.Fatalf("a legitimate unicode/emoji title was wrongly banded: %v", err)
	}
}

// ---- DEFECT FIX: raw control bytes in a title break the event log --------
//
// validOfferTitle rejected only '|' and ','. A title containing a raw
// newline/tab/NUL/BEL is accepted and embedded UNESCAPED into
// EvOfferingCreated/EvOfferingUpdated (events.go's evJSONEscape escapes only
// '"' and '\'), and the resulting log line fails encoding/json.Unmarshal —
// verified directly below — so magi-indexer/creator_tokens_mappings.yaml's ParseEvent drops the
// event silently. The fix rejects bytes < 0x20 and 0x7f at the one door
// every title passes through.

func TestOfferings_TitleControlBytesRejected(t *testing.T) {
	s, c := offSetup(t)
	bad := []struct {
		name  string
		title string
	}{
		{"newline", "evil\ntitle"},
		{"tab", "evil\ttitle"},
		{"nul", "evil\x00title"},
		{"bel(0x07)", "evil\x07title"},
		{"del(0x7f)", "evil\x7ftitle"},
	}
	for _, tc := range bad {
		if _, err := CreateOffering(s, c, c, 2000, tc.title, 1000); err == nil {
			t.Fatalf("%s: control-byte title accepted, want refusal", tc.name)
		} else if e, ok := err.(*Err); !ok || e.Symbol != ErrInput {
			t.Fatalf("%s: want ErrInput, got %v", tc.name, err)
		}
	}
}

// TestOfferings_ShopClosesOnRetireButDeleteStillWorks — a retired market's
// shop is read-only for NEW listings and price/title changes, but DELETE is
// the one exception (DEFECT 5 FIX, 2026-07-27, corrected from
// TestOfferings_ShopClosesOnRetire which previously asserted delete was ALSO
// refused after Retire).
//
// Retire permanently closes inflows (RequireInflowOpen consults
// marketRetired), so anything listed or repriced afterwards can never be
// bought by anyone — the shop is the buyer-facing catalogue, and a fresh
// listing there reads as available. That is still true and still enforced
// below for Create/SetPrice/SetTitle. But a prior change widened
// DeleteOffering's OWN guard to the same requireShopEditable, which took away
// a retiring creator's only way to pull a listing nobody can ever buy again —
// the opposite of what the guard is for. DeleteOffering moves no funds and
// never touches an escrow already opened against the id (existing escrows
// resolve on the answer/reclaim rails, which never consult the shop at all),
// so there is no fund-safety reason to refuse it once retired.
func TestOfferings_ShopClosesOnRetireButDeleteStillWorks(t *testing.T) {
	s, c := offSetup(t)
	id, err := CreateOffering(s, c, c, 2000, "call", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if err := Retire(s, c, c, 2100); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	if _, err := CreateOffering(s, c, c, 2200, "new service", 1000); err == nil {
		t.Fatal("created a new offering on a RETIRED market — nobody could ever buy it")
	}
	if err := SetOfferingPrice(s, c, c, 2200, id, 1500); err == nil {
		t.Fatal("repriced an offering on a RETIRED market")
	}
	if err := SetOfferingTitle(s, c, c, id, "renamed"); err == nil {
		t.Fatal("retitled an offering on a RETIRED market")
	}
	// THE FIX: delete must still work — the creator's only way to withdraw a
	// listing after retiring.
	if err := DeleteOffering(s, c, c, id); err != nil {
		t.Fatalf("BYPASS-OF-A-DIFFERENT-KIND: delete must still work on a RETIRED market, got: %v", err)
	}
	if got := OfferingPrice(s, c, id); got.Sign() != 0 {
		t.Fatalf("deleted offering still prices at %s after retire, want 0", got)
	}
	if got := OfferingTitle(s, c, id); got != "" {
		t.Fatalf("deleted offering still titled %q after retire, want empty", got)
	}
}

func TestOfferings_TitleUnicodeAndEmojiAccepted(t *testing.T) {
	s, c := offSetup(t)
	title := "🎵 custom song — ₿ special €dition 日本語"
	id, err := CreateOffering(s, c, c, 2000, title, 1000)
	if err != nil {
		t.Fatalf("a legitimate unicode/emoji/currency title was refused: %v", err)
	}
	if got := OfferingTitle(s, c, id); got != title {
		t.Fatalf("title round-tripped as %q, want %q", got, title)
	}
}

// TestOfferings_ControlByteWouldHaveBrokenTheEventLog documents the actual
// mechanism the validOfferTitle fix closes, independent of the fix itself:
// EvOfferingCreated is a pure string builder (events.go) that performs no
// validation of its own by design ("meant to be called only AFTER the
// corresponding core.* call already succeeded") — so this calls it directly
// with a title CreateOffering would now refuse, to prove that title would
// have produced an event line encoding/json.Unmarshal cannot parse, exactly
// as magi-indexer/creator_tokens_mappings.yaml's ParseEvent would receive it.
func TestOfferings_ControlByteWouldHaveBrokenTheEventLog(t *testing.T) {
	line := EvOfferingCreated("c", "c", 2000, 1, "evil\ntitle", big.NewInt(1000))
	var v map[string]any
	if err := json.Unmarshal([]byte(line), &v); err == nil {
		t.Fatal("a raw newline in the title did NOT break json.Unmarshal — the proven mechanism no longer holds, re-check the defect")
	}
	// A title validOfferTitle still accepts (unicode/emoji) must parse fine.
	clean := EvOfferingCreated("c", "c", 2000, 1, "🎵 custom song ₿", big.NewInt(1000))
	if err := json.Unmarshal([]byte(clean), &v); err != nil {
		t.Fatalf("a clean unicode title's event line failed to parse: %v", err)
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

// ---- 2026-07-28 hunt findings --------------------------------------------

// TestOfferings_OneLiveOfferingPerTitle blocks the phantom-cur ratchet.
//
// THE EXPLOIT (measured before the fix): the 2x/7-day anti-rug band is keyed
// by TITLE, and its "last known price" slot (kOfferTitlePrice, the `cur` half)
// was shared by every offering with that title. Nothing rejected two LIVE
// offerings sharing one. So a creator could park `cur` at a price no live
// offering posts, and the next window would re-anchor from it:
//
//	CreateOffering("custom song", 1200)  -> title{cur 1200, anchor 1200}
//	SetOfferingPrice(id1, 600)           -> legal, floor of the anchor band
//	CreateOffering("custom song", 2400)  -> ACCEPTED (duplicate), cur := 2400
//	DeleteOffering(id2)                  -> cur STAYS 2400 (delete never
//	                                        clears the title's keys)
//	...one window later: SetOfferingPrice(id1, 4800) ACCEPTED
//
// 4x the headroom the band grants, and the buyer-visible price moves 600 ->
// 4800 (8x) in one transaction where an honest creator is capped at 2x. It
// was sustainable: hold cur/visible = 4 across windows indefinitely.
//
// Root cause was two different rules for one state transition —
// SetOfferingTitle gates through withinTitleBand (anchor AND cur), while
// CreateOffering went through applyTitleBandedPrice (anchor only). This test
// pins the door that was loose, and the rename door beside it.
func TestOfferings_OneLiveOfferingPerTitle(t *testing.T) {
	s, c := offSetup(t)

	if _, err := CreateOffering(s, c, c, 2000, "custom song", 1200); err != nil {
		t.Fatalf("first offering: %v", err)
	}

	// The ratchet's load-bearing step: a SECOND live offering under the same
	// title, whose only purpose is to move the shared `cur`.
	if _, err := CreateOffering(s, c, c, 2000, "custom song", 2400); err == nil {
		t.Fatal("PHANTOM-CUR RATCHET: a second LIVE offering under an existing title was accepted. Its price becomes the title band's shared `cur`, and deleting it leaves `cur` parked there — so the next window re-anchors off a price nothing posts, granting ~4x the headroom the 2x band is supposed to allow.")
	}

	// Cosmetic variants normalize to the same title and must be refused too,
	// or the rule is trivially bypassed.
	for _, variant := range []string{"Custom Song", "  custom   song  ", "CUSTOM song"} {
		if _, err := CreateOffering(s, c, c, 2000, variant, 2400); err == nil {
			t.Fatalf("variant %q normalizes onto a live title and was accepted — the duplicate rule must key on the NORMALIZED title, which is what the band keys on", variant)
		}
	}

	// The rename door must enforce the same rule.
	other, err := CreateOffering(s, c, c, 2000, "mixing session", 1200)
	if err != nil {
		t.Fatalf("second distinct offering: %v", err)
	}
	if err := SetOfferingTitle(s, c, c, other, "custom song"); err == nil {
		t.Fatal("renaming an offering ONTO a live title was accepted — rename is a second door into the duplicate-title state")
	}

	// ...but renaming an offering to a cosmetic variant of ITS OWN title must
	// still work: the rule is one live offering per title, not a ban on
	// touching your own.
	if err := SetOfferingTitle(s, c, c, other, "Mixing Session"); err != nil {
		t.Fatalf("renaming an offering to a variant of its own title must be allowed: %v", err)
	}
	// And a genuinely free title is still available.
	if err := SetOfferingTitle(s, c, c, other, "mastering"); err != nil {
		t.Fatalf("renaming onto an unused title must be allowed: %v", err)
	}
}

// TestOfferings_TitleMustHaveAVisibleCharacter — validOfferTitle checked the
// RAW string for emptiness, so anything made only of characters
// normalizeOfferTitle folds away got through while normalizing to "".
//
// Two effects, both measured: a shop row that renders as nothing is
// creatable, and every such title collapses into ONE band bucket keyed by "",
// so a second unrelated invisible-titled service is refused for breaching a
// band it has nothing to do with — a false positive blocking a legitimate
// listing.
func TestOfferings_TitleMustHaveAVisibleCharacter(t *testing.T) {
	s, c := offSetup(t)
	for _, blank := range []string{" ", "\u00a0", "\u200b", "\u200d", "\ufeff", "\u3000", "\u200b \u00a0\u3000"} {
		if _, err := CreateOffering(s, c, c, 2000, blank, 1200); err == nil {
			t.Errorf("title %q normalizes to \"\" and was accepted — it renders as an empty shop row and shares the \"\" band bucket with every other invisible title", blank)
		}
	}
	// A title with real content plus invisible padding is fine — the rule is
	// "at least one visible character", not "no invisible characters".
	if _, err := CreateOffering(s, c, c, 2000, "\u200b custom song \u200b", 1200); err != nil {
		t.Fatalf("a title with visible content and invisible padding must be accepted: %v", err)
	}
}

// ---- F16: a rename cannot donate a LOOSER anchor for future reprices ------
//
// DEFECT FIX (F16, 2026-08-19). SetOfferingTitle's already-anchored branch
// (above) only ever checked that the id's CURRENT price fit the destination
// title's band — a price sitting at the honest EDGE of that band (e.g.
// exactly 2x an id's own real anchor) always passes, correctly, since a
// straight reprice to that same edge would also be allowed. The gap: that
// check says nothing about what happens to the DESTINATION's own anchor
// going forward. SetOfferingPrice bands every future reprice purely against
// the CURRENT title's persistent anchor (applyTitleBandedPrice) — never
// against the id's own — so once a live id carries a renamed-onto title, ANY
// anchor sitting there becomes the id's new ceiling, however it got there.
//
// Proven exploit: post a decoy title fresh (a virgin posting is always
// unbanded) at exactly 2x a live offering's real price, delete the decoy
// (the title's own band state deliberately survives — see DeleteOffering's
// doc), rename the live offering onto the freed title (honest by the
// existing check: its price sits at the edge of the decoy's band), then
// reprice again in the SAME block. Before this fix, that second reprice
// banded against the decoy's donated anchor — a SECOND, unrelated 2x window
// stacked on top of the id's own — reaching 4x the id's true price with
// nothing refused. A buyer holding a signed ask against that id then pays
// the inflated price (Ask reads OfferingPrice live at settlement).
func TestOfferings_RenameCannotDonateALooserAnchorForFutureReprices(t *testing.T) {
	s, c := offSetup(t)
	real, err := CreateOffering(s, c, c, 2000, "Consult", 25_000)
	if err != nil {
		t.Fatal(err)
	}
	// The decoy: a virgin title, so its initial posting is free — priced at
	// exactly 2x "Consult", the honest edge of Consult's own band.
	decoy, err := CreateOffering(s, c, c, 2000, "Decoy", 50_000)
	if err != nil {
		t.Fatal(err)
	}
	if err := DeleteOffering(s, c, c, decoy); err != nil {
		t.Fatal(err) // the title's own band state deliberately survives this
	}
	// The hop itself is honest by the existing per-rename check (25,000 fits
	// Decoy's own [25000,100000] band exactly at the floor) and MUST still
	// succeed — refusing this would break requirement 1 (honest renames must
	// keep working), not just close the bug.
	if err := SetOfferingTitle(s, c, c, real, "Decoy"); err != nil {
		t.Fatalf("an honest rename at the edge of the destination's own band was refused: %v", err)
	}
	// THE BUG: without the fix, a same-block reprice to 4x the id's true
	// price banded against the DECOY's donated anchor (50,000) and passed.
	if err := SetOfferingPrice(s, c, c, 2000, real, 100_000); err == nil {
		t.Fatal("BYPASS: a title hop donated a decoy's anchor, letting a live id reprice to 4x its true price in one block")
	}
	// The id's honest ceiling — exactly 2x its OWN real price (25,000), the
	// same ceiling a straight same-title reprice would have hit — must still
	// be reachable...
	if err := SetOfferingPrice(s, c, c, 2000, real, 50_000); err != nil {
		t.Fatalf("the id's own honest 2x ceiling was wrongly refused after the hop: %v", err)
	}
	if got := OfferingPrice(s, c, real); got.Cmp(big.NewInt(50_000)) != 0 {
		t.Fatalf("price after the honest ceiling reprice = %s, want 50000", got)
	}
	// ...and capped there, exactly as an ordinary same-title reprice would be
	// (compare TestOfferings_PriceBandIsTheSameAsFaces).
	if err := SetOfferingPrice(s, c, c, 2000, real, 50_001); err == nil {
		t.Fatal("BYPASS: one HBD over the honest post-hop ceiling still succeeded")
	}
}

// TestOfferings_RenameOntoLooseDestinationIsNotTightened is the anti-vacuity
// control for the fix above, from the OTHER direction: when the id being
// renamed carries a LOOSER anchor than the destination it is moving onto,
// the destination's own (already tighter) anchor is the correct, binding
// constraint and must be left exactly alone — the fix only ever tightens,
// never loosens, and must never fire at all when the destination is already
// the stricter of the two.
func TestOfferings_RenameOntoLooseDestinationIsNotTightened(t *testing.T) {
	s, c := offSetup(t)
	dest, err := CreateOffering(s, c, c, 2000, "Premium Slot", 40_000)
	if err != nil {
		t.Fatal(err)
	}
	if err := DeleteOffering(s, c, c, dest); err != nil {
		t.Fatal(err)
	}
	// This id's own anchor (80,000) is LOOSER than the destination's
	// (40,000) — an ordinary, unrelated posting, priced at the edge of the
	// destination's own band ([20000,80000]) so the rename is honest.
	id, err := CreateOffering(s, c, c, 2000, "Custom Session", 80_000)
	if err != nil {
		t.Fatal(err)
	}
	if err := SetOfferingTitle(s, c, c, id, "Premium Slot"); err != nil {
		t.Fatalf("an honest rename onto a tighter, already-anchored title was refused: %v", err)
	}
	if got := OfferingPrice(s, c, id); got.Cmp(big.NewInt(80_000)) != 0 {
		t.Fatalf("rename moved the price: got %s, want unchanged 80000", got)
	}
	// The destination's own band (unaffected by this id's looser history)
	// still governs: 80,000 is already its ceiling, one more must refuse.
	if err := SetOfferingPrice(s, c, c, 2001, id, 80_001); err == nil {
		t.Fatal("the destination's own tighter band should still cap this id after the rename")
	}
}

// TestOfferings_RenameToAFreshTitleIsUnaffectedByTheFix is a second,
// deliberately mundane anti-vacuity control: the everyday case of renaming
// an offering to a brand-new, never-used title (the virgin-destination
// branch, which this fix does not touch at all) must keep working exactly
// as it always has, at any price in range.
func TestOfferings_RenameToAFreshTitleIsUnaffectedByTheFix(t *testing.T) {
	s, c := offSetup(t)
	id, err := CreateOffering(s, c, c, 2000, "old name", 12_000)
	if err != nil {
		t.Fatal(err)
	}
	if err := SetOfferingTitle(s, c, c, id, "brand new name"); err != nil {
		t.Fatalf("renaming to a never-used title was refused: %v", err)
	}
	if got := OfferingTitle(s, c, id); got != "brand new name" {
		t.Fatalf("title = %q, want %q", got, "brand new name")
	}
	if got := OfferingPrice(s, c, id); got.Cmp(big.NewInt(12_000)) != 0 {
		t.Fatalf("rename to a fresh title moved the price: got %s, want unchanged 12000", got)
	}
}
