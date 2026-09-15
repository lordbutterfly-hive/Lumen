/** UNIT TESTS for `lib/meritum/profile-fields.ts`. Run by `pnpm --filter @hive/blog test:unit` under ts-node; own harness. */
import { sanitizeAbout, sanitizeProfileImage, truncateOnWord, ABOUT_MAX_CHARS } from '../meritum/profile-fields';

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

console.log('\nsanitizeAbout');
ok('a normal about passes verbatim', sanitizeAbout('Blockchain security researcher. Nine years on Hive.') === 'Blockchain security researcher. Nine years on Hive.');
ok('not a string -> null', sanitizeAbout(undefined) === null && sanitizeAbout(42) === null && sanitizeAbout({ a: 1 }) === null);
ok('empty / whitespace -> null (the line is DROPPED, no placeholder)', sanitizeAbout('') === null && sanitizeAbout('   \n\t ') === null);
ok('whitespace collapses to single spaces', sanitizeAbout('a\n\n  b\t\tc') === 'a b c');
ok('control characters are stripped', sanitizeAbout('a\u0000b\u0007c\u001fd') === 'abcd');
ok('bidi overrides and zero-width characters are stripped', sanitizeAbout('Buy\u202e yuB\u200b\u2066x\ufeff') === 'Buy yuBx');
ok('markup is kept as TEXT, not stripped (React escapes it; nothing renders it as HTML)', sanitizeAbout('<b>hi</b> & <script>x</script>') === '<b>hi</b> & <script>x</script>');
const long = 'word '.repeat(100).trim();
const cut = sanitizeAbout(long) ?? '';
ok(`longer than ${ABOUT_MAX_CHARS} is truncated on a word with an ellipsis`, cut.length <= ABOUT_MAX_CHARS + 1 && cut.endsWith('…') && !cut.endsWith(' …') && cut.slice(0, -1).split(' ').every((w) => w === 'word'));
ok('exactly at the cap is untouched', sanitizeAbout('x'.repeat(ABOUT_MAX_CHARS)) === 'x'.repeat(ABOUT_MAX_CHARS));

console.log('\ntruncateOnWord');
ok('short text untouched', truncateOnWord('hello world', 20) === 'hello world');
ok('cuts at the last space before the limit (the word at the edge may be partial, so it goes too)', truncateOnWord('the quick brown fox jumps', 15) === 'the quick…');
ok('trailing punctuation before the ellipsis is dropped', truncateOnWord('one, two, three, four', 10) === 'one, two…');
ok('a single huge word is cut hard rather than kept whole', truncateOnWord('a'.repeat(50), 10) === 'aaaaaaaaaa…');

console.log('\nsanitizeProfileImage');
ok('an https image URL passes', sanitizeProfileImage('https://images.hive.blog/u/lordbutterfly/avatar/large') === 'https://images.hive.blog/u/lordbutterfly/avatar/large');
ok('the fragment is dropped', sanitizeProfileImage('https://example.com/a.png#frag') === 'https://example.com/a.png');
for (const [label, bad] of [
  ['http (mixed content)', 'http://example.com/a.png'],
  ['javascript:', 'javascript:alert(1)'],
  ['data:', 'data:image/png;base64,AAAA'],
  ['credentials in the URL', 'https://user:pw@example.com/a.png'],
  ['an IPv4 literal', 'https://127.0.0.1/a.png'],
  ['an IPv6 literal', 'https://[::1]/a.png'],
  ['no dot in the host (an internal name)', 'https://localhost/a.png'],
  ['not a URL', 'not a url'],
  ['empty', ''],
  ['too long', 'https://example.com/' + 'a'.repeat(600)],
  ['not a string', 12]
] as const) ok(`${label} -> null`, sanitizeProfileImage(bad) === null);

if (failures === 0) {
  console.log(`\nmeritum-profile-fields: ALL ${checks} CHECKS PASSED`);
  process.exit(0);
} else {
  console.error(`\nmeritum-profile-fields: ${failures}/${checks} CHECK(S) FAILED`);
  process.exit(1);
}
