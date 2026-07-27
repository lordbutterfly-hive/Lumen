package core

import (
	"math/big"
	"strconv"
	"strings"
)

// offerings.go — the creator's SHOP: N named services, each with its own posted
// HBD price (2026-07-27).
//
// A creator posts up to MaxOfferings named offerings ("15-min call — $25",
// "custom song — $200"). A buyer asks against ONE of them and the ask settles at
// THAT offering's price, in tokens, at the prevailing rate — so the dollar cost
// of a service is fixed by the creator while the token quantity floats with the
// market (SPEC §1.3b, the whole point of settling asks in tokens).
//
// WHAT THIS FILE DELIBERATELY REUSES. Every price here goes through
// offer_price.go's setBandedPrice — the same 2x/7d anti-rug band, the same
// window-anchor semantics, the same initial-posting branch — for the same
// reason SetUnlockPrice/SetSessionPrice do: a buyer who bought tokens intending
// to spend them on a specific service must be protected against a spike on THAT
// service. Nothing about the band is re-derived here; a divergence between an
// offering's band and the face band would be a bug, not a feature.
//
// WHAT THIS FILE DELIBERATELY DOES NOT TOUCH. The single `face` price and its
// whole audited path (SetFace / Ask(offeringId=0) / quote / settleSpend) are
// left byte-for-byte alone. Offering id 0 is reserved and never allocated, and
// it MEANS "the face price", so every pre-existing caller and test keeps its
// exact meaning and the new catalogue sits beside the audited path rather than
// rewriting it. This mirrors offer_price.go's own choice to add a separate
// helper rather than refactor SetFace.
//
// AUTHORITY AND GATING. Create/SetPrice/Delete are creator-only config changes,
// gated by requireOpenCreatorMarket exactly as SetFace/SetCap/SetUnlockPrice
// are: market must exist and not be CLOSED. They are deliberately NOT gated on
// OVERDUE/FROZEN or the global pause — posting a price moves no funds, and the
// standing guardrail is that non-payment and non-delivery never gate funds.
// What IS gated is the ASK against an offering: that is an inflow, and ask.go's
// RequireInflowOpen already covers it.
//
// DELETING AN OFFERING NEVER TOUCHES AN ESCROW. Delete only removes the offering
// from the shop (no new asks against it). Escrows already opened against that id
// keep their locked credits, their deadline, and their answer/reclaim windows —
// those paths never read the offering. A creator therefore cannot strand a
// buyer's funds by withdrawing a service after being paid for it, which is the
// one failure state a shop with a delete button obviously invites.

// offerEpoch reads the current offering-namespace epoch (keys.go). Zero is a
// perfectly valid epoch: a market registered before this file existed simply
// has no offerings in epoch 0, and Register bumps from there.
func offerEpoch(s Store, creator string) uint64 { return getU64(s, kOfferEpoch(creator)) }

// bumpOfferEpoch retires an incarnation's entire catalogue in ONE write. Called
// from Register's per-incarnation reset block; see keys.go for why this is an
// epoch bump rather than a key-by-key clear like every other reset there.
func bumpOfferEpoch(s Store, creator string) {
	setU64(s, kOfferEpoch(creator), offerEpoch(s, creator)+1)
}

// ---- live-id list (bounded, the single source of truth for the live set) ----

func loadOfferIds(s Store, creator string, epoch uint64) []uint64 {
	raw := getStr(s, kOfferIds(creator, epoch))
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]uint64, 0, len(parts))
	for _, p := range parts {
		id, err := strconv.ParseUint(p, 10, 64)
		if err != nil || id == 0 {
			continue // defensive: a malformed entry is skipped, never panics a read
		}
		out = append(out, id)
	}
	return out
}

func saveOfferIds(s Store, creator string, epoch uint64, ids []uint64) {
	parts := make([]string, 0, len(ids))
	for _, id := range ids {
		parts = append(parts, strconv.FormatUint(id, 10))
	}
	setStr(s, kOfferIds(creator, epoch), strings.Join(parts, ","))
}

func offerIdLive(ids []uint64, id uint64) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}

// validOfferTitle bounds the one free-form, buyer-facing field on an offering.
// "|" is rejected for contentHash's exact reason (ask.go): events and packed
// records in this codebase concatenate fields without escaping.
func validOfferTitle(t string) error {
	if t == "" {
		return newErr(ErrInput, "empty offering title")
	}
	if len(t) > MaxOfferTitleLen {
		return newErr(ErrInput, "offering title too long")
	}
	if strings.Contains(t, "|") {
		return newErr(ErrInput, "offering title must not contain '|'")
	}
	if strings.Contains(t, ",") {
		// The live-id list is comma-separated; titles are stored in their own
		// key and could technically carry a comma, but rejecting it here keeps
		// every free-form field in this file safe for any concatenating reader.
		return newErr(ErrInput, "offering title must not contain ','")
	}
	return nil
}

// ---- writes ----

// CreateOffering posts a new named service at `price` and returns its id. The
// first price opens the offering's own 2x/7d band window through
// setBandedPrice's initial-posting branch, exactly as Register's posted face
// opens face's first window.
func CreateOffering(s Store, caller, creator string, block uint64, title string, price int64) (uint64, error) {
	if err := requireOpenCreatorMarket(s, caller, creator); err != nil {
		return 0, err
	}
	if err := validOfferTitle(title); err != nil {
		return 0, err
	}

	epoch := offerEpoch(s, creator)
	ids := loadOfferIds(s, creator, epoch)
	if uint64(len(ids)) >= MaxOfferings {
		return 0, newErr(ErrState, "offering catalogue full; delete one first")
	}

	// Ids are monotone within an epoch and never reused, for kSeq's reason: an
	// escrow records the id it was asked against, so a recycled id would
	// silently relabel a settled ask's service in the delivery record.
	next := getU64(s, kOfferNext(creator, epoch))
	if next == 0 {
		next = 1 // id 0 is reserved for "the face price" and for the counter slot
	}
	id := next

	// Price LAST, so a rejected price leaves no half-created offering behind:
	// the id counter and the live list are only advanced after it lands.
	if err := setBandedPrice(s, creator, block, price,
		kOfferPrice(creator, epoch, id), kOfferAnchor(creator, epoch, id),
		kOfferAnchorAt(creator, epoch, id), kOfferSetAt(creator, epoch, id)); err != nil {
		return 0, err
	}

	setStr(s, kOfferTitle(creator, epoch, id), title)
	setU64(s, kOfferNext(creator, epoch), id+1)
	saveOfferIds(s, creator, epoch, append(ids, id))
	return id, nil
}

// SetOfferingPrice changes one offering's price under its own 2x/7d band.
func SetOfferingPrice(s Store, caller, creator string, block, id uint64, newPrice int64) error {
	if err := requireOpenCreatorMarket(s, caller, creator); err != nil {
		return err
	}
	epoch := offerEpoch(s, creator)
	if id == 0 || !offerIdLive(loadOfferIds(s, creator, epoch), id) {
		return newErr(ErrNotFound, "no such offering")
	}
	return setBandedPrice(s, creator, block, newPrice,
		kOfferPrice(creator, epoch, id), kOfferAnchor(creator, epoch, id),
		kOfferAnchorAt(creator, epoch, id), kOfferSetAt(creator, epoch, id))
}

// SetOfferingTitle relabels an offering without touching its price or its band
// window — renaming a service is not a repricing and must not earn band
// headroom, nor cost any.
func SetOfferingTitle(s Store, caller, creator string, id uint64, title string) error {
	if err := requireOpenCreatorMarket(s, caller, creator); err != nil {
		return err
	}
	if err := validOfferTitle(title); err != nil {
		return err
	}
	epoch := offerEpoch(s, creator)
	if id == 0 || !offerIdLive(loadOfferIds(s, creator, epoch), id) {
		return newErr(ErrNotFound, "no such offering")
	}
	setStr(s, kOfferTitle(creator, epoch, id), title)
	return nil
}

// DeleteOffering withdraws a service from the shop. It frees a catalogue slot
// and blocks NEW asks against that id; it never touches an escrow already
// opened against it (see the file header). The price is zeroed so a stale
// reader cannot quote a withdrawn service, and the band anchors go with it so a
// future offering can never inherit a dead one's anchor (the H4 bug class).
func DeleteOffering(s Store, caller, creator string, id uint64) error {
	if err := requireOpenCreatorMarket(s, caller, creator); err != nil {
		return err
	}
	epoch := offerEpoch(s, creator)
	ids := loadOfferIds(s, creator, epoch)
	if id == 0 || !offerIdLive(ids, id) {
		return newErr(ErrNotFound, "no such offering")
	}

	setMoney(s, kOfferPrice(creator, epoch, id), mZero())
	setMoney(s, kOfferAnchor(creator, epoch, id), mZero())
	setU64(s, kOfferAnchorAt(creator, epoch, id), 0)
	setU64(s, kOfferSetAt(creator, epoch, id), 0)
	setStr(s, kOfferTitle(creator, epoch, id), "")

	kept := make([]uint64, 0, len(ids))
	for _, v := range ids {
		if v != id {
			kept = append(kept, v)
		}
	}
	saveOfferIds(s, creator, epoch, kept)
	return nil
}

// ---- reads ----

// OfferingView is one row of a creator's shop.
type OfferingView struct {
	ID       uint64
	Title    string
	PriceHbd *big.Int
}

// OfferingPrice returns the posted HBD price of one offering, or 0 if the id is
// not live. Id 0 returns the face price, so a caller that does not care which
// it is holding can treat "the price to ask against id N" uniformly — this is
// exactly what askPriceFor (ask.go) does.
func OfferingPrice(s Store, creator string, id uint64) *big.Int {
	if id == 0 {
		return getMoney(s, kFace(creator))
	}
	epoch := offerEpoch(s, creator)
	if !offerIdLive(loadOfferIds(s, creator, epoch), id) {
		return mZero()
	}
	return getMoney(s, kOfferPrice(creator, epoch, id))
}

// OfferingTitle returns an offering's display label ("" if not live).
func OfferingTitle(s Store, creator string, id uint64) string {
	if id == 0 {
		return ""
	}
	epoch := offerEpoch(s, creator)
	if !offerIdLive(loadOfferIds(s, creator, epoch), id) {
		return ""
	}
	return getStr(s, kOfferTitle(creator, epoch, id))
}

// ListOfferings returns the creator's live shop, in creation order. Bounded by
// MaxOfferings — this is a single list read, never a scan of the id space.
func ListOfferings(s Store, creator string) []OfferingView {
	epoch := offerEpoch(s, creator)
	ids := loadOfferIds(s, creator, epoch)
	out := make([]OfferingView, 0, len(ids))
	for _, id := range ids {
		out = append(out, OfferingView{
			ID:       id,
			Title:    getStr(s, kOfferTitle(creator, epoch, id)),
			PriceHbd: getMoney(s, kOfferPrice(creator, epoch, id)),
		})
	}
	return out
}
