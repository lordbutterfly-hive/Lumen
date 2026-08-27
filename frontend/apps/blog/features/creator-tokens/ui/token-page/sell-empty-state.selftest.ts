/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * THE SELL/REDEEM DIALOG'S ZERO-BALANCE STATE.
 *
 * Run:
 *   cd apps/blog && npx tsx features/creator-tokens/ui/token-page/sell-empty-state.selftest.ts
 *
 * WHAT THIS PROVES, AND WHY IT WOULD HAVE CAUGHT THE DEFECT.
 *
 * Clicking Sell while holding nothing opened the full trading form against a
 * zero balance. Reproduced live on 2026-08-27 against the deployed testnet
 * contract, signed in, on /creators/did%3Apkh%3Aeip155%3A1%3A0xB41f…980B — the
 * dialog's own text read:
 *
 *   "Amount (tokens) / Sell all (0.00) / Curve proceeds $0.00 /
 *    Trade fee (10%) −$0.00 / You receive $0.00 / Sell — get ~$0.00"
 *
 * with nothing anywhere saying the viewer holds none of this token. Every
 * number was arithmetically correct and the screen as a whole was false.
 *
 * ★ AND THE SECOND, SUBTLER ASSERTION IS THE ONE THAT MATTERS MOST. The obvious
 * fix — "you hold none of this token" — is a LIE when the balance simply failed
 * to read. `readHolderPosition` rejects on a genuine read failure precisely so
 * a zero is never mistaken for a fact, and the hook then flattened that
 * rejection into the same `null` an empty balance produces. Section 2 locks the
 * distinction: reversing the two branches in `sellEmptyStateMessage`
 * reintroduces exactly the defect, and this file fails.
 */

import { sellEmptyStateMessage } from './sell-empty-state';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

// The market reproduced against: a wallet-DID creator, cap 30, supply 0.
const HANDLE = 'did:pkh:eip155:1:0xB41fEE7B3a034a474ae8E0C41DA8B211b73A980B';
const HIVE_HANDLE = 'hive:lumen.beat';

// ── 1. THE DEFECT. A zero balance must produce a sentence, not a form.
//       Fails on the pre-fix code: there was no empty state at all.
{
  const msg = sellEmptyStateMessage({ held: 0, redeem: false, positionUnavailable: false, handle: HANDLE });
  check('zero balance produces an explanation', msg !== null);
  check('…which says the viewer holds none of this token', (msg ?? '').includes('don’t hold any'));
  check(
    '…and names the token, shortened the way the rest of the page names a wallet DID',
    (msg ?? '').includes('@0xB41f…980B'),
    `got: ${msg}`
  );
  check('…and never renders a zero figure as if it were a price', !(msg ?? '').includes('0.00'));
}
check(
  'a hive handle is named without its did prefix',
  (sellEmptyStateMessage({ held: 0, redeem: false, positionUnavailable: false, handle: HIVE_HANDLE }) ?? '').includes(
    '@lumen.beat'
  )
);

// ── 2. ★ THE UNAVAILABLE/EMPTY DISTINCTION. This is the assertion that stops a
//       future edit from telling someone their money is gone during an outage.
{
  const unavailable = sellEmptyStateMessage({ held: 0, redeem: false, positionUnavailable: true, handle: HANDLE });
  check('an unreadable balance still produces an explanation', unavailable !== null);
  check(
    '…and it does NOT claim the viewer holds nothing',
    !(unavailable ?? '').includes('don’t hold any'),
    `got: ${unavailable}`
  );
  check('…it says the balance could not be read', (unavailable ?? '').includes('can’t read your balance'));
  check('…and reassures that the tokens themselves are fine', (unavailable ?? '').includes('safe on-chain'));
  check(
    '…and the two cases produce genuinely different sentences',
    unavailable !== sellEmptyStateMessage({ held: 0, redeem: false, positionUnavailable: false, handle: HANDLE })
  );
}
check(
  'unavailable takes precedence in redeem mode too',
  !(sellEmptyStateMessage({ held: 0, redeem: true, positionUnavailable: true, handle: HANDLE }) ?? '').includes(
    'don’t hold any'
  )
);

// ── 3. THE TWO RAILS SAY THE RIGHT WORD. Sell walks the curve; redeem is the
//       pro-rata wind-down exit, and telling a holder to "buy some first" on a
//       market that is closing would be advice they cannot act on.
{
  const sell = sellEmptyStateMessage({ held: 0, redeem: false, positionUnavailable: false, handle: HANDLE }) ?? '';
  const redeem = sellEmptyStateMessage({ held: 0, redeem: true, positionUnavailable: false, handle: HANDLE }) ?? '';
  check('sell mode says "nothing to sell"', sell.includes('nothing to sell'));
  check('redeem mode says "nothing to redeem"', redeem.includes('nothing to redeem'));
  check('sell mode points at buying in', sell.includes('Buy some first'));
  check(
    'redeem mode does NOT tell a holder to buy into a market that is winding down',
    !redeem.includes('Buy some first'),
    `got: ${redeem}`
  );
}

// ── 4. A REAL BALANCE MUST STILL REACH THE TRADING FORM. A guard that swallows
//       the working case is worse than the bug it replaces.
check(
  'a positive balance renders no empty state',
  sellEmptyStateMessage({ held: 50, redeem: false, positionUnavailable: false, handle: HIVE_HANDLE }) === null
);
check(
  'even a fractional-looking balance of 1 reaches the form',
  sellEmptyStateMessage({ held: 1, redeem: false, positionUnavailable: false, handle: HIVE_HANDLE }) === null
);
check(
  '★ a HELD balance is shown the form even if the position read errored — the tokens are known',
  sellEmptyStateMessage({ held: 50, redeem: false, positionUnavailable: true, handle: HIVE_HANDLE }) === null,
  'held > 0 is decided first; the unavailable flag must not hide a balance we actually have'
);

// ── 5. DEGENERATE BALANCES ARE THE EMPTY CASE, NOT THE FORM.
for (const held of [0, -1, Number.NaN]) {
  check(
    `held = ${held} is treated as empty`,
    sellEmptyStateMessage({ held, redeem: false, positionUnavailable: false, handle: HANDLE }) !== null
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
