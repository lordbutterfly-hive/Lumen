/**
 * WHAT THE SELL/REDEEM DIALOG SAYS WHEN THERE IS NOTHING TO SELL.
 *
 * ★★★ THE DIALOG USED TO SAY NOTHING AT ALL (2026-08-27, reproduced live on the
 * 30-cap testnet market while signed in as an account holding none of it). It
 * rendered its whole trading form against a zero balance: "Sell all (0.00)", a
 * curve breakdown reading $0.00 on every row, a pre-filled minimum-net floor of
 * nothing, and a "Sell — get ~$0.00" call to action. Every figure was
 * arithmetically correct and the screen as a whole made a false claim: that
 * there is a sell here to be made. A reader cannot tell that from a market that
 * has broken.
 *
 * ★★★ AND THE OBVIOUS FIX IS A TRAP. "You hold none of this token" is only true
 * if the balance was actually READ. `readHolderPosition` REJECTS on a genuine
 * read failure precisely so a zero can never be mistaken for a fact (see its
 * doc in lib/creator-tokens-data-source.ts) — and `use-live-token-market.ts`
 * then flattened the rejection into the same `null` an empty balance produces.
 * So `m.position === null` means "holds nothing" OR "we could not look", and a
 * dialog that picks the first reading tells someone their money is gone during
 * an outage. `positionUnavailable` was added to the hook to carry the
 * distinction; this function is where it decides the sentence.
 *
 * Extracted rather than written inline for the reason
 * `market/curve.selftest.ts`'s header sets out: token-modals.tsx is a
 * `'use client'` component tree, so a rule kept inside it is a rule no test can
 * reach. This module imports nothing but `displayHandle`, which is pure.
 */

import { displayHandle } from '../../live/adapt';

export interface SellEmptyStateInput {
  /** Whole tokens the viewer holds. Zero or less is the empty case. */
  held: number;
  /** The wind-down rail (refund.go) rather than the curve (sell.go). */
  redeem: boolean;
  /**
   * The balance READ failed. Takes precedence over everything: we do not know
   * the balance, so no sentence may assert one.
   */
  positionUnavailable: boolean;
  /** The market's creator, as stored (`hive:alice` or a wallet DID). */
  handle: string;
}

/**
 * The sentence to show instead of the trading form, or `null` when there IS a
 * balance and the form should render as normal.
 *
 * ★ ORDER MATTERS AND IS THE WHOLE POINT. `positionUnavailable` is checked
 * FIRST, so an unreadable balance can never fall through to a sentence that
 * claims the holder owns nothing. Reversing these two lines reintroduces
 * exactly the defect this exists to prevent.
 */
export function sellEmptyStateMessage(input: SellEmptyStateInput): string | null {
  if (input.held > 0) return null;
  if (input.positionUnavailable) {
    // ★ HOUSE STYLE (2026-08-27, same day this sentence was written): no em or
    // en dashes in prose published under the owner's name. Split into two
    // sentences rather than swapped for a hyphen, which would have left
    // "safe on-chain - try again" reading as a mangled clause.
    return 'We can’t read your balance of this token right now. Your tokens are safe on-chain. Try again in a moment.';
  }
  const at = `@${displayHandle(input.handle)}`;
  return input.redeem
    ? `You don’t hold any ${at} token, so there’s nothing to redeem.`
    : `You don’t hold any ${at} token, so there’s nothing to sell. Buy some first and they’ll show up here.`;
}
