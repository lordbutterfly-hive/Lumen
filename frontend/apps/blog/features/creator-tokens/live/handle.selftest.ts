/**
 * `routeHandle` vs `displayHandle` — the two must never be swapped.
 *
 * Run: `npx tsx features/creator-tokens/live/handle.selftest.ts` from apps/blog.
 *
 * A wallet creator's account id is 68 characters. Put the display form in an
 * href and the link 404s; put the route form in a label and the discovery page
 * renders one card four times wider than the rest. Both were real: the raw DID
 * shipped as a label on 2026-08-20 and looked like this next to @lumen.aria —
 *   @did:pkh:eip155:1:0xB41fEE7B3a034a474ae8E0C41DA8B211b73A980B
 */

import { displayHandle, routeHandle } from './adapt';

const DID = 'did:pkh:eip155:1:0xB41fEE7B3a034a474ae8E0C41DA8B211b73A980B';
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

// Hive: both forms agree, which is why one function used to be enough.
check('hive: is stripped for the route', routeHandle('hive:lumen.aria') === 'lumen.aria', routeHandle('hive:lumen.aria'));
check('hive: is stripped for display', displayHandle('hive:lumen.aria') === 'lumen.aria');

// Wallet: they must NOT agree.
check('the route keeps the DID whole so it resolves', routeHandle(DID) === DID, routeHandle(DID));
check('the label shortens the address', displayHandle(DID) === '0xB41f…980B', displayHandle(DID));
check('the label is short enough to sit beside a handle', displayHandle(DID).length <= 12, String(displayHandle(DID).length));
check('the label is NOT the route form', displayHandle(DID) !== routeHandle(DID));
// ★ The failure that actually shipped: the label leaking the scheme prefix.
check('the label never contains "did:pkh"', !displayHandle(DID).includes('did:pkh'), displayHandle(DID));

// BTC DIDs use a different chain segment and must shorten the same way.
const BTC = 'did:pkh:bip122:000000000019d6689c085ae165831e93:bc1qygrj39a8nyzwuq6ejrglhay9thma8hegsez3p4';
check('a BTC DID also shortens', displayHandle(BTC) === 'bc1qyg…z3p4', displayHandle(BTC));
check('a BTC route stays whole', routeHandle(BTC) === BTC);

// Degenerate input must not throw or invent a handle.
check('empty is empty', displayHandle('') === '' && routeHandle('') === '');
check('null is empty', displayHandle(null) === '' && routeHandle(undefined) === '');
// A malformed DID is left alone rather than mangled.
check('a non-DID string passes through', displayHandle('lumen.aria') === 'lumen.aria');
check('a short address is not "shortened" into something longer', displayHandle('did:pkh:eip155:1:0xAB') === '0xAB', displayHandle('did:pkh:eip155:1:0xAB'));

if (failures.length > 0) {
  console.error(`handle self-test FAILED:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('handle self-test: all checks passed');
