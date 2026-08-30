/**
 * HOW MUCH THE PRICE MOVED, derived from the SAME series the chart draws.
 *
 * ★ WHY THIS EXISTS. The token page showed a price and a chart and nothing that
 * said how far the price had come. The owner's brief for launch (2026-08-27) is
 * that price and its movement are the story: *"people mostly care what the price
 * is. and how much it pumped and that they can see the chart going up or down."*
 * With the reserve/backing figures hidden for launch (../backing-visibility.ts),
 * this is the only other number beside the price.
 *
 * ★★ THE SERIES IS THE ONLY INPUT, ON PURPOSE. No second query, no second data
 * source, and NOT the live headline price as the endpoint. The chart already
 * renders `LiveTokenMarket.chart`; computing the change from anything else would
 * let the number and the picture disagree, and a reader can check one against
 * the other in a glance. Whatever the chart shows rising by a third, this says
 * rose by a third.
 *
 * ★★ THE WINDOW IS THE WHOLE AVAILABLE SERIES, AND IT IS NOT A TIME WINDOW.
 * That is forced by the data, not chosen for convenience:
 *
 *   - `HasuraPricePoint` is `{ block, supplyAfter, side, delta }`. The client
 *     fetches no timestamp. ★ CORRECTED 2026-08-30: this used to assert "there
 *     is no timestamp anywhere in the row", and that was wrong about the VIEW —
 *     `lumen_ct_price_history` does publish `ts` (creator_tokens_views.yaml:122,
 *     confirmed by live introspection). Nothing here selects it, so the argument
 *     below is unchanged in force; but the reason is "we do not fetch a clock",
 *     not "no clock exists", and a future time window is a query change rather
 *     than an indexer change.
 *   - `use-live-token-market.ts` passes `historyQuery.data.map((p) => p.priceHbd)`
 *     into the adapter, so by the time the number is computed even the block
 *     height is gone. The array is an ordered list of TRADES, not samples on a
 *     clock.
 *   - A "24h" or "7d" window would therefore have to be reconstructed from block
 *     heights at three seconds a block, and would then be EMPTY for almost every
 *     market on this platform at launch: a market that traded eight times last
 *     month has a real, interesting price history and no trades at all in the
 *     last day. "No change" is the wrong thing to say about it, and "+0%" is
 *     worse.
 *
 * So the statement is "how much it moved across the trades we have", and the
 * label SAYS that. A bare "+12%" is unfalsifiable; "+12% over 8 trades" can be
 * checked against the chart caption directly under it, which counts the same
 * points.
 *
 * ★★ AND IT IS NOT SENTIMENT, AND NOT VOLUME. This is a bonding curve: price is
 * a pure function of supply (`../lib/contract-math.ts`), so a price move means
 * SUPPLY moved, full stop. There is no order book, no last-traded quote and no
 * market opinion in this number. "over 8 trades" counts the recorded trades the
 * series spans; it deliberately does not say "in the last week", does not say
 * "volume", and the chart's own caption one line below repeats that the price is
 * set by the curve. Do not reword this to anything that implies demand,
 * momentum or interest.
 *
 * ★ THAT LIMIT IS NOW FIXED (2026-08-28), and this note is kept as the record.
 * `MagiIndexerClient.priceHistoryOf` used to query `order_by: {block: asc},
 * limit: 200`, which takes the OLDEST 200 rows — so a market past 200 trades
 * charted ancient history, its last plotted point stopped being the current
 * price, and this figure inherited the same staleness. It failed exactly when a
 * creator succeeded, and it failed quietly: a full-looking chart of real points,
 * none of them recent. `hasura.ts` now queries `desc` and reverses, so the
 * newest 200 arrive in oldest -> newest order. This function is unchanged; it
 * simply now reads a series whose last element is really the latest trade.
 */

import { pctMoveLabel } from './format';

export interface PriceChange {
  /**
   * Signed percent from the first point in the series to the last. One decimal
   * of precision is all the label prints, but the raw value is kept unrounded so
   * `pctMoveLabel` can tell a real sub-0.1% move from a genuine zero.
   */
  pct: number;
  /**
   * How many recorded TRADES the series spans — the basis the label must state.
   *
   * ★ It can be 1 (2026-08-30). It used to be the point count, which was always
   * >= 2 because the series was nothing but trades. The series now also carries
   * the market's opening supply, so a market that has traded once has two
   * points and ONE trade, and this says one.
   */
  trades: number;
  /** 'flat' ONLY for an exactly equal first and last. A move too small to print is still a move. */
  direction: 'up' | 'down' | 'flat';
}

/**
 * The series -> the change, or NULL when there is no honest change to state.
 *
 * ★ THE NULL CASES ARE THE POINT. Each one is a place where something would
 * otherwise be asserted about someone's money on no evidence:
 *
 *     null / undefined series  the history read failed. Absence, not stability.
 *     fewer than 2 points      a change needs something to change FROM. This is
 *                              the same bound `live/adapt.ts` puts on the chart
 *                              itself, deliberately: a market that has traded
 *                              once has a price, not a trajectory, and the two
 *                              must appear and disappear together or the page
 *                              shows a percentage beside an empty chart slot.
 *     any non-finite point     an unreadable series cannot produce a readable
 *                              change; NaN would propagate into the label.
 *     first point <= 0         there is no base to divide by. Reachable, not
 *                              theoretical: the curve returns 0 at supply 0 (see
 *                              price-chart-geometry.ts's note), so a market
 *                              emptied by a sell records a genuine zero, and
 *                              "up 400% from nothing" is a fabrication.
 */
export function priceChangeOf(series: readonly number[] | null | undefined, tradeCount?: number | null): PriceChange | null {
  if (!series || series.length < 2) return null;
  if (!series.every((p) => Number.isFinite(p))) return null;
  const first = series[0];
  const last = series[series.length - 1];
  if (!(first > 0)) return null;
  const pct = ((last - first) / first) * 100;
  if (!Number.isFinite(pct)) return null;
  return {
    pct,
    // ★★ THE BASIS IS A TRADE COUNT, AND SINCE 2026-08-30 THE SERIES CAN CARRY
    // A POINT THAT IS NOT A TRADE. `readPriceHistory` now prepends the market's
    // OPENING supply — recovered from the oldest row's signed `delta`, which is
    // what gives a one-trade market a chart at all (see its own note). That
    // point is a real price at a real moment and belongs on the line; it is not
    // a trade, and counting it would make this label say "2 trades" about a
    // market that traded once. So the count is passed IN by whoever knows which
    // points are trades, and `series.length` is only the fallback for a caller
    // with no opening point to exclude.
    //
    // Deliberately NOT clamped up to 2: a market with one trade and an opening
    // point states "over 1 trade" — see `priceChangeLabel`, which now says
    // "trade"/"trades" correctly. Claiming two would be the exact off-by-one
    // this parameter exists to remove.
    trades: typeof tradeCount === 'number' && Number.isFinite(tradeCount) && tradeCount > 0 ? Math.floor(tradeCount) : series.length,
    direction: last > first ? 'up' : last < first ? 'down' : 'flat'
  };
}

export interface PriceChangeLabel {
  /** The glyph, or '' when flat. `aria-hidden` at the call site: a screen reader must not read "black up-pointing triangle". */
  mark: string;
  /** What a sighted reader sees beside the mark. */
  text: string;
  /** The accessible name for the whole indicator, since the mark carries meaning no assistive technology can reach. */
  aria: string;
  direction: PriceChange['direction'];
}

/**
 * The change -> exactly what gets rendered, or NULL when nothing should be.
 *
 * ★ COLOUR IS NEVER THE ONLY SIGNAL. Up and down each carry a glyph, and the
 * flat case carries a WORD rather than a "0%" with a neutral colour, so the
 * indicator survives greyscale, print, and every form of colour blindness. The
 * caller adds colour on top of this, not instead of it.
 *
 * ★ AND FLAT IS NOT "▲ 0%". The page rendered exactly that before this module:
 * `changePctWeek >= 0 ? '▲' : '▼'` put an UP arrow on a market that had not
 * moved. An arrow is a claim about direction; there is no direction here.
 */
export function priceChangeLabel(change: PriceChange | null): PriceChangeLabel | null {
  if (!change) return null;
  const magnitude = pctMoveLabel(change.pct);
  if (magnitude === null) return null;
  // ★ SINGULAR IS NOT COSMETIC HERE (2026-08-30). `trades` can now be 1 (see
  // the field's own note), and "over 1 trades" beside a real price move is the
  // kind of sentence that makes a reader distrust the number next to it.
  const noun = change.trades === 1 ? 'trade' : 'trades';
  const basis = `over ${change.trades} ${noun}`;
  const spanned = `the ${change.trades} recorded ${noun} in this market`;
  if (change.direction === 'flat') {
    return { mark: '', text: `Unchanged ${basis}`, aria: `Price unchanged across ${spanned}.`, direction: 'flat' };
  }
  const word = change.direction === 'up' ? 'up' : 'down';
  return {
    mark: change.direction === 'up' ? '▲' : '▼',
    text: `${magnitude} ${basis}`,
    aria: `Price ${word} ${magnitude} across ${spanned}.`,
    direction: change.direction
  };
}
