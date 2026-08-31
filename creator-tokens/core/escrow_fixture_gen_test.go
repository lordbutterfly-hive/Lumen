package core

import (
	"encoding/json"
	"fmt"
	"math/big"
	"testing"
)

// TestGenEscrowFixtures EMITS the fixture strings consumed by the TypeScript
// parser's round-trip selftest. It is a generator, not an assertion: the point
// is that the strings the TS side parses are produced by packEscrow ITSELF, so
// the two cannot drift the way a hand-written fixture (or a comment) can.
//
// Run:  go test ./core/ -run TestGenEscrowFixtures -v
func TestGenEscrowFixtures(t *testing.T) {
	cases := []struct {
		name string
		rec  escrowRec
	}{
		{"typical", escrowRec{
			asker: "hive:alice", credits: big.NewInt(7), deadline: 6200000,
			status: askPending, commissionHbd: big.NewInt(1200),
			acqBlock: 6100000, offeringID: 3,
			contentHash: "abc123", answerHash: "",
		}},
		{"offering-zero", escrowRec{
			asker: "hive:bob", credits: big.NewInt(1), deadline: 1,
			status: askAnswered, commissionHbd: big.NewInt(0),
			acqBlock: 0, offeringID: 0,
			contentHash: "c", answerHash: "a",
		}},
		{"did-asker-and-big-offering", escrowRec{
			asker:  "did:pkh:bip122:000000000019d6689c085ae165831e93:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
			credits: big.NewInt(999999), deadline: 18446744073709551615,
			status: askDeclined, commissionHbd: big.NewInt(123456789),
			acqBlock: 123456, offeringID: 4294967295,
			contentHash: "0123456789abcdef", answerHash: "fedcba9876543210",
		}},
		{"answerHash-contains-pipe", escrowRec{
			asker: "hive:carol", credits: big.NewInt(2), deadline: 7,
			status: askReclaimed, commissionHbd: big.NewInt(5),
			acqBlock: 9, offeringID: 1,
			contentHash: "hash", answerHash: "tail|with|pipes",
		}},
	}
	out := make([]map[string]any, 0, len(cases))
	for _, c := range cases {
		packed := packEscrow(c.rec)
		// Prove the CONTRACT itself round-trips it, so a fixture can never
		// encode a string the contract would refuse.
		if _, ok := unpackEscrow(packed); !ok {
			t.Fatalf("%s: packEscrow produced a string unpackEscrow rejects: %q", c.name, packed)
		}
		out = append(out, map[string]any{
			"name": c.name, "packed": packed,
			"asker": c.rec.asker, "credits": c.rec.credits.String(),
			"deadline": c.rec.deadline, "status": c.rec.status,
			"commissionHbd": c.rec.commissionHbd.String(),
			"acqBlock": c.rec.acqBlock, "offeringID": c.rec.offeringID,
			"contentHash": c.rec.contentHash, "answerHash": c.rec.answerHash,
		})
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	fmt.Println("FIXTURES_BEGIN")
	fmt.Println(string(b))
	fmt.Println("FIXTURES_END")
}
