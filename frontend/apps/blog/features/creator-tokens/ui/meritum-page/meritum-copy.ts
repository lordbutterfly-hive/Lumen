/**
 * Every string on `/m/<handle>` that is not a number or a name. Staged copy,
 * same precedent as the rest of this feature (TODO i18n). The right-rail
 * cards and every sentence that makes a money claim are NOT here: they are
 * imported verbatim from `../token-page/disclosure-copy.ts`, the module every
 * Meritum surface shares, so this page cannot say something different about
 * the same market (owner, 2026-09-15: "the text on right side navbar is kept").
 */
export const MERITUM_PAGE_COPY = {
  eyebrow: 'Meritum',
  back: '← All creators',
  buy: 'Buy Meritum',
  sell: 'Sell',
  redeem: 'Redeem',
  share: 'Share',
  message: 'Message',
  soldOut: 'Sold out',
  curveNote: 'Price is set by the curve, not by a last traded quote.',
  noHistory: 'A chart appears as soon as this market has traded.',
  historyUnavailable: 'Price history unavailable just now. The price above is live from the curve.',
  stats: { price: 'Price', marketCap: 'Market cap', issued: 'Tokens issued', holders: 'Holders', firstTrade: 'First trade' },
  asksTitle: 'What you can buy',
  asksSub: 'Priced in dollars, paid in Meritum',
  request: 'Request',
  rollingOut: 'Rolling out',
  notPriceable: 'Not priceable yet',
  windingDown: 'Winding down',
  tokenCostUnavailable: 'token cost unavailable',
  deliveryTitle: 'Delivery record',
  deliverySub: 'Every paid ask, settled',
  deliveryEmpty: 'A delivery record builds here once this creator completes their first paid ask.',
  deliveryUnavailable: 'Delivery record unavailable',
  holdersTitle: 'Holders',
  yourPosition: 'Your position',
  send: 'Send',
  shareTitle: (handle: string) => `Share @${handle}`,
  shareHint: 'The card people see when this link is pasted anywhere.',
  cardGenerating: 'Generating your card',
  cardGeneratingHint: 'It is drawn fresh with the live price. A few seconds the first time.',
  cardFailed: 'The card could not be generated just now. The link still works.',
  copy: 'Copy',
  copied: 'Copied',
  nativeShare: 'Share…',
  close: 'Close',
  shareThisPage: 'Share this page',
  signInToTrade: 'Sign in to trade this token.',
  /**
   * 1.1-1.3: what the reader sees once `live.ask` has RESOLVED. The modal's
   * own "Confirming…" state ends at chain execution, so by the time this
   * renders the escrow is already written (core/ask.go Ask) and there is no
   * second wallet step left — the old flow simply closed the dialog and left
   * the reader with no evidence anything had happened.
   *
   * Shared with the legacy token page (../token-page/token-market-view.tsx)
   * for the same reason every money sentence lives in disclosure-copy.ts: two
   * surfaces describing one escrow must not describe it differently.
   */
  askPlacedTitle: 'Request placed',
  askPlacedBody: (handle: string) =>
    `Your request to @${handle} is placed and waiting for their answer. There is nothing more to do in your wallet: the tokens are already held in escrow.`,
  askPlacedDue: (handle: string, due: string) => `@${handle} has until ${due} to answer.`,
  askPlacedTrack: 'Track it in your Inbox → Asks',
  askPlacedTrackHref: '/inbox?view=asks',
  askPlacedDismiss: 'Dismiss'
} as const;
