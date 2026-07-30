package core

import (
	"bytes"
	"math/big"
	"testing"
)

// matured_test.go — the wire conformance the matured bucket lives or dies by.
//
// magi-market does NOT call our ABI to read a balance. It reads the raw state
// key and decodes it itself (magi-market/contract/internal.go:848-859, a
// left-aligned little-endian uint64 with an abort past 8 bytes). So these bytes
// ARE the interface. A local test that only round-trips our own encoder against
// our own decoder would pass on any self-consistent encoding and prove nothing
// about whether the market can read us — the expectations below are therefore
// derived from magi_nft's algorithm (magi_nft-contract/contract/internal.go:
// 426-461: binary.LittleEndian.PutUint64 into 8 bytes, then cut after the last
// non-zero byte), written out by hand rather than produced by our own code.

func TestMatured_CodecMatchesMagiNftByteForByte(t *testing.T) {
	cases := []struct {
		n    uint64
		want []byte
		why  string
	}{
		{0, []byte{0x00}, "zero is a single 0x00 byte (never stored — see the deletion test)"},
		{1, []byte{0x01}, "one byte"},
		{255, []byte{0xff}, "still one byte at the byte boundary"},
		{256, []byte{0x00, 0x01}, "little-endian: the low byte comes FIRST"},
		{1_000_000_000, []byte{0x00, 0xca, 0x9a, 0x3b}, "MaxCap encodes in four bytes"},
		{1 << 32, []byte{0x00, 0x00, 0x00, 0x00, 0x01}, "interior zeros are kept; only HIGH zeros trim"},
		{1 << 56, []byte{0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01}, "full width"},
		{^uint64(0), []byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}, "max uint64"},
	}
	for _, c := range cases {
		got := u64ToLE(c.n)
		if !bytes.Equal(got, c.want) {
			t.Fatalf("u64ToLE(%d) = % x, want % x — %s.\n"+
				"These bytes are read directly by magi-market; a mismatch means the market "+
				"reads a different number than we stored.", c.n, got, c.want, c.why)
		}
		back, ok := leToU64(got)
		if !ok || back != c.n {
			t.Fatalf("round-trip failed for %d: got (%d, %v)", c.n, back, ok)
		}
	}
}

// The interior-zero case is the one a naive "trim all zero bytes" implementation
// gets wrong, and it is reachable: 2^32 is well inside MaxCap's range.
func TestMatured_CodecKeepsInteriorZeros(t *testing.T) {
	got := u64ToLE(1 << 32)
	if len(got) != 5 {
		t.Fatalf("u64ToLE(2^32) length = %d, want 5 (0x01 preceded by four zero bytes); "+
			"trimming interior zeros would decode as %d", len(got), 1)
	}
}

// Over-long values are not decodable by us AND abort the market's decoder,
// which traps and reverts the whole transaction. Unreachable through correct
// arithmetic; pinned so it stays that way.
func TestMatured_CodecRefusesOverlongValue(t *testing.T) {
	if _, ok := leToU64(make([]byte, 9)); ok {
		t.Fatal("leToU64 accepted 9 bytes — magi-market ABORTS on this input, so a value " +
			"this long under bal| would brick every market read against that holder")
	}
	if _, ok := leToU64(make([]byte, 8)); !ok {
		t.Fatal("leToU64 rejected 8 bytes, which is the legal maximum")
	}
}

// magi_nft deletes the key at zero rather than storing the single 0x00 byte
// (its setBalance, internal.go:119-126). A stored zero is not wrong to READ, but
// it is a wire divergence from the contract we are mirroring and it leaves dead
// state behind on every fully-sold position.
func TestMatured_ZeroDeletesTheKeyRatherThanStoringIt(t *testing.T) {
	s := NewMemStore()
	setMatured(s, "hive:alice", "hive:bob", big.NewInt(5))
	if _, ok := s.Get(kMatured("hive:bob", "hive:alice")); !ok {
		t.Fatal("setup: nonzero write did not land")
	}
	setMatured(s, "hive:alice", "hive:bob", mZero())
	if v, ok := s.Get(kMatured("hive:bob", "hive:alice")); ok {
		t.Fatalf("zero balance left a key behind holding %q — magi_nft deletes it", v)
	}
	if getMatured(s, "hive:alice", "hive:bob").Sign() != 0 {
		t.Fatal("deleted key must read back as zero")
	}
}

// ★ The transpose is the whole reason the maturing family had to leave "bal|".
// If these two ever produce the same string for a (creator, holder) pair, one
// family silently overwrites the other.
func TestMatured_KeyIsTransposedAndNeverCollidesWithMaturing(t *testing.T) {
	const a, b = "hive:alice", "hive:bob"

	if kMatured(b, a) == kBal(a, b) {
		t.Fatal("matured and maturing keys are identical — one family is overwriting the other")
	}

	// The exact hazard the rename closed: Alice holding Bob's token and Bob
	// holding Alice's token. Before the rename BOTH of these were "bal|alice|bob".
	bobHoldsAlices := kMatured(b, a) // matured: bal|<holder=bob>|<creator=alice>
	aliceHoldsBobs := kBal(b, a)     // maturing: mb|<creator=bob>|<holder=alice>
	if bobHoldsAlices == aliceHoldsBobs {
		t.Fatal("cross-holding collision: two different positions share one key")
	}

	// And the market's own layout is what we must produce, verbatim.
	if got, want := kMatured(b, a), "bal|"+b+"|"+a; got != want {
		t.Fatalf("kMatured = %q, want %q — magi-market builds this key itself "+
			"(internal.go:951-953) and will read nothing if we deviate", got, want)
	}
}

// ★ The literal pin. Every other Go test both BUILDS and SCANS through kBal, so
// a self-consistent prefix change is invisible to the entire Go suite — the M0
// scrutiny proved exactly that by mutation. The only other pin anywhere is in
// the TypeScript e2e, which tests TypeScript against TypeScript and can never
// catch a Go-side drift. This is the one assertion that fails if the wire
// changes, and it is deliberately written as a literal rather than through the
// builder it is checking.
func TestMatured_KeyLiteralsArePinned(t *testing.T) {
	if got, want := kBal("hive:alice", "hive:bob"), "mb|hive:alice|hive:bob"; got != want {
		t.Fatalf("kBal = %q, want %q.\nThe frontend builds this key independently "+
			"(frontend/.../lib/vsc/reads.ts kBal) — changing one side without the other "+
			"makes every balance read return nothing.", got, want)
	}
	if got, want := kMatured("hive:bob", "hive:alice"), "bal|hive:bob|hive:alice"; got != want {
		t.Fatalf("kMatured = %q, want %q.\nmagi-market builds this key itself and reads "+
			"our raw state — a deviation is invisible to us and total to them.", got, want)
	}
}

// Graduation is all-or-nothing at the window, and it must not fire one block
// early — a token that graduates while still owing tax is transferable while
// owing tax, which is the one thing the whole design forbids.
func TestMatured_GraduatesAtTheWindowAndNotBefore(t *testing.T) {
	s := NewMemStore()
	const c, h = "hive:alice", "hive:bob"
	const buyBlock = 1_000_000

	creditInflow(s, c, h, big.NewInt(500), buyBlock)

	if maturedNow(s, c, h, buyBlock+ExitTaxDecayBlocks-1) {
		t.Fatal("matured one block early — that token still owes tax and must not be transferable")
	}
	if moved := graduate(s, c, h, buyBlock+ExitTaxDecayBlocks-1); moved.Sign() != 0 {
		t.Fatalf("graduate moved %s one block early", moved.String())
	}

	at := uint64(buyBlock + ExitTaxDecayBlocks)
	if !maturedNow(s, c, h, at) {
		t.Fatal("did not mature exactly at the window")
	}
	if ExitTaxBpsAt(heldBlocksAt(s, c, h, at)) != 0 {
		t.Fatal("a balance that graduates must owe exactly zero tax — graduation and the " +
			"rate must use the same comparison against the same constant")
	}

	moved := graduate(s, c, h, at)
	if moved.Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("graduated %s, want the whole 500", moved.String())
	}
	if getMoney(s, kBal(c, h)).Sign() != 0 {
		t.Fatal("maturing bucket must be empty after graduation")
	}
	if getMatured(s, c, h).Cmp(big.NewInt(500)) != 0 {
		t.Fatal("matured bucket must hold the graduated tokens")
	}
	if _, ok := s.Get(kAcqBlock(c, h)); ok {
		t.Fatal("the hold clock must be cleared — a stale clock on an empty maturing " +
			"balance would make the next buy look older than it is")
	}
	if totalBalance(s, c, h).Cmp(big.NewInt(500)) != 0 {
		t.Fatal("graduation must conserve the holder's total position exactly")
	}
}

// Graduation must never create or destroy tokens, and must be idempotent — it
// runs on every touch, so a second call on an already-graduated position must
// be a no-op rather than moving a zero balance around.
func TestMatured_GraduationConservesAndIsIdempotent(t *testing.T) {
	s := NewMemStore()
	const c, h = "hive:alice", "hive:bob"
	creditInflow(s, c, h, big.NewInt(700), 1_000_000)
	at := uint64(1_000_000 + ExitTaxDecayBlocks)

	before := totalBalance(s, c, h)
	graduate(s, c, h, at)
	graduate(s, c, h, at)
	graduate(s, c, h, at+1)
	if after := totalBalance(s, c, h); after.Cmp(before) != 0 {
		t.Fatalf("total moved from %s to %s across repeated graduation", before, after)
	}
	if getMatured(s, c, h).Cmp(big.NewInt(700)) != 0 {
		t.Fatal("repeated graduation must not multiply the matured balance")
	}
}

// A never-clocked balance reads as maximally fresh everywhere else in this
// package; it must not read as matured here.
func TestMatured_UnclockedBalanceIsNeverMatured(t *testing.T) {
	s := NewMemStore()
	const c, h = "hive:alice", "hive:bob"
	setMoney(s, kBal(c, h), big.NewInt(100)) // deliberately outside the chokepoints
	if maturedNow(s, c, h, 9_000_000) {
		t.Fatal("a balance with no clock must not be treated as matured — the zero-value " +
			"convention is maximally FRESH, and the treasury-favouring direction")
	}
}

// An empty maturing bucket is not "matured", or every holder with zero tokens
// would graduate nothing forever and the emitted event stream would carry
// meaningless zero transfers.
func TestMatured_EmptyBalanceDoesNotGraduate(t *testing.T) {
	s := NewMemStore()
	if maturedNow(s, "hive:alice", "hive:bob", 9_000_000) {
		t.Fatal("empty maturing balance reported as matured")
	}
}
