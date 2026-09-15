/** UNIT TESTS for `lib/meritum/creator-handle.ts`. Run by `pnpm --filter @hive/blog test:unit` under ts-node; own harness. */
import { normalizeCreatorHandle, isRoutableCreatorHandle, routeHandleOf, creatorPagePath, creatorPageUrl, legacyCreatorPagePath, loginThenReturnTo, creatorCardPath, CARD_REVISION } from '../meritum/creator-handle';

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

console.log('\nnormalizeCreatorHandle');
ok('plain name passes', normalizeCreatorHandle('lordbutterfly') === 'lordbutterfly');
ok('leading @ stripped', normalizeCreatorHandle('@lordbutterfly') === 'lordbutterfly');
ok('%40 (what Next hands the route) stripped', normalizeCreatorHandle('%40lordbutterfly') === 'lordbutterfly');
ok('stacked prefixes all stripped', normalizeCreatorHandle('%2540@%40x') === 'x');
ok('uppercase Hive name lowercased', normalizeCreatorHandle('HBD-TEMP') === 'hbd-temp');
ok('a DID keeps its case and its colons', normalizeCreatorHandle('did:pkh:eip155:1:0xAbC') === 'did:pkh:eip155:1:0xAbC');
ok('a DID with re-encoded colons is decoded', normalizeCreatorHandle('did%3Apkh%3Aeip155%3A1%3A0xAbC') === 'did:pkh:eip155:1:0xAbC');
ok('a bare % does not throw and is kept', normalizeCreatorHandle('abc%') === 'abc%');
ok('whitespace trimmed', normalizeCreatorHandle('  gtg ') === 'gtg');

console.log('\nisRoutableCreatorHandle: what can be a page at all');
for (const good of ['lordbutterfly', 'hbd-temp', 'a.b', 'ab', 'did:pkh:eip155:1:0xAbC123', 'did:pkh:bip122:000000000019d6689c085ae165831e93:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'did:pkh:some-chain_x.y:1:abc']) ok(`${good} -> routable`, isRoutableCreatorHandle(good));
for (const bad of ['', 'a', '1abc', 'Lord', 'abc%', 'x'.repeat(17), '../etc', 'a b', 'did:pkh:', 'did:pkh:eip155:1:0x<script>', 'did:pkh:a|b', 'did:pkh:a/b', 'javascript:alert(1)', 'did:pkh:' + 'a:'.repeat(90) + 'b']) ok(`${JSON.stringify(bad).slice(0, 40)} -> NOT routable`, !isRoutableCreatorHandle(bad));

console.log('\ncreatorPagePath / creatorPageUrl');
ok('/m/<name>', creatorPagePath('lordbutterfly') === '/m/lordbutterfly');
ok('hive: prefix dropped', creatorPagePath('hive:lordbutterfly') === '/m/lordbutterfly');
ok('routeHandleOf strips hive: only', routeHandleOf('hive:x') === 'x' && routeHandleOf('did:pkh:a:b:c') === 'did:pkh:a:b:c' && routeHandleOf(null) === '');
ok('a DID is encoded once (colons survive the router)', creatorPagePath('did:pkh:eip155:1:0xAbC') === '/m/did%3Apkh%3Aeip155%3A1%3A0xAbC');
ok('buy deep link', creatorPagePath('lordbutterfly', 'buy') === '/m/lordbutterfly?a=buy');
ok('spend deep link carries the offering id', creatorPagePath('lordbutterfly', 'spend', 2) === '/m/lordbutterfly?a=spend&o=2');
ok('spend without a valid id carries none', creatorPagePath('lordbutterfly', 'spend', -1) === '/m/lordbutterfly?a=spend' && creatorPagePath('lordbutterfly', 'spend', 1.5) === '/m/lordbutterfly?a=spend');
ok('an id on a non-spend action is ignored', creatorPagePath('lordbutterfly', 'buy', 2) === '/m/lordbutterfly?a=buy');
ok('absolute URL from the configured origin', creatorPageUrl('https://lumensocial.net', 'lordbutterfly') === 'https://lumensocial.net/m/lordbutterfly');
ok('a trailing slash on the origin is not doubled', creatorPageUrl('https://lumensocial.net/', 'hive:gtg') === 'https://lumensocial.net/m/gtg');
ok('legacy path for the redirect test', legacyCreatorPagePath('hive:gtg') === '/creators/gtg');
ok('a hostile handle cannot break out of the path', !creatorPagePath('../../x').includes('/../') && creatorPagePath('a/b?c') === '/m/a%2Fb%3Fc');

console.log('\nloginThenReturnTo');
ok('the login page gets the deep link, encoded once', loginThenReturnTo(creatorPagePath('lordbutterfly', 'buy')) === '/login?next=%2Fm%2Flordbutterfly%3Fa%3Dbuy');
ok('a spend link keeps its offering id through the round trip', decodeURIComponent(loginThenReturnTo(creatorPagePath('gtg', 'spend', 3)).slice('/login?next='.length)) === '/m/gtg?a=spend&o=3');

console.log('\ncreatorCardPath');
ok('price in cents and the drawing revision', creatorCardPath('lordbutterfly', 1.02) === `/api/og/meritum?u=lordbutterfly&v=102&r=${CARD_REVISION}`);
ok('hive: prefix dropped, DID encoded once', creatorCardPath('hive:gtg', 0) === `/api/og/meritum?u=gtg&v=0&r=${CARD_REVISION}` && creatorCardPath('did:pkh:a:b:c', 2).startsWith('/api/og/meritum?u=did%3Apkh%3Aa%3Ab%3Ac&v=200'));
ok('a NaN or negative price is zero, never NaN in a URL', creatorCardPath('x', Number.NaN).includes('&v=0&') && creatorCardPath('x', -3).includes('&v=0&'));

if (failures === 0) {
  console.log(`\nmeritum-creator-handle: ALL ${checks} CHECKS PASSED`);
  process.exit(0);
} else {
  console.error(`\nmeritum-creator-handle: ${failures}/${checks} CHECK(S) FAILED`);
  process.exit(1);
}
