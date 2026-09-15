/** UNIT TESTS for `lib/meritum/card-cache.ts`. Run by `pnpm --filter @hive/blog test:unit` under ts-node; own harness. */
import { cardFileKey, cardStillValid, parseCardMeta, CARD_MAX_AGE_MS } from '../meritum/card-cache';

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

console.log('\ncardFileKey');
ok('a Hive name is itself', cardFileKey('lordbutterfly') === 'lordbutterfly' && cardFileKey('hbd-temp') === 'hbd-temp');
ok('a DID becomes a safe name (no colons, no slashes)', /^[A-Za-z0-9._-]+$/.test(cardFileKey('did:pkh:eip155:1:0xAbC')));
ok('a path-traversal handle cannot escape (no separators survive)', !cardFileKey('../../etc/passwd').includes('/') && !cardFileKey('..\\x').includes('\\'));
ok('a long handle is shortened with a tail hash, and stays unique', (() => { const a = cardFileKey('did:pkh:' + 'a'.repeat(120)); const b = cardFileKey('did:pkh:' + 'a'.repeat(119) + 'b'); return a.length <= 64 && b.length <= 64 && a !== b; })());

console.log('\ncardStillValid');
const NOW = 1_800_000_000_000;
const inputs = { revision: 2, cents: 102, about: 'hello', name: 'Lord', source: 'hive' };
const meta = { ...inputs, generatedAt: NOW - 1000 };
ok('same inputs, fresh -> valid', cardStillValid(meta, inputs, NOW));
ok('no meta -> not valid', !cardStillValid(null, inputs, NOW) && !cardStillValid(undefined, inputs, NOW));
ok('a price that moved a cent -> regenerate', !cardStillValid(meta, { ...inputs, cents: 103 }, NOW));
ok('a changed about -> regenerate', !cardStillValid(meta, { ...inputs, about: 'changed' }, NOW));
ok('null vs empty about are the same absence', cardStillValid({ ...meta, about: null }, { ...inputs, about: null }, NOW));
ok('a new drawing revision -> regenerate', !cardStillValid(meta, { ...inputs, revision: 3 }, NOW));
ok('a name change -> regenerate', !cardStillValid(meta, { ...inputs, name: 'Other' }, NOW));
ok('the store that answered changed (lite vs hive) -> regenerate', !cardStillValid(meta, { ...inputs, source: 'lite' }, NOW));
ok('older than a week -> regenerate (the face may have changed)', !cardStillValid({ ...meta, generatedAt: NOW - CARD_MAX_AGE_MS - 1 }, inputs, NOW));
ok('a generatedAt in the future -> regenerate (a clock went backwards)', !cardStillValid({ ...meta, generatedAt: NOW + 60_000 }, inputs, NOW));
ok('a corrupt generatedAt -> regenerate', !cardStillValid({ ...meta, generatedAt: Number.NaN }, inputs, NOW));

console.log('\nparseCardMeta');
ok('round trip', JSON.stringify(parseCardMeta(JSON.stringify(meta))) === JSON.stringify(meta));
ok('garbage -> null', parseCardMeta('{nope') === null && parseCardMeta('') === null && parseCardMeta(null) === null && parseCardMeta('[]') === null && parseCardMeta('42') === null);
ok('a record missing its numbers -> null', parseCardMeta('{"about":"x"}') === null);
ok('unexpected fields are dropped, missing strings become null', JSON.stringify(parseCardMeta('{"revision":2,"cents":1,"generatedAt":5,"source":"hive","evil":"<script>"}')) === JSON.stringify({ revision: 2, cents: 1, about: null, name: null, source: 'hive', generatedAt: 5 }));

if (failures === 0) {
  console.log(`\nmeritum-card-cache: ALL ${checks} CHECKS PASSED`);
  process.exit(0);
} else {
  console.error(`\nmeritum-card-cache: ${failures}/${checks} CHECK(S) FAILED`);
  process.exit(1);
}
