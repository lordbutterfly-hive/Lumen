/**
 * UNIT TESTS for the hidden-card preference (`lib/builders-card-visibility.ts`).
 * Run by `pnpm --filter @hive/blog test:unit` under ts-node; own harness.
 */
import { readBuildersHidden, writeBuildersHidden, BUILDERS_HIDDEN_KEY } from '../builders-card-visibility';
import type { StorageLike } from '../builders-card-visibility';

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

const fake = (): StorageLike & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
};
const throwing: StorageLike = {
  getItem: () => { throw new Error('SecurityError: access denied'); },
  setItem: () => { throw new Error('QuotaExceededError'); },
  removeItem: () => { throw new Error('SecurityError'); }
};

console.log('\ndefaults');
ok('nothing stored -> shown', readBuildersHidden(fake()) === false);
ok('no storage at all (SSR, or a browser that refuses it) -> shown', readBuildersHidden(null) === false);
ok('writing with no storage does not throw', (() => { writeBuildersHidden(true, null); return true; })());

console.log('\nhide, then show, round-trips');
const s = fake();
writeBuildersHidden(true, s, 1_700_000_000_000);
ok('hidden after hide', readBuildersHidden(s) === true);
ok('stored under the versioned key', s.map.has(BUILDERS_HIDDEN_KEY));
const envelope = JSON.parse(s.map.get(BUILDERS_HIDDEN_KEY) ?? '{}');
ok('envelope is the storage-with-ttl shape, permanent', envelope.value === true && envelope.expiresAt === null && envelope.createdAt === 1_700_000_000_000);
writeBuildersHidden(false, s);
ok('shown after show', readBuildersHidden(s) === false);
ok('showing removes the key rather than storing false', !s.map.has(BUILDERS_HIDDEN_KEY));
writeBuildersHidden(true, s);
writeBuildersHidden(true, s);
ok('hiding twice is still hidden, one key', readBuildersHidden(s) === true && s.map.size === 1);

console.log('\nhostile contents never throw, always mean shown');
for (const [label, raw] of [['corrupt JSON', '{nope'], ['a bare string', '"true"'], ['value false', '{"value":false,"expiresAt":null,"createdAt":1}'], ['value "true" as a string', '{"value":"true","expiresAt":null,"createdAt":1}'], ['an array', '[true]'], ['null', 'null'], ['empty string', '']] as const) {
  const t = fake();
  t.map.set(BUILDERS_HIDDEN_KEY, raw);
  ok(`${label} -> shown`, readBuildersHidden(t) === false);
}
ok('the legacy-free envelope with value true and an expiry in the past is still hidden (permanent items never expire; expiresAt is ignored here)', (() => { const t = fake(); t.map.set(BUILDERS_HIDDEN_KEY, JSON.stringify({ value: true, expiresAt: 1, createdAt: 1 })); return readBuildersHidden(t) === true; })());

console.log('\na storage that throws (private window, blocked site data, full quota)');
ok('read -> shown, no throw', readBuildersHidden(throwing) === false);
ok('hide -> no throw', (() => { writeBuildersHidden(true, throwing); return true; })());
ok('show -> no throw', (() => { writeBuildersHidden(false, throwing); return true; })());

console.log('\nother keys are untouched');
const u = fake();
u.map.set('user-preferences-x', '{"value":1,"expiresAt":null,"createdAt":1}');
writeBuildersHidden(true, u);
writeBuildersHidden(false, u);
ok('a neighbouring key survives hide+show', u.map.get('user-preferences-x') === '{"value":1,"expiresAt":null,"createdAt":1}' && u.map.size === 1);

if (failures === 0) {
  console.log(`\nbuilders-card-visibility: ALL ${checks} CHECKS PASSED`);
  process.exit(0);
} else {
  console.error(`\nbuilders-card-visibility: ${failures}/${checks} CHECK(S) FAILED`);
  process.exit(1);
}
