/**
 * escrow-roundtrip.selftest.ts — GO-PACKED ROUND TRIP for parseEscrow.
 *
 * Plain assertions, no test runner (this repo has none). Run with:
 *   cd apps/blog && npx tsx features/creator-tokens/lib/vsc/escrow-roundtrip.selftest.ts
 *
 * ★★★ WHY THIS FILE EXISTS. The escrow packed layout has drifted THREE times
 * (6->7, 7->8, and 8->9 found 2026-08-31), and every time the only thing
 * asserting the field count was a COMMENT in parseEscrow claiming it had been
 * "verified at source" on some date. A comment cannot fail. Each drift put a
 * structural field into a free-form one: at 8-vs-9 the client read `offeringID`
 * as `contentHash` and the pipe-joined `contentHash|answerHash` pair as
 * `answerHash`, silently, on every escrow in every inbox.
 *
 * THE FIXTURES BELOW WERE PRODUCED BY THE CONTRACT ITSELF, not written by hand:
 * `core/escrow_fixture_gen_test.go` builds real `escrowRec` values, packs them
 * with `packEscrow`, asserts `unpackEscrow` accepts the result (so a fixture can
 * never encode a string the contract would refuse), and prints them. Regenerate
 * with:
 *   cd <creator-tokens> && go test ./core/ -run TestGenEscrowFixtures -v
 * and paste the JSON. If the Go layout changes, the regenerated strings stop
 * matching these expectations and this test fails — which is the entire point.
 *
 * The nasty cases are deliberate: an EMPTY trailing `answerHash` (the packed
 * string ends in '|'), and an `answerHash` CONTAINING LITERAL PIPES, which is
 * legal because only the first 8 delimiters are structural — `answerHash` is
 * "everything after", matching Go's SplitN(v, "|", 9) semantics exactly.
 */
import { parseEscrow } from './reads';

interface Fixture {
  name: string; packed: string;
  asker: string; credits: string; deadline: number; status: string;
  commissionHbd: string; acqBlock: number; offeringID: number;
  contentHash: string; answerHash: string;
}

// --- verbatim output of TestGenEscrowFixtures, 2026-08-31 -------------------
const FIXTURES: Fixture[] = [
  { name: 'typical', packed: 'hive:alice|7|6200000|PENDING|1200|6100000|3|abc123|',
    asker: 'hive:alice', credits: '7', deadline: 6200000, status: 'PENDING',
    commissionHbd: '1200', acqBlock: 6100000, offeringID: 3, contentHash: 'abc123', answerHash: '' },
  { name: 'offering-zero', packed: 'hive:bob|1|1|ANSWERED|0|0|0|c|a',
    asker: 'hive:bob', credits: '1', deadline: 1, status: 'ANSWERED',
    commissionHbd: '0', acqBlock: 0, offeringID: 0, contentHash: 'c', answerHash: 'a' },
  { name: 'did-asker-and-big-offering',
    packed: 'did:pkh:bip122:000000000019d6689c085ae165831e93:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq|999999|18446744073709551615|DECLINED|123456789|123456|4294967295|0123456789abcdef|fedcba9876543210',
    asker: 'did:pkh:bip122:000000000019d6689c085ae165831e93:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    credits: '999999', deadline: 18446744073709551615, status: 'DECLINED',
    commissionHbd: '123456789', acqBlock: 123456, offeringID: 4294967295,
    contentHash: '0123456789abcdef', answerHash: 'fedcba9876543210' },
  { name: 'answerHash-contains-pipe', packed: 'hive:carol|2|7|RECLAIMED|5|9|1|hash|tail|with|pipes',
    asker: 'hive:carol', credits: '2', deadline: 7, status: 'RECLAIMED',
    commissionHbd: '5', acqBlock: 9, offeringID: 1, contentHash: 'hash', answerHash: 'tail|with|pipes' }
];

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = '') {
  if (ok) { passed++; } else { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); }
}

for (const f of FIXTURES) {
  const p = parseEscrow(f.packed);
  if (!p) { check(`${f.name}: parses`, false, 'parseEscrow returned null'); continue; }
  check(`${f.name}: parses`, true);
  check(`${f.name}: asker`, p.asker === f.asker, `got ${p.asker}`);
  check(`${f.name}: tokensEscrowed`, p.tokensEscrowed === Number(f.credits), `got ${p.tokensEscrowed} want ${f.credits}`);
  check(`${f.name}: deadlineBlock`, p.deadlineBlock === f.deadline, `got ${p.deadlineBlock} want ${f.deadline}`);
  check(`${f.name}: status`, p.status === f.status, `got ${p.status}`);
  check(`${f.name}: acqBlock`, p.acqBlock === f.acqBlock, `got ${p.acqBlock} want ${f.acqBlock}`);
  // ★ THE FIELD THE 8-FIELD PARSER SILENTLY ATE.
  check(`${f.name}: offeringId`, p.offeringId === f.offeringID, `got ${p.offeringId} want ${f.offeringID}`);
  check(`${f.name}: contentHash`, p.contentHash === f.contentHash, `got ${JSON.stringify(p.contentHash)} want ${JSON.stringify(f.contentHash)}`);
  check(`${f.name}: answerHash`, p.answerHash === f.answerHash, `got ${JSON.stringify(p.answerHash)} want ${JSON.stringify(f.answerHash)}`);
}

// A string with too FEW fields must be refused, not partially parsed — the
// 8-field shape is exactly what the previous (wrong) parser accepted, so this
// pins that the fix cannot silently regress by becoming permissive.
check('an 8-field (pre-offeringID) string is REFUSED',
  parseEscrow('hive:alice|7|6200000|PENDING|1200|6100000|abc123') === null);
check('a 7-field string is REFUSED',
  parseEscrow('hive:alice|7|6200000|PENDING|1200|6100000') === null);
check('a non-integer offeringID is REFUSED',
  parseEscrow('hive:alice|7|6200000|PENDING|1200|6100000|3.5|abc123|') === null);
check('an unknown status is REFUSED',
  parseEscrow('hive:alice|7|6200000|WAT|1200|6100000|3|abc123|') === null);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
