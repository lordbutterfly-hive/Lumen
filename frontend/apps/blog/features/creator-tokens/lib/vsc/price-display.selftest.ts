// The "test file" for the buyer-facing token price.
//
// Same shape as payload-contract.selftest.ts (see its header for why this
// feature has plain exported checkers instead of *.test.ts files: apps/blog
// has no unit-test runner wired at all). Imported for its side effect by
// vsc-data-source.ts, so a regression fails at app startup in development
// rather than only when someone happens to look at a market page.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT THIS EXISTS TO STOP HAPPENING AGAIN (live QA, 2026-08-07)
//
// The token page rendered the headline price of the one deployed testnet
// market as **$0.00**, while a token demonstrably cost 1.007 HBD to buy — and
// the same zero silently propagated into the services shop, advertising a real
// $25 service as "≈ 0.00 tokens". Four independent testers filed it.
//
// The cause was not arithmetic. `spotRateBaseUnits` mirrors curve.go's
// `SpotRate`, which returns 0 at supply 0 ON PURPOSE — it is the TWAP/settlement
// ORACLE feed, and curve.go's own comment says an empty market must record "no
// observation rather than a synthetic one". The display layer wired that oracle
// straight to the price above the Buy button. The mirror was right; the screen
// asked it the wrong question.
//
// So the invariant worth pinning is NOT "price != 0". It is the stronger,
// self-evidently correct one:
//
//     THE PRICE SHOWN IS THE PRICE CHARGED.
//
// If those two ever diverge again — whichever way — this fails.
// ─────────────────────────────────────────────────────────────────────────

import { buyCostBaseUnits, displayPricePerTokenBaseUnits, spotRateBaseUnits } from '../contract-math';

/** Supplies worth checking: the empty market that broke, and a spread of live ones. */
const SUPPLIES = [0, 1, 2, 10, 100, 1_000, 10_000];

export function runPriceDisplaySelfTest(): void {
  const failures: string[] = [];

  for (const supply of SUPPLIES) {
    const shown = displayPricePerTokenBaseUnits(supply);
    const charged = buyCostBaseUnits(supply, 1);

    // THE invariant. A price rendered next to a Buy button must be what that
    // button will actually cost, at every supply, with no exceptions.
    if (shown !== charged) {
      failures.push(`supply ${supply}: price shown ${shown} != cost of one token ${charged}`);
    }

    // A live market always has a positive price. Zero is never a real answer
    // here — it is what the oracle returns for "no data", and rendering it as
    // a price is the original defect.
    if (shown <= 0) {
      failures.push(`supply ${supply}: price shown as ${shown}; a token is never free`);
    }
  }

  // Pin the exact regression case, so a future "simplification" back to the
  // oracle feed cannot pass by accident.
  if (spotRateBaseUnits(0) !== 0) {
    failures.push('spotRateBaseUnits(0) should stay 0 — it is the oracle feed, and curve.go relies on that');
  }
  if (displayPricePerTokenBaseUnits(0) === spotRateBaseUnits(0)) {
    failures.push('the display price has been wired back to the oracle rate; an empty market will render as $0.00 again');
  }

  if (failures.length > 0) {
    throw new Error(`creator-tokens price-display self-test FAILED:\n- ${failures.join('\n- ')}`);
  }
}

if (process.env.NODE_ENV !== 'production') {
  runPriceDisplaySelfTest();
}
