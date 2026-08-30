import type { QuoteOracleStatus } from '../types';

/**
 * WHAT WE TELL PEOPLE WHEN A SERVICE CANNOT BE PRICED (2026-08-30, clauderfly-43).
 *
 * ★★★ WHY THIS EXISTS AT ALL. A service is priced from the token's own trading
 * history (`core/settlement.go` SettlementRate = min(short TWAP, long TWAP, spot)),
 * and that derivation REFUSES rather than guessing when the history will not carry
 * it. Measured on the live testnet contract on 2026-08-30, **13 of 13 registered
 * markets could not price a service** — twelve for want of observations, one
 * because its newest trade was too old. Neither surface said so.
 *
 * The creator was invited to name and price three services on a shop nobody could
 * buy from. The buyer got a live-looking price, a Request button and a signature
 * prompt, and the refusal arrived only after the click
 * (`vsc-data-source.ts` ask(), which reads the quote and throws
 * "unable to price this ask (<status>)"). No money was ever at risk — that guard
 * is real and fires before any broadcast — but being told after you act is the
 * part being fixed.
 *
 * ★★ ONE SENTENCE PER REASON, NOT ONE SENTENCE. The first draft of this copy said
 * "your token needs about two days of trading before a service can be priced" for
 * every refusal, and that is FALSE for one of them: `stale` is a history that is
 * too OLD, the opposite complaint to a history that is too THIN. A single line
 * cannot carry both without lying to somebody, so the caller passes the real
 * `oracleStatus` the quote returned and the reason it gets back matches the reason
 * the chain would give.
 *
 * ★★ NO PROMISE ABOUT WHEN. Not one of these says when it clears, because none of
 * it depends on anything the creator or the buyer controls — it clears when other
 * people trade the token, and nobody can commit to that on their behalf.
 *
 * ★ ONE PLACE, TWO AUDIENCES. The Creator Studio's Offerings tab and the buyer's
 * Ask dialog describe the same chain refusal from opposite sides, and this
 * codebase has repeatedly been bitten by the same fact drifting between two
 * surfaces that each own their own wording. Both `satisfies` the full
 * `QuoteOracleStatus` union, so a status added to the contract cannot be
 * forgotten here: the build fails instead.
 *
 * Deliberately plain: no "oracle", no "TWAP", no "settlement rate". The reader is
 * a creator or a fan, and the words that matter to them are trading, recent and
 * enough.
 */

/** The Studio's Offerings tab, addressed to the creator about their own shop. */
const CREATOR_NOTICE = {
  ok: null,
  insufficient_observations:
    'Nobody can buy these yet. A service price is worked out from your token’s own trading history, and your market hasn’t traded enough times yet. Your prices are saved either way.',
  insufficient_span:
    'Nobody can buy these yet. A service price is worked out from your token’s own trading history, and your market’s trades are bunched into too short a stretch of time to price against. Your prices are saved either way.',
  stale:
    'Nobody can buy these right now. A service price is worked out from your token’s recent trading, and your market hasn’t traded recently enough. Your prices are saved either way.',
  deviation_capped:
    'Nobody can buy these right now. Your token’s price has moved too far too fast for a service to be priced against it. Your prices are saved either way.',
  unavailable: 'We couldn’t check whether your services can be bought just now.',
  // H2 (2026-08-31): a chain fact about their OWN market, not our read failing.
  no_price_set: 'Set a price first. You haven’t posted a price for your token yet, so there’s nothing to work a service price out from.',
  // H1 (2026-08-31): settleSpend's guards, in the creator's own terms. The
  // legal price window moves as your token trades, so a price can drift out of it.
  market_too_small:
    'Nobody can buy these yet. Your token is too new for any service price to be both above the minimum and within the market’s depth — it settles once a few tokens are held. Your prices are saved.',
  price_below_floor:
    'This price is too low to settle right now. The smallest a service can cost rises with your token’s price; raise it into the current range (the Studio shows the window). Your prices are saved.',
  price_above_ceiling:
    'This price is too high to settle right now. A single service can’t be worth more than half your market’s backing; lower it into the current range (the Studio shows the window). Your prices are saved.',
  spend_cap:
    'This price is too high to settle right now. One purchase can’t move more than 5% of your token’s supply; lower it, or it settles once more tokens are held. Your prices are saved.'
} satisfies Record<QuoteOracleStatus, string | null>;

/** The Ask dialog, addressed to the buyer about somebody else's shop. */
const BUYER_NOTICE = {
  ok: null,
  insufficient_observations:
    'can’t be bought yet. The price comes from the token’s own trading history, and this market hasn’t traded enough times yet.',
  insufficient_span:
    'can’t be bought yet. The price comes from the token’s own trading history, and this market’s trades are bunched into too short a stretch of time to price against.',
  stale:
    'can’t be bought right now. The price comes from the token’s recent trading, and this token hasn’t traded recently enough.',
  deviation_capped:
    'can’t be bought right now. The token’s price has moved too far too fast to price a service against it.',
  unavailable: 'couldn’t be priced just now.',
  no_price_set: 'hasn’t been priced yet — this creator hasn’t set a price for their token.',
  market_too_small: 'can’t be bought yet — this token is too new to price a service against it.',
  price_below_floor: 'can’t be bought right now — the posted price is below what the market can settle. Check back after it trades more.',
  price_above_ceiling: 'can’t be bought right now — the posted price is above what the market can settle. Check back after it trades more.',
  spend_cap: 'can’t be bought right now — it would move too large a share of the token’s supply in one go.'
} satisfies Record<QuoteOracleStatus, string | null>;

/**
 * What the creator is told on their own Offerings tab, or null when their shop
 * prices normally.
 */
export function creatorOracleNotice(status: QuoteOracleStatus): string | null {
  return CREATOR_NOTICE[status];
}

/**
 * What the buyer is told in the Ask dialog, or null when the service prices
 * normally. `handle` is already display-formatted by the caller — this function
 * never touches identity formatting, so a DID and a Hive name read the same way
 * here as they do everywhere else on the page.
 */
export function buyerOracleNotice(status: QuoteOracleStatus, handle: string): string | null {
  const tail = BUYER_NOTICE[status];
  return tail === null ? null : `@${handle}’s services ${tail}`;
}
