package market

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// magi_mapping_contract_test.go — proves ../magi-indexer/prediction_market_mappings.yaml
// actually matches what ../contract/main.go EMITS.
//
// WHY THIS EXISTS. That YAML tells magi-mongo-indexer (the official vsc-eco
// service we index through) how to read our logs: which `type` values to expect
// and which JSON fields to pull out of each. It is hand-written, it lives in
// another service's config format, and nothing about it is type-checked. A
// single renamed field on either side produces NO error anywhere: the indexer
// keeps running, the column just fills with NULLs forever, and every screen
// built on it quietly shows wrong numbers.
//
// That is not hypothetical here. The Go indexer this replaced had drifted from
// the contract without a single test going red: it knew "round_created" and
// "house_paid" — neither of which the contract can emit any more (the round
// opener was renamed to `roll` in the decentralization pass, and the house-fee
// entrypoints were deleted outright) — while knowing nothing about `roll`,
// `reclaim` or `sweep`, which are three of the seven events it actually writes.
// A stale mapping is the default outcome unless something forces the two to
// agree. This is that something.
//
// It reads BOTH sides as text. The contract package cannot be imported here at
// all: it is wasm-only (it pulls in the VSC SDK and a `runtime` package that
// does not build natively), which is the same reason `go build ./...` fails on
// this repo and every command gates on an explicit package list. Reading the
// source is therefore not laziness — it is the only way to check this from a
// natively-runnable test. The precedent is creator-tokens' own
// core/magi_mapping_contract_test.go and core/payee_address_test.go.
//
// If the file format ever drifts far enough that the regexes stop matching,
// TestMagiMapping_RegexesStillMatchBothFiles fails loudly. FIX THE REGEXES; do
// not delete these tests.

const (
	magiContractSrcPath = "../contract/main.go"
	magiMappingPath     = "../magi-indexer/prediction_market_mappings.yaml"
)

var (
	// One sdk.Log(...) call. Every log site in main.go is a single line whose
	// first backtick literal opens the JSON object.
	magiLogLineRe = regexp.MustCompile(`sdk\.Log\(`)
	// The event discriminator, always the first key in the object.
	magiLogTypeInSrcRe = regexp.MustCompile(`\{"type":"([A-Za-z_]+)"`)
	// A JSON key inside a log literal, capturing the single character that
	// follows the colon. That character is what tells us the value's wire type:
	// a double quote means the value is a quoted string; a backtick means the
	// literal ended and the value is a raw Go expression spliced in unquoted,
	// i.e. a bare JSON number.
	magiKeyInSrcRe = regexp.MustCompile("\"([A-Za-z]+)\":(.)")

	// YAML side. Mirrors the flow-style used by creator-tokens' mapping file so
	// the two Lumen mappings stay diffable against each other.
	magiLogTypeRe = regexp.MustCompile(`log_type:\s*"([^"]+)"`)
	magiFieldsRe  = regexp.MustCompile(`fields:\s*\{([^}]*)\}`)
	magiPathRe    = regexp.MustCompile(`([a-z_]+):\s*"\$\.([A-Za-z]+)"`)
	magiSchemaRe  = regexp.MustCompile(`schema:\s*\{([^}]*)\}`)
	magiColRe     = regexp.MustCompile(`([a-z_]+):\s*(numeric|string)`)
)

// wireType is what the CONTRACT actually writes for a field.
const (
	wireNumber = "numeric" // spliced in unquoted: u64s(...), strconv.Itoa(...)
	wireString = "string"  // wrapped in quotes in the literal
)

// magiEmitted returns logType -> jsonKey -> wire type, read from the contract
// source. The "type" discriminator itself is excluded: it selects the mapping,
// it is not a mapped column.
func magiEmitted(t *testing.T) map[string]map[string]string {
	t.Helper()
	raw, err := os.ReadFile(magiContractSrcPath)
	if err != nil {
		t.Fatalf("cannot read %s: %v", magiContractSrcPath, err)
	}

	out := map[string]map[string]string{}
	for _, line := range strings.Split(string(raw), "\n") {
		if !magiLogLineRe.MatchString(line) {
			continue
		}
		typeMatch := magiLogTypeInSrcRe.FindStringSubmatch(line)
		if typeMatch == nil {
			t.Fatalf("%s: an sdk.Log line has no {\"type\":\"...\"} discriminator, so magi-mongo-indexer could never match it (it keys on raw[\"type\"], mapper.go:87-92):\n  %s", magiContractSrcPath, strings.TrimSpace(line))
		}
		logType := typeMatch[1]
		if _, dup := out[logType]; dup {
			// Not fatal in principle — creator-tokens has an entrypoint that
			// emits two logs — but in THIS contract each event has exactly one
			// emission site, and a duplicate would more likely be a copy-paste
			// error than a design choice. Make it visible.
			t.Fatalf("%s: log type %q is emitted from more than one site; if that is deliberate, relax this check consciously", magiContractSrcPath, logType)
		}

		fields := map[string]string{}
		for _, m := range magiKeyInSrcRe.FindAllStringSubmatch(line, -1) {
			key, next := m[1], m[2]
			if key == "type" {
				continue
			}
			switch next {
			case `"`:
				fields[key] = wireString
			case "`":
				fields[key] = wireNumber
			default:
				t.Fatalf("%s: cannot tell the wire type of %q in log %q — the character after the colon was %q, expected a quote (string) or a backtick (spliced number). The log literal's shape changed; fix this test rather than guessing.", magiContractSrcPath, key, logType, next)
			}
		}
		out[logType] = fields
	}
	return out
}

// magiColumn pairs one declared Postgres column with the JSON key it pulls and
// the type the YAML says it is.
type magiColumn struct {
	jsonKey string
	pgType  string // "numeric" | "string"
}

// magiMapping returns logType -> column name -> {jsonKey, pgType}, read from the
// YAML with full-line comments stripped so prose can never be parsed as config.
func magiMapping(t *testing.T) map[string]map[string]magiColumn {
	t.Helper()
	raw, err := os.ReadFile(magiMappingPath)
	if err != nil {
		t.Fatalf("cannot read %s: %v", magiMappingPath, err)
	}

	var body []string
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		body = append(body, line)
	}
	text := strings.Join(body, "\n")

	types := magiLogTypeRe.FindAllStringSubmatch(text, -1)
	fieldBlocks := magiFieldsRe.FindAllStringSubmatch(text, -1)
	schemaBlocks := magiSchemaRe.FindAllStringSubmatch(text, -1)

	if len(types) == 0 || len(fieldBlocks) == 0 || len(schemaBlocks) == 0 {
		t.Fatalf("%s: found %d log_type, %d fields and %d schema blocks — the file format changed and this test's regexes no longer match it. Fix the regexes; do NOT delete this test.", magiMappingPath, len(types), len(fieldBlocks), len(schemaBlocks))
	}
	if len(types) != len(fieldBlocks) || len(types) != len(schemaBlocks) {
		t.Fatalf("%s: %d log_type entries but %d fields and %d schema blocks — every event must declare exactly one of each", magiMappingPath, len(types), len(fieldBlocks), len(schemaBlocks))
	}

	out := map[string]map[string]magiColumn{}
	for i, ty := range types {
		logType := ty[1]
		cols := map[string]magiColumn{}

		declared := map[string]string{} // column -> pgType
		for _, c := range magiColRe.FindAllStringSubmatch(schemaBlocks[i][1], -1) {
			declared[c[1]] = c[2]
		}
		for _, p := range magiPathRe.FindAllStringSubmatch(fieldBlocks[i][1], -1) {
			col, jsonKey := p[1], p[2]
			pgType, ok := declared[col]
			if !ok {
				t.Errorf("%s [%s]: fields maps column %q but schema never declares it — the indexer would have nowhere to put the value", magiMappingPath, logType, col)
				continue
			}
			cols[col] = magiColumn{jsonKey: jsonKey, pgType: pgType}
		}
		for col := range declared {
			if _, ok := cols[col]; !ok {
				t.Errorf("%s [%s]: schema declares column %q but fields never fills it — it would be NULL for every row, forever", magiMappingPath, logType, col)
			}
		}
		out[logType] = cols
	}
	return out
}

func magiSortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// The regexes on both sides must actually find something. Without this, every
// other test in this file passes vacuously the moment a format changes.
func TestMagiMapping_RegexesStillMatchBothFiles(t *testing.T) {
	emitted := magiEmitted(t)
	mapped := magiMapping(t)

	if len(emitted) < 2 {
		t.Fatalf("only %d event(s) found in %s — the sdk.Log format changed and magiEmitted no longer parses it. Every test in this file is vacuous until that is fixed.", len(emitted), magiContractSrcPath)
	}
	if len(mapped) < 2 {
		t.Fatalf("only %d event(s) found in %s — the YAML format changed and magiMapping no longer parses it.", len(mapped), magiMappingPath)
	}
	for logType, fields := range emitted {
		if len(fields) == 0 {
			t.Errorf("event %q parsed with zero fields — magiKeyInSrcRe stopped matching the log literal's shape", logType)
		}
	}
}

// Every event the contract writes must have somewhere to land. An unmapped event
// is not an error to the indexer — it simply ignores the log line, so the data
// is lost silently and permanently.
func TestMagiMapping_EveryEmittedEventIsMapped(t *testing.T) {
	emitted := magiEmitted(t)
	mapped := magiMapping(t)
	for _, logType := range magiSortedKeys(emitted) {
		if _, ok := mapped[logType]; !ok {
			t.Errorf("contract emits %q but %s has no mapping for it — magi-mongo-indexer would drop every one of these logs without error", logType, magiMappingPath)
		}
	}
}

// The mirror check, and the one that would have caught the old Go indexer's rot:
// it declared "round_created" and "house_paid" long after the contract stopped
// being able to emit either.
func TestMagiMapping_EveryMappedEventIsEmitted(t *testing.T) {
	emitted := magiEmitted(t)
	mapped := magiMapping(t)
	for _, logType := range magiSortedKeys(mapped) {
		if _, ok := emitted[logType]; !ok {
			t.Errorf("%s maps %q but the contract never emits it — a table that stays empty forever, and a sign the mapping has drifted from the contract", magiMappingPath, logType)
		}
	}
}

// A field the contract writes but the mapping ignores is data thrown away at the
// door — recoverable only by re-indexing from genesis after someone notices.
func TestMagiMapping_EveryEmittedFieldIsMapped(t *testing.T) {
	emitted := magiEmitted(t)
	mapped := magiMapping(t)
	for _, logType := range magiSortedKeys(emitted) {
		cols, ok := mapped[logType]
		if !ok {
			continue // reported by EveryEmittedEventIsMapped
		}
		pulled := map[string]bool{}
		for _, c := range cols {
			pulled[c.jsonKey] = true
		}
		for _, key := range magiSortedKeys(emitted[logType]) {
			if !pulled[key] {
				t.Errorf("event %q emits field %q but no column in %s pulls it — the value is discarded at index time", logType, key, magiMappingPath)
			}
		}
	}
}

// The inverse: a column pulling a JSON path the contract never writes fills with
// NULL for every row, forever, with no error anywhere.
func TestMagiMapping_EveryMappedPathIsEmitted(t *testing.T) {
	emitted := magiEmitted(t)
	mapped := magiMapping(t)
	for _, logType := range magiSortedKeys(mapped) {
		fields, ok := emitted[logType]
		if !ok {
			continue // reported by EveryMappedEventIsEmitted
		}
		for _, col := range magiSortedKeys(mapped[logType]) {
			key := mapped[logType][col].jsonKey
			if _, ok := fields[key]; !ok {
				t.Errorf("%s [%s]: column %q pulls $.%s, which the contract never emits — that column would be NULL for every row, forever", magiMappingPath, logType, col, key)
			}
		}
	}
}

// The guard that the deleted Go indexer's typed decode structs were providing
// implicitly: money is a quoted string on our wire, ids and counts are bare
// numbers. Declaring a money field `numeric` invites the pipeline to put staked
// user funds through a float; declaring a round id `string` breaks every join
// and ORDER BY built on it.
func TestMagiMapping_ColumnTypesMatchTheWire(t *testing.T) {
	emitted := magiEmitted(t)
	mapped := magiMapping(t)
	for _, logType := range magiSortedKeys(mapped) {
		fields, ok := emitted[logType]
		if !ok {
			continue
		}
		for _, col := range magiSortedKeys(mapped[logType]) {
			c := mapped[logType][col]
			wire, ok := fields[c.jsonKey]
			if !ok {
				continue // reported by EveryMappedPathIsEmitted
			}
			if wire != c.pgType {
				t.Errorf("%s [%s]: column %q is declared %s but the contract writes $.%s as a %s. A quoted JSON string must be declared `string` (this is how every money amount travels — base-unit integers as text, never through a float) and an unquoted JSON number must be declared `numeric`.",
					magiMappingPath, logType, col, c.pgType, c.jsonKey, wire)
			}
		}
	}
}
