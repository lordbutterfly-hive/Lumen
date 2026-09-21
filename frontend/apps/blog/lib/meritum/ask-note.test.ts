/** UNIT TESTS for `lib/meritum/ask-note.ts`. Run by `pnpm --filter @hive/blog test:unit` under ts-node; own harness. */
import { askReferenceOf, contractKeyOf, isAskReference, noteTextProblem, parseReferenceList, MAX_ASK_NOTE_CHARS, MAX_ASK_NOTE_LOOKUP } from './ask-note';
import { askReference } from '../../features/creator-tokens/ui/token-page/token-page-helpers';
import { toDid } from '../../features/creator-tokens/lib/vsc/reads';

let checks = 0;
let failures = 0;
function ok(label: string, pass: boolean, detail = '') {
  checks++;
  if (pass) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\naskReferenceOf === askReference (the dialog\'s own function), on a corpus');
// Deterministic pseudo-random strings so a divergence is reproducible.
let seed = 0x9e3779b9;
const rnd = (): number => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) / 0x100000000;
};
const ALPHABET = 'abc XYZ019 .,;:!?\'"-\n\t😀é한字 　';
const corpus: string[] = [
  'Can you review my portfolio?',
  '  padded   ',
  'a',
  'x'.repeat(2000),
  'unicode: héllo wörld 한국어 日本語 😀🚀',
  '\n\nleading newlines',
  'trailing tab\t',
  'pipe | inside',
  ' nbsp is not trimmed by trim()? it is.',
  'surrogate pair at end 😀'
];
for (let i = 0; i < 500; i++) {
  const len = 1 + Math.floor(rnd() * 120);
  let s = '';
  for (let j = 0; j < len; j++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
  corpus.push(s);
}
let mismatches = 0;
for (const text of corpus) {
  if (askReferenceOf(text) !== askReference(text)) mismatches++;
}
ok(`identical on ${corpus.length} strings (fixed edge cases + 500 random)`, mismatches === 0, `${mismatches} differ`);
ok('the live reference from the test row reproduces', askReferenceOf('Can you review my portfolio?') === askReference('Can you review my portfolio?'));
ok('blank text has NO reference (the dialog mints a timestamp there, which nothing can match)', askReferenceOf('') === null && askReferenceOf('   \n') === null);
ok('the reference is the trimmed text\'s, so padding does not change it', askReferenceOf('  hello  ') === askReferenceOf('hello'));
ok('shape is ask-<base36>', /^ask-[0-9a-z]{1,8}$/.test(askReferenceOf('anything') as string));

console.log('\nnoteTextProblem');
ok('a normal message is fine', noteTextProblem('Could you look at my draft by Friday?') === null);
ok('multi-line with tabs is fine', noteTextProblem('line one\nline two\ttabbed\r\nthree') === null);
ok('empty is refused', noteTextProblem('') !== null && noteTextProblem('   ') !== null);
ok(`exactly ${MAX_ASK_NOTE_CHARS} chars is fine`, noteTextProblem('x'.repeat(MAX_ASK_NOTE_CHARS)) === null);
ok(`${MAX_ASK_NOTE_CHARS + 1} chars is refused, and the sentence says how long it is`, (noteTextProblem('x'.repeat(MAX_ASK_NOTE_CHARS + 1)) ?? '').includes(String(MAX_ASK_NOTE_CHARS + 1)));
ok('padding does not count toward the bound', noteTextProblem(' '.repeat(50) + 'x'.repeat(MAX_ASK_NOTE_CHARS) + ' '.repeat(50)) === null);
ok('NUL is refused', noteTextProblem('a\u0000b') !== null);
ok('ESC is refused', noteTextProblem('a\u001bb') !== null);
ok('DEL is refused', noteTextProblem('a\u007fb') !== null);
ok('C1 (U+0085) is refused', noteTextProblem('a\u0085b') !== null);
ok('U+2028 is refused', noteTextProblem('a b') !== null);
ok('emoji and CJK are fine', noteTextProblem('😀 日本語 한국어') === null);

console.log('\ncontractKeyOf === toDid (lib/vsc/reads.ts)');
for (const a of ['lordbutterfly', 'hive:lordbutterfly', 'did:pkh:eip155:1:0xAbC123', 'hbd-temp', 'did:pkh:bip122:000000000019d6689c085ae165831e93:bc1qxyz']) {
  ok(`${a} -> ${toDid(a)}`, contractKeyOf(a) === toDid(a), `got ${contractKeyOf(a)}`);
}
ok('a leading @ or whitespace is dropped before keying (toDid does not see those; the route does)', contractKeyOf(' @lordbutterfly ') === 'hive:lordbutterfly');
ok('EIP-55 case is preserved', contractKeyOf('did:pkh:eip155:1:0xAbCdEf') === 'did:pkh:eip155:1:0xAbCdEf');

console.log('\nisAskReference / parseReferenceList');
ok('accepts a real reference', isAskReference('ask-14woy0'));
ok('refuses a bare hash, a pipe, uppercase, and a timestamp-length tail', !isAskReference('14woy0') && !isAskReference('ask-a|b') && !isAskReference('ask-ABC') && !isAskReference('ask-' + 'a'.repeat(9)));
ok('a 32-bit hash never exceeds 7 base-36 digits; timestamps (9) are excluded on purpose', (0xffffffff).toString(36).length === 7 && !isAskReference(`ask-${Date.now().toString(36)}`));
ok('parses, trims, dedupes and drops junk', JSON.stringify(parseReferenceList(' ask-1, ask-2 ,ask-1,,junk,ask-a|b')) === JSON.stringify(['ask-1', 'ask-2']));
ok('null -> []', parseReferenceList(null).length === 0);
ok(`bounded at ${MAX_ASK_NOTE_LOOKUP}`, parseReferenceList(Array.from({ length: 80 }, (_, i) => `ask-${i.toString(36)}`).join(',')).length === MAX_ASK_NOTE_LOOKUP);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
