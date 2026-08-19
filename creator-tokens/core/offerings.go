package core

import (
	"math/big"
	"strconv"
	"strings"
	"unicode"
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
// window-anchor semantics, the same initial-posting branch — for the reason
// setBandedPrice was generalized in the first place: a buyer who bought tokens
// intending to spend them on a specific service must be protected against a
// spike on THAT service. Nothing about the band is re-derived here; a
// divergence between an offering's band and the face band would be a bug, not
// a feature.
//
// THE BAND MUST SURVIVE DELETE+RECREATE (DEFECT FIX, 2026-07-27). Ids are
// monotone and DeleteOffering frees an id's own price/anchor (both by
// design — see kSeq's reasoning and DeleteOffering's own doc below), so an
// id-keyed band cannot, by construction, survive a delete+recreate of the
// same service: a fresh id's price key always reads 0 and setBandedPrice's
// initial-posting branch accepts anything in [MinFace, MaxFace] with no band
// check at all. CreateOffering therefore also gates on a per-(creator,
// epoch, normalized-title) band (kOfferTitlePrice/kOfferTitleAnchor/
// kOfferTitleAnchorAt/kOfferTitleSetAt, keys.go) that outlives the id.
//
// ONE GATE, NOT THREE (2026-07-27 rewrite, closing a second-order family of
// defects an independent review found in the first version of this fix). The
// first version kept the title-level anchor as a side channel that
// CreateOffering consulted, SetOfferingPrice refreshed, and SetOfferingTitle
// mostly ignored — three different rules for one shared piece of state, and
// the seams between them were exactly the bug: a rename onto an ALREADY
// anchored title skipped the gate entirely (nothing there checked the price
// moving in), a following ordinary reprice then blindly overwrote the title's
// real anchor with whatever foreign anchor the renamed id happened to carry
// (laundering the very thing the rename gate was supposed to refuse), and an
// EXPIRED-but-nonzero title anchor routed a delete+recreate into a brand-new
// id's initial-posting branch — no band at all, turning a title that had been
// perfectly stable for a week into a free rug the instant it "expired".
//
// The fix is applyTitleBandedPrice: it calls setBandedPrice ITSELF, pointed
// at the title's own four keys instead of an id's, so CreateOffering,
// SetOfferingPrice, and (for the price moving in) SetOfferingTitle all run
// through the exact same window logic against the exact same persistent
// state. There is no second code path left to diverge from it, launder it, or
// skip it. See applyTitleBandedPrice's own doc for the defect-3 decision this
// unification also settles (an expired window is banded against the last
// known price, never free), and SetOfferingTitle's doc for the one place this
// function's signature (fixed by contract/main.go, not owned by this fix)
// forces a documented, conservative approximation rather than the exact
// window check.
//
// WHAT THIS FILE DELIBERATELY DOES NOT TOUCH. The single `face` price and its
// whole audited path (SetFace / Ask(offeringId=0) / quote / settleSpend) are
// left byte-for-byte alone. Offering id 0 is reserved and never allocated, and
// it MEANS "the face price", so every pre-existing caller and test keeps its
// exact meaning and the new catalogue sits beside the audited path rather than
// rewriting it. This mirrors offer_price.go's own choice to add a separate
// helper rather than refactor SetFace.
//
// AUTHORITY AND GATING. Create/SetPrice/SetTitle are creator-only config
// changes, gated by requireShopEditable (market.go): the market must exist, not
// be CLOSED, and not be RETIRED. The retired case is stricter than
// SetFace/SetCap deliberately — Retire closes inflows permanently, so a service
// listed or repriced afterwards can never be bought by anyone, and listing an
// unbuyable item in the buyer-facing shop is a lie rather than a no-op (see
// requireShopEditable's own doc). They remain deliberately NOT gated on
// OVERDUE/FROZEN or the global pause — posting a price moves no funds, and the
// standing guardrail is that non-payment and non-delivery never gate funds.
// What IS gated is the ASK against an offering: that is an inflow, and ask.go's
// RequireInflowOpen already covers it.
//
// DELETE IS DELIBERATELY NOT RETIRE-GATED (DEFECT FIX, 2026-07-27).
// DeleteOffering uses requireOpenCreatorMarket (creator-only + market-exists +
// not-CLOSED), one guard looser than the other three. A widened guard that
// ALSO refused DeleteOffering once RETIRED took away the creator's only way to
// withdraw a stale listing at the exact moment they most need to (Retire is
// irreversible and starts a wind-down; a creator who has just retired still
// has every reason to pull listings nobody can buy any more) — the opposite
// of requireShopEditable's own purpose, which is to stop NEW unbuyable
// listings from appearing, not to freeze the shop's existing contents in
// place. Nothing about pulling a listing needs the market to still be
// sellable: DeleteOffering moves no funds and never touches an escrow already
// opened against the id (see below), so there is no fund-safety reason to gate
// it any tighter than "is there still a market here to edit at all".
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

// liveTitleOwner reports the live offering id currently carrying normTitle,
// if any. exceptID is skipped (pass 0 to skip nothing) so a rename can ignore
// the offering being renamed.
//
// DEFECT FIX (2026-07-28). Nothing used to stop two LIVE offerings sharing one
// normalized title, and the 2x/7-day anti-rug band is keyed by title, not by
// id — so the title's "last known price" (kOfferTitlePrice, the `cur` half of
// the band) could be parked at a price no live offering actually posts, and
// the next window re-anchors from it. Measured exploit: create "custom song"
// at 1200, drop the visible price to 600 (legal, floor of the anchor band),
// create a SECOND "custom song" at 2400 (accepted — duplicate title) which
// sets cur := 2400, delete that throwaway (which deliberately does NOT clear
// the title's keys), and one window later 600 -> 4800 is accepted where the
// control creator is capped at 600 -> 1200. Sustained across windows it holds
// cur/visible = 4 indefinitely, and the visible price can move 8x in a single
// transaction.
//
// The invariant this restores is "the title's cur is some LIVE offering's
// posted price". Note the rename path was never vulnerable: SetOfferingTitle
// gates through withinTitleBand, which intersects the anchor band with the
// cur band, while CreateOffering went through applyTitleBandedPrice, which
// checks the anchor only — two different rules for the same state transition,
// which is precisely the "ONE GATE, NOT THREE" defect class this file's own
// header says it closed.
func liveTitleOwner(s Store, creator string, epoch uint64, normTitle string, exceptID uint64) (uint64, bool) {
	for _, id := range loadOfferIds(s, creator, epoch) {
		if id == exceptID {
			continue
		}
		if normalizeOfferTitle(getStr(s, kOfferTitle(creator, epoch, id))) == normTitle {
			return id, true
		}
	}
	return 0, false
}

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
	// DEFECT FIX (2026-07-27): reject raw control bytes and DEL. Every event
	// this title is embedded into (EvOfferingCreated/EvOfferingUpdated,
	// events.go) runs it through evJSONEscape, which escapes ONLY '"' and
	// '\' — a raw byte below 0x20 (newline, tab, NUL, BEL, ...) inside a JSON
	// string is not valid JSON, so the resulting log line fails
	// encoding/json.Unmarshal (proven empirically: Go's stdlib decoder
	// accepts an embedded emoji or currency symbol without complaint, but
	// errors with "invalid character '\n' in string literal" etc. on any of
	// \n \t \x00 \x07). magi-indexer/creator_tokens_mappings.yaml's ParseEvent runs on that same
	// decoder, so it drops the whole event silently — letting a creator hide
	// a price change from any off-chain monitoring just by choosing a title
	// with a stray control byte in it. events.go is NOT owned by this fix
	// (evJSONEscape must stay untouched — another engineer owns that file),
	// so the fix belongs upstream of every writer, at the one door every
	// title must pass through: here.
	//
	// 0x7f (DEL) is rejected too, alongside 0x00-0x1f, even though Go's
	// decoder happens to tolerate a raw DEL inside a JSON string (verified:
	// it is not one of the RFC 8259 code points a compliant parser MUST
	// reject) — it is a non-printable control character with no legitimate
	// place in a display title, and excluding it is cheap defense-in-depth
	// against any stricter consumer.
	//
	// Checked on RAW BYTES, not runes: MaxOfferTitleLen above already bounds
	// len(t) in bytes, and every UTF-8 continuation byte is >= 0x80, so this
	// loop can never misidentify a legitimate multi-byte code point (accented
	// letters, CJK, currency symbols like ₿/€, emoji like 🎵) as a control
	// byte — only single-byte ASCII control codes and DEL are excluded.
	for i := 0; i < len(t); i++ {
		if c := t[i]; c < 0x20 || c == 0x7f {
			return newErr(ErrInput, "offering title must not contain a control character")
		}
	}
	// DEFECT FIX (2026-07-28): the `t == ""` check at the top runs on the RAW
	// string, so a title made only of characters normalizeOfferTitle folds
	// away passed it while normalizing to "". Measured: " ", U+00A0 (NBSP),
	// U+200B (ZWSP), U+200D (ZWJ), U+FEFF (BOM), U+3000 (ideographic space)
	// and mixtures of them all got through.
	//
	// Two consequences, both real. A shop row whose title renders as nothing
	// is creatable. And worse, every such title collapses into ONE band
	// bucket keyed by "", so two genuinely unrelated invisible-titled
	// services share an anchor: the second is refused for "price change
	// exceeds the 2x/7-day band" against a price it has nothing to do with.
	// That direction is at least safe, but it is a false positive that blocks
	// a legitimate listing.
	//
	// Check the NORMALIZED form too — the identity the band actually keys on
	// is the only one that matters here.
	if normalizeOfferTitle(t) == "" {
		return newErr(ErrInput, "offering title must contain at least one visible character")
	}
	return nil
}

// normalizeOfferTitle folds a title down to the identity the title-anchor
// gate (applyTitleBandedPrice, below) keys on, so cosmetic variation cannot be
// used to dodge a still-active anchor by spelling the same service slightly
// differently ("Custom Song" vs "custom song " vs "CUSTOM SONG" all normalize
// identically).
//
// DEFECT 4 FIX (2026-07-27): the original version here was ToLower(TrimSpace)
// only — no internal-whitespace collapse and no stripping of zero-width/
// format characters, so "custom  song" (two spaces) or "custom‍song" (a
// zero-width joiner spliced in) normalized to a DIFFERENT key than "custom
// song", each getting its own virgin anchor even though a buyer reading the
// shop sees the identical service name. This folds two more cheap, common
// dodges in:
//   - internal whitespace RUNS collapse to a single space (any run of
//     unicode.IsSpace runes, not just ASCII ' '), so "a   b", "a\tb", and
//     "a b" all key identically;
//   - unicode FORMAT characters (category Cf: zero-width space U+200B,
//     zero-width joiner/non-joiner U+200C/U+200D, the BOM U+FEFF, bidi
//     control marks, ...) are stripped outright — they render invisibly (or
//     not at all) in any real title display, so their only function in a
//     title string is to change the byte sequence without changing what a
//     buyer sees.
//
// DELIBERATELY NARROWER than full unicode confusable-normalization: distinct
// letters, punctuation variants, and unicode LOOK-ALIKE characters (Cyrillic
// "а" vs Latin "a", full-width vs half-width forms, ...) are NOT unified, and
// strings.ToLower is simple per-rune case mapping, not full Unicode
// case-FOLDING (so a handful of script-specific edge cases, e.g. Turkish
// dotless "ı", are not unified with their would-be counterparts either).
// Confusable-folding is a much larger, font-rendering-dependent problem
// (homoglyphs across scripts, combining-mark equivalences, ...) with no
// bounded, false-positive-free solution here — closing THAT is out of scope
// for this fix, and is called out rather than silently assumed closed. What
// IS closed is the narrow, cheap, common case: cosmetic whitespace and
// invisible formatting characters that render as nothing to a buyer.
func normalizeOfferTitle(t string) string {
	t = strings.ToLower(strings.TrimSpace(t))
	var b strings.Builder
	b.Grow(len(t))
	spacePending := false
	for _, r := range t {
		if unicode.Is(unicode.Cf, r) {
			continue // zero-width/format character: invisible, drop entirely
		}
		if unicode.IsSpace(r) {
			spacePending = true
			continue
		}
		if spacePending && b.Len() > 0 {
			b.WriteRune(' ')
		}
		spacePending = false
		b.WriteRune(r)
	}
	return b.String()
}

// applyTitleBandedPrice is the SINGLE gate every write that can change a
// title's EFFECTIVE price goes through — CreateOffering, SetOfferingPrice,
// and (for the price being carried in) SetOfferingTitle. It is nothing more
// than setBandedPrice (offer_price.go) pointed at the title's OWN persistent
// keys (kOfferTitlePrice/kOfferTitleAnchor/kOfferTitleAnchorAt/
// kOfferTitleSetAt, keys.go) instead of an id's — the identical helper, the
// identical window math SetFace itself uses, with the ONE difference that
// this state is keyed by (creator, epoch, normalized title) and so survives
// an id's own delete+recreate instead of being wiped with it.
//
// DEFECT 3 DECISION, recorded here because this is the one call site it was
// made at: an EXPIRED title window (elapsed >= FaceBandWindow since the
// anchor opened) is NOT treated as free. setBandedPrice's own "window
// expired" branch never grants an unbanded change to an EXISTING price — it
// opens a fresh window anchored at the price currently on record and still
// enforces the 2x band against THAT (waiting out the window earns another 2x
// of headroom, never a license to jump anywhere — the exact SetFace
// invariant this whole file exists to reuse). Routing the title's persistent
// state through that same helper means a delete+recreate can never do BETTER
// than a live reprice would: "free" is reserved for a title whose price key
// is genuinely, literally 0 — never posted in this epoch — never for one
// whose window merely aged out while a real price stood. The proven exploit
// this closes: a price stable and LIVE for a natural 7+ days (the steady
// state of every healthy service, during which its window ages out even
// though nothing about it changed) could be deleted and recreated at ANY
// price, because the old code's title-anchor gate treated "expired" as
// synonymous with "never existed". See
// TestOfferings_ExpiredWindowRecreateCannotJumpUnbounded for the pinned
// attack and its honest 2x-still-works counterpart.
func applyTitleBandedPrice(s Store, creator string, epoch uint64, normTitle string, block uint64, price int64) error {
	return setBandedPrice(s, creator, block, price,
		kOfferTitlePrice(creator, epoch, normTitle),
		kOfferTitleAnchor(creator, epoch, normTitle),
		kOfferTitleAnchorAt(creator, epoch, normTitle),
		kOfferTitleSetAt(creator, epoch, normTitle))
}

// mirrorTitleIntoID copies the title's current persistent band state — always
// authoritative after applyTitleBandedPrice above — down into one id's own
// cache keys (kOfferPrice/kOfferAnchor/kOfferAnchorAt/kOfferSetAt), so a
// per-id read (OfferingPrice, ListOfferings) stays an O(1) lookup without
// knowing which title it belongs to. This is the ONLY direction data ever
// flows between the two: title state seeds/updates the id's cache, an id's
// cache never feeds back into a banding decision. That asymmetry is what
// closes defect 2 (an ordinary reprice could no longer "unconditionally
// refresh the title anchor FROM the id's own anchor" — there is no code path
// left that reads an id's cache to decide anything).
func mirrorTitleIntoID(s Store, creator string, epoch, id uint64, normTitle string) {
	setMoney(s, kOfferPrice(creator, epoch, id), getMoney(s, kOfferTitlePrice(creator, epoch, normTitle)))
	setMoney(s, kOfferAnchor(creator, epoch, id), getMoney(s, kOfferTitleAnchor(creator, epoch, normTitle)))
	setU64(s, kOfferAnchorAt(creator, epoch, id), getU64(s, kOfferTitleAnchorAt(creator, epoch, normTitle)))
	setU64(s, kOfferSetAt(creator, epoch, id), getU64(s, kOfferTitleSetAt(creator, epoch, normTitle)))
}

// withinTitleBand reports whether price is safe to accept for a title with
// persistent state (anchor, cur) WITHOUT knowing the current block — the one
// thing SetOfferingTitle needs and cannot get (its signature is matched to
// contract/main.go's existing call site, which this fix does not own, and
// carries no block).
//
// setBandedPrice itself would band against ANCHOR if the window is still
// active, or against CUR (opening a fresh window) if it has expired — and
// which of those is true depends on the current block, which is exactly what
// is missing here. Checking against EITHER ONE ALONE is not safe: anchor
// alone can be LOOSER than a true expired-check whenever cur has legitimately
// drifted below anchor within the window (e.g. anchor=1000, cur=500 — both
// valid, cur at the bottom of anchor's own 2x band — a live reprice of 1500
// would be refused once the window expires, banded against cur=500's [250,
// 1000], but an anchor-only check sees 1500 fit anchor's [500,2000] and
// wrongly allows it). The fix: accept only what BOTH possible true checks
// would accept — the INTERSECTION of [anchor/F, anchor*F] and [cur/F, cur*F].
// That intersection can never be looser than whichever branch turns out to be
// the real one, only ever equal or stricter — the only direction that matters
// for closing a bypass. (It can occasionally refuse a rename a live reprice
// would have allowed, in the corner case above; that is the safe, not the
// exploitable, direction — see SetOfferingTitle's own doc.)
func withinTitleBand(price, anchor, cur *big.Int) bool {
	if anchor.Sign() <= 0 {
		return true // virgin: nothing to violate
	}
	if cur.Sign() <= 0 { // defensive: anchor/cur are always written together; see applyTitleBandedPrice
		cur = anchor
	}
	f := big.NewInt(int64(FaceBandNumerator))
	anchorLower, anchorUpper := new(big.Int).Div(anchor, f), new(big.Int).Mul(anchor, f)
	curLower, curUpper := new(big.Int).Div(cur, f), new(big.Int).Mul(cur, f)
	// mMin is the existing money.go helper (smaller of two); the tighter upper
	// bound is the smaller of the two candidates. There is no "larger of two"
	// helper in money.go to match it, so the tighter lower bound (the LARGER
	// of the two candidates) is written out directly here instead of adding
	// one to a file this fix does not own.
	lower := curLower
	if mGt(anchorLower, curLower) {
		lower = anchorLower
	}
	upper := mMin(anchorUpper, curUpper)
	return !mLt(price, lower) && !mGt(price, upper)
}

// ---- writes ----

// CreateOffering posts a new named service at `price` and returns its id.
//
// DEFECT FIX (2026-07-27): a fresh id's OWN price key always reads 0, so
// unconditionally routing through setBandedPrice's initial-posting branch
// (as this used to) accepts ANY in-range price with no band check at all —
// meaning delete+recreate under the same title was a complete bypass of the
// 2x/7d anti-rug band (proven: create at 508, correctly refused jumping to
// 10,000,000 on that id, delete it, recreate FRESH at 10,000,000, succeeds).
// The fix routes the price through applyTitleBandedPrice (above), which gates
// on the title's OWN persistent band state (kOfferTitlePrice/kOfferTitleAnchor/
// kOfferTitleAnchorAt/kOfferTitleSetAt, keys.go) instead of the id's — a state
// that survives the id lifecycle, so a fresh id can never present as "never
// priced before" just because IT is new; only the TITLE can be, and only once,
// per epoch. See applyTitleBandedPrice's own doc for exactly what "free" now
// means (a title's price key genuinely, literally 0) and what it no longer
// means (a window that merely aged out while a real price stood).
//
// The id's OWN band bookkeeping (kOfferPrice/kOfferAnchor/kOfferAnchorAt/
// kOfferSetAt) is then seeded from the title's resulting state
// (mirrorTitleIntoID), so a following SetOfferingPrice on this new id reads a
// cache that already matches the title it belongs to — and that mirror is
// refreshed FROM the title on every subsequent price-changing call, never the
// reverse (see mirrorTitleIntoID's own doc for why that direction is what
// closes defect 2).
func CreateOffering(s Store, caller, creator string, block uint64, title string, price int64) (uint64, error) {
	if err := requireShopEditable(s, caller, creator); err != nil {
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

	// Price FIRST (through the title's persistent gate), so a rejected price
	// leaves no half-created offering behind: the id counter and the live
	// list are only advanced after it lands, same as before this rewrite.
	normTitle := normalizeOfferTitle(title)
	// One live offering per normalized title — see liveTitleOwner. A second
	// live offering sharing a title lets the title's band state be parked at
	// a price nothing posts, which ratchets the next window's anchor.
	if other, dup := liveTitleOwner(s, creator, epoch, normTitle, 0); dup {
		return 0, newErr(ErrInput, "an offering with this title already exists (id "+evU64(other)+"); rename or delete it first")
	}
	if err := applyTitleBandedPrice(s, creator, epoch, normTitle, block, price); err != nil {
		return 0, err
	}
	mirrorTitleIntoID(s, creator, epoch, id, normTitle)

	setStr(s, kOfferTitle(creator, epoch, id), title)
	setU64(s, kOfferNext(creator, epoch), id+1)
	saveOfferIds(s, creator, epoch, append(ids, id))
	return id, nil
}

// SetOfferingPrice changes one offering's price under its own 2x/7d band.
//
// THE BAND IS TITLE-SCOPED, NOT ID-SCOPED (DEFECT 2 FIX, 2026-07-27, folded
// into the same applyTitleBandedPrice rewrite as CreateOffering and
// SetOfferingTitle). The banding decision is made against THIS id's CURRENT
// title's persistent state, never against the id's own cached anchor — the
// id-level keys are refreshed FROM the title afterward (mirrorTitleIntoID),
// never read FROM to decide anything here. That one-way flow is what closes
// the defect: the old code banded against the id's OWN anchor and then
// UNCONDITIONALLY copied that same anchor back onto the title's mirror,
// which is exactly how a rename that had picked up a foreign, looser anchor
// (the defect-1 shape) got that anchor laundered onto the title by nothing
// more than an ordinary, otherwise-honest reprice. With the title as the
// single source of truth, there is no id-owned anchor left for a reprice to
// launder in the first place.
func SetOfferingPrice(s Store, caller, creator string, block, id uint64, newPrice int64) error {
	if err := requireShopEditable(s, caller, creator); err != nil {
		return err
	}
	epoch := offerEpoch(s, creator)
	if id == 0 || !offerIdLive(loadOfferIds(s, creator, epoch), id) {
		return newErr(ErrNotFound, "no such offering")
	}
	normTitle := normalizeOfferTitle(getStr(s, kOfferTitle(creator, epoch, id)))
	if err := applyTitleBandedPrice(s, creator, epoch, normTitle, block, newPrice); err != nil {
		return err
	}
	mirrorTitleIntoID(s, creator, epoch, id, normTitle)
	return nil
}

// SetOfferingTitle relabels an offering without touching its OWN price —
// renaming a service is not a repricing and must not earn band headroom
// (this id's kOfferPrice is never written below). It DOES gate the rename
// itself against the destination title's band, closing DEFECT 1.
//
// DEFECT 1 FIX (2026-07-27): the previous version inherited the destination's
// band ONLY when that title's slot was completely virgin, and otherwise did
// NOTHING — no check, no update — when the destination was ALREADY anchored.
// That "otherwise" was the bug: a creator could post a throwaway offering
// under a virgin title at any price (free — first-time posting), delete the
// REAL, protected offering, and rename the throwaway ONTO the real title —
// moving an entirely unbanded price onto a title whose whole point is to stay
// banded, with the rename path checking nothing at all. Proven: MinFace
// refused a direct 2x-plus jump on the live id; delete it; a throwaway posted
// free at MaxFace; rename the throwaway onto the freed title; MaxFace lands
// under the protected name — a ~17,331x move the direct path had just correctly
// refused, done anyway one rename later.
//
// The fix: when the destination title is ALREADY anchored, this id's CURRENT
// price (the price effectively being carried onto that title) must fit the
// destination's OWN band (withinTitleBand, checked against BOTH the
// destination's anchor AND its last known price — see that function's own
// doc for why checking against only one of the two is not safe) or the
// rename is refused outright. When it passes, the destination's
// kOfferTitlePrice is updated to this id's price (so it is no longer stale
// for whoever reads the title next), but the window's origin
// (anchor/anchorAt) is left UNTOUCHED — this function's signature carries no
// block (matched to contract/main.go's existing call site, which this fix
// does not own), so it cannot correctly tell an active window from an
// expired one the way applyTitleBandedPrice does, and leaving the origin
// alone is always the SAFE side of that gap: a later CreateOffering/
// SetOfferingPrice on the real block re-derives active-vs-expired correctly
// regardless of what sits here.
//
// A destination that is virgin (never anchored in this epoch) still inherits
// this id's CURRENT full band state wholesale — unchanged behaviour from
// before this fix, just widened to the title's two new fields
// (kOfferTitlePrice/kOfferTitleSetAt) so a later rename or reprice under that
// title sees an accurate "last known price", not just an anchor.
func SetOfferingTitle(s Store, caller, creator string, id uint64, title string) error {
	if err := requireShopEditable(s, caller, creator); err != nil {
		return err
	}
	if err := validOfferTitle(title); err != nil {
		return err
	}
	epoch := offerEpoch(s, creator)
	if id == 0 || !offerIdLive(loadOfferIds(s, creator, epoch), id) {
		return newErr(ErrNotFound, "no such offering")
	}

	newNorm := normalizeOfferTitle(title)
	// Same one-live-offering-per-title rule as CreateOffering, skipping this
	// id so renaming an offering to a cosmetic variant of its own title (or
	// to itself) still works. Without this, rename is a second door to the
	// duplicate-title state liveTitleOwner exists to prevent.
	if other, dup := liveTitleOwner(s, creator, epoch, newNorm, id); dup {
		return newErr(ErrInput, "an offering with this title already exists (id "+evU64(other)+"); rename or delete it first")
	}
	newAnchorKey := kOfferTitleAnchor(creator, epoch, newNorm)
	newAnchorAtKey := kOfferTitleAnchorAt(creator, epoch, newNorm)
	newPriceKey := kOfferTitlePrice(creator, epoch, newNorm)
	newSetAtKey := kOfferTitleSetAt(creator, epoch, newNorm)

	idPrice := getMoney(s, kOfferPrice(creator, epoch, id))

	if getMoney(s, newAnchorKey).Sign() == 0 {
		// Virgin destination: inherit this id's CURRENT band state wholesale.
		setMoney(s, newAnchorKey, getMoney(s, kOfferAnchor(creator, epoch, id)))
		setU64(s, newAnchorAtKey, getU64(s, kOfferAnchorAt(creator, epoch, id)))
		setMoney(s, newPriceKey, idPrice)
		setU64(s, newSetAtKey, getU64(s, kOfferSetAt(creator, epoch, id)))
	} else {
		// Already-anchored destination: gate the price moving in.
		if !withinTitleBand(idPrice, getMoney(s, newAnchorKey), getMoney(s, newPriceKey)) {
			return newErr(ErrInput, "renaming onto this title would move a price outside its 2x/7-day band (checked against the destination title's own anchor and last known price)")
		}
		setMoney(s, newPriceKey, idPrice)

		// DEFECT FIX (F16, 2026-08-19): don't let this id DONATE a wider band
		// to itself by hopping onto a title whose own anchor happens to be
		// looser than the id's OWN existing anchor. The check above only
		// verifies idPrice fits the destination's CURRENT band — a price at
		// the edge of that band (e.g. exactly 2x an id's own anchor) always
		// passes, honestly. The bug is what happens NEXT: SetOfferingPrice
		// bands every future reprice purely against the TITLE's own
		// persistent anchor (applyTitleBandedPrice, above) — never against
		// this id's own anchor — so once this id carries the destination's
		// title, ANY anchor sitting there, however it got there, becomes
		// this id's new 2x ceiling too. A decoy title created fresh at 2x of
		// this id's real price and then donated via delete+rename hands the
		// id a SECOND, unrelated 2x window on top of its own — 4x in one
		// block, proven by TestP45_X7. Clamping the destination's anchor
		// down to this id's own (never up — an id's own anchor being LOOSER
		// than the destination's is left alone; the destination is already
		// the tighter, binding constraint then) means a live id can never
		// end up with more headroom after a rename than it had before one.
		// This cannot make an otherwise-honest rename fail: it never touches
		// the check above, only what governs price changes AFTER the rename
		// succeeds.
		if ownAnchor := getMoney(s, kOfferAnchor(creator, epoch, id)); ownAnchor.Sign() > 0 && mLt(ownAnchor, getMoney(s, newAnchorKey)) {
			setMoney(s, newAnchorKey, ownAnchor)
		}
	}

	// Keep this id's own cached mirror in step with whichever title it now
	// carries. Nothing outside this file reads kOfferAnchor/kOfferAnchorAt
	// directly — OfferingPrice/ListOfferings only ever read kOfferPrice — so
	// this is bookkeeping accuracy, not a correctness requirement on its own,
	// but it keeps "the id's cache always matches its current title" true at
	// every point in time, not just after a reprice.
	setMoney(s, kOfferAnchor(creator, epoch, id), getMoney(s, newAnchorKey))
	setU64(s, kOfferAnchorAt(creator, epoch, id), getU64(s, newAnchorAtKey))

	setStr(s, kOfferTitle(creator, epoch, id), title)
	return nil
}

// DeleteOffering withdraws a service from the shop. It frees a catalogue slot
// and blocks NEW asks against that id; it never touches an escrow already
// opened against it (see the file header). The price is zeroed so a stale
// reader cannot quote a withdrawn service, and this id's OWN band bookkeeping
// (kOfferPrice/kOfferAnchor/kOfferAnchorAt/kOfferSetAt) is cleared with it —
// that id is retired for good (ids are never reused).
//
// DELIBERATELY NOT CLEARED HERE: the per-TITLE band state (kOfferTitlePrice/
// kOfferTitleAnchor/kOfferTitleAnchorAt/kOfferTitleSetAt). That survival is
// the DEFECT FIX itself — clearing it on delete is exactly what made the
// id-keyed band bypassable by delete+recreate in the first place
// (applyTitleBandedPrice's doc has the full argument). A dead id's own state
// still resets so nothing stale can be read through that id itself; only the
// title-keyed state persists, on purpose.
//
// DEFECT 5 FIX (2026-07-27): guarded by requireOpenCreatorMarket, NOT
// requireShopEditable — deliberately one guard looser than Create/SetPrice/
// SetTitle above. A prior change widened this to requireShopEditable, which
// also refuses once the market is RETIRED, removing a retiring creator's only
// way to withdraw a listing nobody can buy any more — exactly backwards from
// what that stricter guard exists for (stopping NEW unbuyable listings from
// appearing, not freezing existing ones in place). See the file header's
// "DELETE IS DELIBERATELY NOT RETIRE-GATED" note for the full argument.
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
