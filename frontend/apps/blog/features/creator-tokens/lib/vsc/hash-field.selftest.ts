/**
 * hash-field.selftest.ts — the client's hash validation vs the CONTRACT's.
 *
 * Run: cd apps/blog && npx tsx features/creator-tokens/lib/vsc/hash-field.selftest.ts
 *
 * The contract applies FOUR rules to contentHash/answerHash (core/ask.go:379-390,
 * :595-606): non-empty, byte-length <= MaxHashLen(128), no '|', and
 * validEventHash — no byte < 0x20 and no 0x7f. The client historically checked
 * the first, a UTF-16 approximation of the second, and the third. This pins all
 * four, and specifically the two that used to pass the client and revert on
 * chain AFTER the user signed.
 */
import { hashFieldProblem } from './payload-contract';

let passed = 0; const failures: string[] = [];
const ok = (label: string, cond: boolean, detail = '') => { if (cond) passed++; else failures.push(`${label}${detail ? ` — ${detail}` : ''}`); };
const accepts = (v: string) => hashFieldProblem('answerHash', v) === null;

ok('plain ascii accepted', accepts('abc123'));
ok('exactly 128 bytes accepted', accepts('a'.repeat(128)));
ok('129 bytes refused', !accepts('a'.repeat(129)));
ok('empty refused', !accepts(''));
ok('pipe refused', !accepts('ab|cd'));

// ★ THE TEXTAREA CASE: Enter in the Answer dialog.
ok('newline refused', !accepts('line one\nline two'));
ok('tab refused', !accepts('a\tb'));
ok('carriage return refused', !accepts('a\rb'));
ok('DEL (0x7f) refused', !accepts('a\x7fb'));
ok('NUL refused', !accepts('a\x00b'));

// ★ BYTES vs UTF-16: 100 CJK chars are 100 UTF-16 units but 300 UTF-8 bytes.
const cjk100 = '中'.repeat(100);
ok('100 CJK chars (300 bytes) refused — the old .length check accepted them',
   !accepts(cjk100), `bytes=${new TextEncoder().encode(cjk100).length}`);
const cjk42 = '中'.repeat(42); // 126 bytes
ok('42 CJK chars (126 bytes) accepted', accepts(cjk42));
const emoji = '\u{1F600}'.repeat(33); // 4 bytes each = 132
ok('33 emoji (132 bytes) refused', !accepts(emoji));

// Multi-byte content must NOT be mistaken for a control byte (the reason the
// contract scans bytes rather than runes, and why we mirror it byte-wise).
ok('accented latin accepted', accepts('café-résumé'));
// ★ 43's review: the UI string must not leak field names, file paths or Go
// identifiers at a creator who is trying to answer a customer.
const msg = hashFieldProblem('answerHash', 'a\nb') ?? '';
ok('UI reason is human', msg.includes('line breaks') && msg.startsWith('Your answer'));
ok('UI reason leaks no field name', !msg.includes('answerHash'));
ok('UI reason leaks no file path', !msg.includes('ask.go') && !msg.includes('payload-contract'));
const longMsg = hashFieldProblem('contentHash', '\u4e2d'.repeat(100)) ?? '';
ok('length reason is human', longMsg.startsWith('Your request') && longMsg.includes('too long'));
ok('length reason gives no raw byte count', !/\d/.test(longMsg));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
