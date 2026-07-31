package core

import (
	"encoding/json"
	"math/big"
	"os"
	"regexp"
	"sort"
	"testing"
)

// magi_mapping_contract_test.go — proves ../magi-indexer/creator_tokens_mappings.yaml
// actually matches what this package EMITS.
//
// WHY THIS EXISTS. That YAML tells magi-mongo-indexer (the official vsc-eco
// service we index through) how to read our logs: which `type` values to expect
// and which JSON fields to pull out of each. It is hand-written, it lives in
// another service's config format, and nothing about it is type-checked. A
// single renamed field there — or here — produces NO error anywhere: the
// indexer keeps running, the column just fills with NULLs forever, and every
// screen built on it quietly shows wrong numbers. That is the exact failure
// class schema_contract_test.go exists to prevent on the magi-indexer/creator_tokens_mappings.yaml
// side, and this is the same guard pointed at the YAML.
//
// It reads the YAML as text rather than importing a parser, for the reason this
// package always gives: core must stay stdlib-only so it can compile to wasm.
// The file's shape is regular enough that two regexes are exact, and
// TestMagiMapping_ParsesEveryDeclaredEvent below fails loudly if the format ever
// drifts far enough that they stop matching.

const magiMappingPath = "../magi-indexer/creator_tokens_mappings.yaml"

var (
	magiLogTypeRe = regexp.MustCompile(`log_type:\s*"([^"]+)"`)
	magiFieldsRe  = regexp.MustCompile(`fields:\s*\{([^}]*)\}`)
	magiPathRe    = regexp.MustCompile(`([a-z_]+):\s*"\$\.([A-Za-z]+)"`)
	magiSchemaRe  = regexp.MustCompile(`schema:\s*\{([^}]*)\}`)
	magiColRe     = regexp.MustCompile(`([a-z_]+):\s*(numeric|string)`)
)

// magiColumn pairs one declared Postgres column with the JSON key it pulls and
// the type the YAML says it is.
type magiColumn struct {
	jsonKey string
	pgType  string // "numeric" | "string"
}

// magiMapping returns logType -> column name -> {jsonKey, pgType}.
func magiMapping(t *testing.T) map[string]map[string]magiColumn {
	t.Helper()
	raw, err := os.ReadFile(magiMappingPath)
	if err != nil {
		t.Fatalf("cannot read %s: %v", magiMappingPath, err)
	}
	text := string(raw)

	types := magiLogTypeRe.FindAllStringSubmatchIndex(text, -1)
	fieldBlocks := magiFieldsRe.FindAllStringSubmatchIndex(text, -1)
	if len(types) == 0 || len(fieldBlocks) == 0 {
		t.Fatalf("%s: found %d log_type and %d fields blocks — the file format changed and this test's regexes no longer match it. Fix the regexes; do NOT delete this test.", magiMappingPath, len(types), len(fieldBlocks))
	}
	if len(types) != len(fieldBlocks) {
		t.Fatalf("%s: %d log_type entries but %d fields blocks — every event must declare exactly one fields map", magiMappingPath, len(types), len(fieldBlocks))
	}

	schemaBlocks := magiSchemaRe.FindAllStringSubmatchIndex(text, -1)
	if len(schemaBlocks) != len(types) {
		t.Fatalf("%s: %d log_type entries but %d schema blocks — every event must declare exactly one schema map", magiMappingPath, len(types), len(schemaBlocks))
	}

	out := map[string]map[string]magiColumn{}
	for i, m := range types {
		name := text[m[2]:m[3]]

		// The declared Postgres column types, by column name.
		colTypes := map[string]string{}
		for _, c := range magiColRe.FindAllStringSubmatch(text[schemaBlocks[i][2]:schemaBlocks[i][3]], -1) {
			colTypes[c[1]] = c[2]
		}

		cols := map[string]magiColumn{}
		for _, p := range magiPathRe.FindAllStringSubmatch(text[fieldBlocks[i][2]:fieldBlocks[i][3]], -1) {
			col, jsonKey := p[1], p[2]
			pgType, declared := colTypes[col]
			if !declared {
				t.Errorf("%s: event %q maps column %q in `fields` but never declares it in `schema` — the indexer would have nowhere to put it.", magiMappingPath, name, col)
				continue
			}
			cols[col] = magiColumn{jsonKey: jsonKey, pgType: pgType}
		}
		if len(cols) == 0 {
			t.Fatalf("%s: event %q declares no $.field paths", magiMappingPath, name)
		}
		for col := range colTypes {
			if _, mapped := cols[col]; !mapped {
				t.Errorf("%s: event %q declares column %q in `schema` but never fills it from `fields` — it would be NULL on every row.", magiMappingPath, name, col)
			}
		}
		out[name] = cols
	}
	return out
}

// magiSamples is one real constructor output per event the mapping declares.
// Built from the SAME Ev* functions the contract calls, never a hand-copied
// fixture — a fixture could drift from the constructor, which is the whole
// problem this file exists to catch one layer up.
func magiSamples() map[string]string {
	one := scOne()
	return map[string]string{
		"registered":        EvRegistered("c", "a", 1, MinFace, MinCap, one),
		"renewed":           EvRenewed("c", "a", 1, 1, one),
		"faceChanged":       EvFaceChanged("c", "a", 1, 1, 2),
		"capChanged":        EvCapChanged("c", "a", 1, 1, 2),
		"retired":           EvRetired("c", "a", 1),
		"closed":            EvClosed("c", "a", 1),
		"bought":            EvBought("c", "a", 1, one, one, one, one),
		"sold":              EvSold("c", "a", 1, one, one, one, one, one, one, 2000, 100),
		"transferred":       EvTransferred("c", "a", "b", 1, one),
		"maturedMoved":      EvMaturedMoved("c", "a", "a", "b", 1, one),
		"refunded":          EvRefunded("c", "a", 1, one, one),
		"refundPushed":      EvRefundPushed("c", "a", "h", 1, one, one),
		"asked":             EvAsked("c", "a", 1, 1, one, one, one, 1, "h", 0),
		"answered":          EvAnswered("c", "a", 1, 1, one, one, "h"),
		"reclaimed":         EvReclaimed("c", "a", 1, 1, one, one, one, "k"),
		"declined":          EvDeclined("c", "a", 1, 1, one, one, "k"),
		"rated":             EvRated("c", "a", 1, 1, 5),
		"offeringCreated":   EvOfferingCreated("c", "a", 1, 1, "t", one),
		"offeringUpdated":   EvOfferingUpdated("c", "a", 1, 1, "t", one, one),
		"offeringDeleted":   EvOfferingDeleted("c", "a", 1, 1),
		"treasuryWithdrawn": EvTreasuryWithdrawn("a", 1, one),
		"tradeFeesClaimed":  EvTradeFeesClaimed("a", 1, one),
	}
}

// TestMagiMapping_EveryDeclaredFieldExistsOnTheWire is the load-bearing check:
// every `$.field` the YAML pulls must actually be emitted. A field that isn't
// produces a permanently-NULL column, silently.
func TestMagiMapping_EveryDeclaredFieldExistsOnTheWire(t *testing.T) {
	mapping := magiMapping(t)
	samples := magiSamples()

	for logType, wanted := range mapping {
		sample, ok := samples[logType]
		if !ok {
			t.Fatalf("%s declares log_type %q, but this test has no constructor sample for it — either core stopped emitting it (delete the mapping entry) or magiSamples() is stale (add it).", magiMappingPath, logType)
		}
		var got map[string]any
		if err := json.Unmarshal([]byte(sample), &got); err != nil {
			t.Fatalf("%s: constructor output is not valid JSON: %v", logType, err)
		}
		for col, spec := range wanted {
			value, present := got[spec.jsonKey]
			if !present {
				keys := make([]string, 0, len(got))
				for k := range got {
					keys = append(keys, k)
				}
				sort.Strings(keys)
				t.Errorf("%s: the magi mapping pulls $.%s, but core emits no such field (emits %v).\nThe indexer would fill that Postgres column with NULL forever, with no error anywhere. Fix whichever side is wrong.", logType, spec.jsonKey, keys)
				continue
			}
			// TYPE AGREEMENT. This is the coverage the deleted Go indexer used
			// to give implicitly, through its typed decode structs: a money
			// field is a QUOTED string on our wire and must be a `string`
			// column, and a count is a BARE number and must be `numeric`.
			// Declaring money as `numeric` is the dangerous direction — it puts
			// a base-unit integer through Postgres' numeric parser on a money
			// contract, and it is exactly the kind of thing that reads fine
			// until an amount is large enough to matter.
			_, isNumber := value.(float64)
			switch spec.pgType {
			case "numeric":
				if !isNumber {
					t.Errorf("%s: column %q is declared `numeric` but core emits $.%s as a QUOTED STRING (%v). Money is always a string on this wire — declare it `string`.", logType, col, spec.jsonKey, value)
				}
			case "string":
				if isNumber {
					t.Errorf("%s: column %q is declared `string` but core emits $.%s as a BARE NUMBER (%v). Counts are numbers — declare it `numeric`.", logType, col, spec.jsonKey, value)
				}
			}
		}
	}
}

// TestMagiMapping_EveryEmittedEventIsMapped is the other direction: an event
// core emits but the YAML does not declare is simply never indexed. That is how
// `bought`/`sold` were silently dropped by our own indexer once.
//
// The three contract-level events with no per-market scope (init/paused/
// unpaused) are deliberately unmapped — they carry no creator and no query in
// any view needs them.
func TestMagiMapping_EveryEmittedEventIsMapped(t *testing.T) {
	mapping := magiMapping(t)
	deliberatelyUnmapped := map[string]bool{
		"init": true, "paused": true, "unpaused": true, "prepaid": true,
		// ★ The magi_nft-family events (2026-07-30). These are deliberately NOT
		// in OUR mapping, because they are not ours to map: the Magi indexer
		// ships a stock mapping for them, discovers this contract by watching
		// for init_magi_nft, and folds them into the SHARED magi_token/nft
		// tables every wallet and explorer already reads. Adding them here would
		// duplicate rows into a private table and defeat the entire point of
		// speaking the standard.
		"init_magi_nft": true, "tokenCreated": true, "TransferSingle": true,
		// Approval (F-C2) is the ERC-6909 approval event — same story: the indexer's
		// stock magi_nft mapping folds it, so it is deliberately NOT in our table.
		"Approval": true,
	}

	src, err := os.ReadFile("events.go")
	if err != nil {
		t.Fatalf("read events.go: %v", err)
	}
	// Same alternation the schema tripwire uses: every construction style.
	emitted := regexp.MustCompile(`evOpen\("([A-Za-z0-9_]+)"|evOpenActor\("([A-Za-z0-9_]+)"|\{"type":"([A-Za-z0-9_]+)"`).FindAllStringSubmatch(string(src), -1)
	seen := map[string]bool{}
	for _, m := range emitted {
		name := m[1] + m[2] + m[3]
		// NOTE: the old `strings.Contains(name, "name")` skip was removed
		// (scrutiny F7b) — it was dead against the real constructors and it
		// silently exempted any event whose name contained "name" from the
		// mapping check, which is a hole rather than a filter.
		if name == "" {
			continue
		}
		seen[name] = true
	}
	for name := range seen {
		if deliberatelyUnmapped[name] || mapping[name] != nil {
			continue
		}
		t.Errorf("core emits %q but ../magi-indexer/creator_tokens_mappings.yaml does not map it — the indexer will never store it, and anything built on it silently shows nothing. Add a mapping entry, or add it to deliberatelyUnmapped with a reason.", name)
	}
}

func scOne() *big.Int { return big.NewInt(1) }
